/**
 * Surface wake wiring: the orchestrator's event subscription to the surface —
 * the shared runtime where placed workers run in the open, per the fleet's
 * orchestrator doctrine. The orchestrator itself drives the surface through
 * its CLI (placing, steering, reading workers); this module only listens and
 * wakes, mirroring the worker-report channel: a placed worker that blocks on
 * an approval or question, finishes unseen, or leaves the surface becomes a
 * `<surface_report>` turn on the orchestrator's thread.
 *
 * herdr is the reference implementation of the surface. Its server pushes
 * newline-delimited JSON events over a unix socket (`events.subscribe`), and
 * one-shot calls are one request per connection. Correlation is by pane
 * metadata token: the doctrine has the orchestrator tag each placed worker's
 * pane (`herdr pane report-metadata --token <key>=<name>`), and only tagged
 * panes wake. Events missed while disconnected are gone (herdr keeps a small
 * ring, replays nothing), so every (re)connect reconciles against
 * `agent.list` before trusting the stream — the same read-state-on-attach
 * posture the app-server attachment uses.
 *
 * Status semantics (herdr's five agent states): `blocked` is an approval or
 * question UI; `done` is finished background work nobody has looked at —
 * exactly the wake conditions. `idle` means a human saw it, `working` is
 * progress, and `unknown` is a classification gap that proves nothing, so
 * none of those three wake, and `unknown` does not even update the tracked
 * state (screen-detection flaps must not re-arm a wake).
 */

export type SurfaceWakeStatus = "blocked" | "done" | "gone";

export interface SurfaceWake {
  /** The worker's speakable handle: the pane token's value. */
  worker: string;
  status: SurfaceWakeStatus;
  /** One line of context for the report body. */
  detail: string;
}

export interface SurfaceEffects {
  /** Start the report turn on the orchestrator's thread; never awaited. */
  reportToOrchestrator(text: string): void;
  /** One-line notices for the event feed. */
  onStatus(line: string): void;
  debug?(line: string): void;
}

/** The five herdr agent states; anything unrecognized is treated as unknown. */
type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

interface TrackedWorker {
  worker: string;
  status: AgentStatus;
  title: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStatus(value: unknown): AgentStatus {
  return value === "idle" || value === "working" || value === "blocked" || value === "done"
    ? value
    : "unknown";
}

/** Attribute-safe worker handle for the report tag. */
function attrSafe(value: string): string {
  return value.replace(/[<>"&]/g, "_");
}

function describeWorker(worker: TrackedWorker): string {
  return worker.title ? `"${worker.title}"` : "its run";
}

/**
 * Pure wake computation over surface events: which token-tagged panes exist,
 * what state each was last seen in, and which transitions wake. Socket-free so
 * the transition rules are testable; the adapter below owns the wire.
 */
export class SurfaceTracker {
  private readonly tokenKey: string;
  private readonly panes = new Map<string, TrackedWorker>();

  constructor(tokenKey: string) {
    this.tokenKey = tokenKey;
  }

  /** One pushed event envelope (`{event, data}`) → wakes. */
  handleEvent(event: string, data: Record<string, unknown>): SurfaceWake[] {
    switch (event) {
      case "pane_updated":
      case "pane_created": {
        const pane = asRecord(data["pane"]);
        return pane ? this.observePane(pane) : [];
      }
      case "pane_exited":
      case "pane_closed":
        return this.observeGone(data, "its pane closed");
      case "pane_agent_detected": {
        if (data["released"] !== true) return [];
        const final = typeof data["final_status"] === "string" ? data["final_status"] : null;
        return this.observeGone(
          data,
          final ? `its agent exited (last seen ${final})` : "its agent exited",
        );
      }
      default:
        return [];
    }
  }

  /**
   * Reconcile against the surface's live agent list (one `agent.list` result).
   * Missed transitions surface here: a tagged agent now blocked or done wakes,
   * and a tracked pane absent from the list is gone.
   */
  reconcile(agents: ReadonlyArray<Record<string, unknown>>): SurfaceWake[] {
    const wakes: SurfaceWake[] = [];
    const seen = new Set<string>();
    for (const agent of agents) {
      const paneId = typeof agent["pane_id"] === "string" ? agent["pane_id"] : null;
      if (!paneId) continue;
      seen.add(paneId);
      wakes.push(...this.observePane(agent));
    }
    for (const [paneId, worker] of [...this.panes]) {
      if (seen.has(paneId)) continue;
      this.panes.delete(paneId);
      wakes.push({
        worker: worker.worker,
        status: "gone",
        detail: `${describeWorker(worker)} left the surface while the console was not watching`,
      });
    }
    return wakes;
  }

  /** Tracked pane count, for status lines. */
  get size(): number {
    return this.panes.size;
  }

  /**
   * A PaneInfo-shaped record (pane events and agent.list rows share the
   * fields that matter: pane_id, agent_status, tokens, title).
   */
  private observePane(pane: Record<string, unknown>): SurfaceWake[] {
    const paneId = typeof pane["pane_id"] === "string" ? pane["pane_id"] : null;
    if (!paneId) return [];
    const tokens = asRecord(pane["tokens"]);
    const name = tokens ? tokens[this.tokenKey] : undefined;
    const tracked = this.panes.get(paneId);

    // Tokens present but our key absent: the pane is not (or no longer) a
    // placed worker. Tokens absent entirely is indistinguishable from an
    // emitter that omitted the field, so an already-tracked pane stays
    // tracked and only its status is read.
    if (typeof name !== "string" || name === "") {
      if (tracked && tokens !== null) this.panes.delete(paneId);
      if (tracked && tokens === null) return this.transition(tracked, pane);
      return [];
    }

    const title = typeof pane["title"] === "string" ? pane["title"] : (tracked?.title ?? null);
    if (!tracked) {
      const status = asStatus(pane["agent_status"]);
      const worker: TrackedWorker = { worker: name, status, title };
      this.panes.set(paneId, worker);
      // First sight of an already-stuck worker is itself a missed transition.
      if (status === "blocked" || status === "done") return [this.wake(worker, status)];
      return [];
    }
    tracked.worker = name;
    tracked.title = title;
    return this.transition(tracked, pane);
  }

  private transition(worker: TrackedWorker, pane: Record<string, unknown>): SurfaceWake[] {
    const next = asStatus(pane["agent_status"]);
    // `unknown` proves nothing and must not re-arm a wake through a
    // blocked → unknown → blocked screen-detection flap.
    if (next === "unknown" || next === worker.status) return [];
    worker.status = next;
    if (next === "blocked" || next === "done") return [this.wake(worker, next)];
    return [];
  }

  private observeGone(data: Record<string, unknown>, why: string): SurfaceWake[] {
    const paneId = typeof data["pane_id"] === "string" ? data["pane_id"] : null;
    if (!paneId) return [];
    const worker = this.panes.get(paneId);
    if (!worker) return [];
    this.panes.delete(paneId);
    return [{ worker: worker.worker, status: "gone", detail: `${describeWorker(worker)}: ${why}` }];
  }

  private wake(worker: TrackedWorker, status: "blocked" | "done"): SurfaceWake {
    return {
      worker: worker.worker,
      status,
      detail:
        status === "blocked"
          ? `${describeWorker(worker)} is blocked on an approval or a question in its pane`
          : `${describeWorker(worker)} finished; the result sits unseen in its pane`,
    };
  }
}

/**
 * The report mirrors `<worker_report>`: machine-parseable envelope, then one
 * guidance line telling the orchestrator what the doctrine expects of this
 * status — a blocked worker is answered, not merely relayed.
 */
export function composeSurfaceReport(wake: SurfaceWake): string {
  const guidance =
    wake.status === "blocked"
      ? "Automated surface report — not the user speaking. Answer it: steer the worker " +
        "(herdr agent prompt) or bring the human to it (herdr agent attach); tell the " +
        "user only what matters to them."
      : wake.status === "done"
        ? "Automated surface report — not the user speaking. Read the outcome " +
          "(herdr agent read) and integrate it; tell the user only what matters to them."
        : "Automated surface report — not the user speaking. Integrate it; tell the " +
          "user only what matters to them.";
  return [
    `<surface_report worker="${attrSafe(wake.worker)}" status="${wake.status}">`,
    wake.detail,
    "</surface_report>",
    guidance,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The herdr adapter — reference implementation of the surface
// ---------------------------------------------------------------------------

const RECONNECT_BACKOFF_INITIAL_MS = 500;
const RECONNECT_BACKOFF_CAP_MS = 30_000;

/** Global kinds only: per-pane kinds cannot follow panes the orchestrator has yet to place. */
const SUBSCRIPTIONS = [
  { type: "pane.created" },
  { type: "pane.updated" },
  { type: "pane.closed" },
  { type: "pane.exited" },
  { type: "pane.agent_detected" },
];

interface HerdrSurfaceOptions {
  socketPath: string;
  tokenKey: string;
  effects: SurfaceEffects;
}

interface BunSocket {
  write(data: string): number;
  end(): void;
}

/**
 * Long-lived `events.subscribe` NDJSON stream plus a one-shot `agent.list`
 * reconcile on every (re)connect. Wakes go out through the effects; the
 * caller owns turning them into orchestrator turns.
 */
export class HerdrSurface {
  private readonly options: HerdrSurfaceOptions;
  private readonly tracker: SurfaceTracker;
  private stream: BunSocket | null = null;
  private buffer = "";
  private failures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private everConnected = false;

  constructor(options: HerdrSurfaceOptions) {
    this.options = options;
    this.tracker = new SurfaceTracker(options.tokenKey);
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stream?.end();
    this.stream = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.buffer = "";
    try {
      const socket = await Bun.connect({
        unix: this.options.socketPath,
        socket: {
          data: (_socket, chunk) => this.handleChunk(chunk),
          close: () => this.handleClosed(),
          error: (_socket, error) => {
            this.options.effects.debug?.(`surface stream error: ${error.message}`);
          },
        },
      });
      this.stream = socket as unknown as BunSocket;
      this.stream.write(
        `${JSON.stringify({
          id: "agentvoice:surface:subscribe",
          method: "events.subscribe",
          params: { subscriptions: SUBSCRIPTIONS },
        })}\n`,
      );
      this.failures = 0;
      if (!this.everConnected) {
        this.everConnected = true;
        this.options.effects.onStatus(`surface events connected (${this.options.socketPath})`);
      } else {
        this.options.effects.onStatus("surface events reconnected");
      }
      await this.reconcile();
    } catch (error) {
      this.handleConnectFailure(error);
    }
  }

  /** Read the live agent list on its own connection; the stream stays dedicated. */
  private async reconcile(): Promise<void> {
    try {
      const result = await this.call("agent.list", {});
      const agents = Array.isArray(result["agents"]) ? result["agents"] : [];
      const rows = agents.map((agent) => asRecord(agent)).filter((row) => row !== null);
      for (const wake of this.tracker.reconcile(rows)) this.publish(wake);
      this.options.effects.debug?.(`surface reconciled: tracking ${this.tracker.size} worker(s)`);
    } catch (error) {
      this.options.effects.debug?.(
        `surface reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private handleChunk(chunk: Uint8Array): void {
    this.buffer += new TextDecoder().decode(chunk);
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (line === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.options.effects.debug?.("surface stream: unparseable line dropped");
        continue;
      }
      const record = asRecord(parsed);
      if (!record) continue;
      // The first line acknowledges the subscription; event lines follow as
      // `{event, data}` envelopes.
      const event = record["event"];
      const data = asRecord(record["data"]);
      if (typeof event !== "string" || !data) continue;
      for (const wake of this.tracker.handleEvent(event, data)) this.publish(wake);
    }
  }

  private publish(wake: SurfaceWake): void {
    this.options.effects.debug?.(`surface wake: ${wake.worker} ${wake.status}`);
    this.options.effects.reportToOrchestrator(composeSurfaceReport(wake));
  }

  private handleClosed(): void {
    if (this.stopped) return;
    this.stream = null;
    this.options.effects.onStatus("surface events disconnected; reconnecting");
    this.scheduleReconnect();
  }

  private handleConnectFailure(error: unknown): void {
    if (this.stopped) return;
    this.stream = null;
    // Quiet after the first report: an absent surface is a degraded mode the
    // status feed announces once, not a drumbeat.
    const detail = error instanceof Error ? error.message : String(error);
    if (this.failures === 0) {
      this.options.effects.onStatus(
        `surface events unavailable (${this.options.socketPath}: ${detail}); retrying quietly`,
      );
    } else {
      this.options.effects.debug?.(`surface connect failed: ${detail}`);
    }
    this.failures++;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_BACKOFF_INITIAL_MS * 2 ** Math.min(this.failures, 10),
      RECONNECT_BACKOFF_CAP_MS,
    );
    const timer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    timer.unref?.();
    this.reconnectTimer = timer;
  }

  /** herdr answers one request per connection; each call opens its own. */
  private call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { socketPath } = this.options;
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      let response = "";
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      Bun.connect({
        unix: socketPath,
        socket: {
          open: (socket) => {
            socket.write(
              `${JSON.stringify({ id: `agentvoice:surface:${method}`, method, params })}\n`,
            );
          },
          data: (socket, chunk) => {
            response += new TextDecoder().decode(chunk);
            const newline = response.indexOf("\n");
            if (newline < 0) return;
            const line = response.slice(0, newline);
            socket.end();
            settle(() => {
              try {
                const parsed = asRecord(JSON.parse(line));
                const error = parsed ? asRecord(parsed["error"]) : null;
                if (error) {
                  rejectPromise(new Error(String(error["message"] ?? "surface call failed")));
                  return;
                }
                const result = parsed ? asRecord(parsed["result"]) : null;
                resolvePromise(result ?? {});
              } catch (parseError) {
                rejectPromise(
                  parseError instanceof Error ? parseError : new Error(String(parseError)),
                );
              }
            });
          },
          close: () => settle(() => rejectPromise(new Error(`${method}: connection closed`))),
          error: (_socket, error) => settle(() => rejectPromise(error)),
        },
      }).catch((error) => settle(() => rejectPromise(error)));
    });
  }
}
