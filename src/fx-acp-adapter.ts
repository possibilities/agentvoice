/**
 * Fx over the Agent Client Protocol: the backend of record. Standard ACP gives
 * one prompt per turn, streamed agent-message chunks, cancellation, and
 * permission requests. In-flight steering and ADE-parity lifecycle arrive with
 * Fx's `acp-voice-control` carry as `_fx/…` extensions; until a server answers
 * them, a second admission during an active turn is queued behind it and
 * reported as such — never claimed as steering.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { resolve } from "node:path";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { fxEnvironment } from "./fx-orchestrator.ts";
import {
  LifecycleEmitter,
  type OrchestratorAdapter,
  type OrchestratorAdmission,
  type OrchestratorAgentState,
  type OrchestratorCapabilities,
  type OrchestratorIdentity,
  type OrchestratorLifecycleListener,
  type OrchestratorTurnOutcome,
  type OrchestratorTurnResult,
} from "./orchestrator-adapter.ts";

const ACP_PROTOCOL_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const TERMINATE_GRACE_MS = 5_000;
const GROUP_TERMINATE_GRACE_MS = 2_000;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const STEER_METHOD = "_fx/session/steer";
const SNAPSHOT_METHOD = "_fx/session/snapshot";
const QUESTION_METHOD = "_fx/session/question";
const LIFECYCLE_UPDATE = "_fx/lifecycle";

const initializeResultSchema = z.object({
  protocolVersion: z.number(),
  agentInfo: z.object({ name: z.string(), version: z.string() }).optional(),
  agentCapabilities: z.record(z.string(), z.unknown()).optional(),
});
const sessionNewResultSchema = z.object({
  sessionId: z.string().min(1),
  configOptions: z
    .array(z.object({ id: z.string(), currentValue: z.unknown().optional() }))
    .optional(),
  modes: z.object({ currentModeId: z.string() }).optional(),
});
const promptResultSchema = z.object({ stopReason: z.string() });
const queueEntrySchema = z.looseObject({
  turn_id: z.string(),
  kind: z.enum(["queued", "steering"]),
  text: z.string(),
});
const childSchema = z.looseObject({
  name: z.string(),
  kind: z.string(),
  phase: z.string(),
});
const snapshotSchema = z.looseObject({
  active_turn_id: z.string().nullable(),
  queue_paused: z.boolean(),
  queue: z.array(queueEntrySchema),
  children: z.array(childSchema).optional(),
});
const steerResultSchema = z.object({
  turnId: z.string(),
  disposition: z.enum(["queued", "steering"]),
  snapshot: snapshotSchema.optional(),
});
const lifecycleUpdateSchema = z.looseObject({
  sessionUpdate: z.literal(LIFECYCLE_UPDATE),
  event: z.string(),
  sequence: z.number().int().positive(),
  turn_id: z.string().nullable(),
  agent_role: z.enum(["main", "subagent"]),
  agent_name: z.string().nullable(),
  agent_state: z.enum(["idle", "working", "blocked"]),
  attention_kind: z.enum(["permission", "question", "route_recovery"]).nullable(),
  outcome: z.enum(["completed", "interrupted", "failed", "paused"]).optional(),
  provider_disposition: z.string().nullable().optional(),
});
const chunkUpdateSchema = z.looseObject({
  turn_id: z.string().optional(),
  content: z.looseObject({ type: z.string(), text: z.string() }),
});
const questionUpdateSchema = z.looseObject({
  questionId: z.string(),
  text: z.string(),
  options: z.array(z.unknown()).optional(),
});
const permissionOptionSchema = z.object({
  optionId: z.string(),
  name: z.string(),
  kind: z.string(),
});
const permissionRequestSchema = z.object({
  sessionId: z.string(),
  toolCall: z.unknown().optional(),
  options: z.array(permissionOptionSchema).min(1),
});
const sessionUpdateSchema = z.object({
  sessionId: z.string(),
  update: z.looseObject({ sessionUpdate: z.string() }),
});
const rpcErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

export type AcpPermissionOption = z.infer<typeof permissionOptionSchema>;
export type AcpPermissionRequest = z.infer<typeof permissionRequestSchema>;
export type AcpSessionUpdate = z.infer<typeof sessionUpdateSchema>;
export type AcpSnapshot = z.infer<typeof snapshotSchema>;
export type AcpQuestion = z.infer<typeof questionUpdateSchema>;
export type AcpPermissionDecision =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export class FxAcpError extends Error {
  constructor(
    message: string,
    readonly code: number | null = null,
  ) {
    super(message);
    this.name = "FxAcpError";
  }
}

export interface FxAcpAdapterOptions {
  workspace: string;
  model: string;
  reasoningEffort: string;
  fxPath?: string;
  /** ACP session mode set right after `session/new`; `code` is Fx's auto-permission mode. */
  sessionMode?: string | null;
  /** Replaces the `fx acp …` command line; tests point this at a fake server. */
  launch?: { command: string; args: string[]; env?: Record<string, string> };
  requestTimeoutMs?: number;
  /** Ask Fx to serve its credential broker on inherited descriptor 3. */
  credentialBroker?: boolean;
  stderrLogPath?: string;
  onPermissionRequest?(request: AcpPermissionRequest): Promise<AcpPermissionDecision>;
  /** Answers a question Fx raised; returning null leaves it unanswered. */
  onQuestion?(question: AcpQuestion): Promise<string | null>;
  onUpdate?(update: AcpSessionUpdate): void;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface TurnWaiter {
  resolve(result: OrchestratorTurnResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface AcpTurn {
  turnId: string;
  /** Fx's own turn id, bound when its `turn_started` arrives. */
  fxTurnId: string | null;
  /**
   * A handle for text steered into somebody else's turn. It exists so the
   * caller has something to await and is never a turn of its own, so it
   * publishes no lifecycle.
   */
  steeringEntry: boolean;
  text: string;
  assistantText: string;
  result: OrchestratorTurnResult | null;
  waiters: TurnWaiter[];
}

/** Picks the least-privileged allow option, so an unattended session keeps moving. */
export function defaultPermissionDecision(request: AcpPermissionRequest): AcpPermissionDecision {
  const preferred = ["allow_once", "allow_always"];
  for (const kind of preferred) {
    const option = request.options.find((candidate) => candidate.kind === kind);
    if (option) return { outcome: "selected", optionId: option.optionId };
  }
  return { outcome: "selected", optionId: request.options[0]!.optionId };
}

export function outcomeFromStopReason(stopReason: string): OrchestratorTurnOutcome {
  switch (stopReason) {
    case "end_turn":
      return "completed";
    case "cancelled":
      return "interrupted";
    default:
      return "failed";
  }
}

export class FxAcpAdapter implements OrchestratorAdapter {
  readonly backend = "fx-acp";
  readonly capabilities: OrchestratorCapabilities = {
    steering: false,
    interrupt: true,
    attention: true,
  };

  private readonly lifecycle = new LifecycleEmitter();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly turns = new Map<string, AcpTurn>();
  private readonly queue: AcpTurn[] = [];
  private child: ChildProcessWithoutNullStreams | null = null;
  private childExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  private credentialBrokerChannel: Duplex | null = null;
  private stderrLog: WriteStream | null = null;
  private stderrTail = "";
  private lineBuffer = "";
  private requestSequence = 0;
  private turnSequence = 0;
  private sessionId: string | null = null;
  private activeTurn: AcpTurn | null = null;
  private pendingAttention = 0;
  private steering: "unknown" | "supported" | "unsupported" = "unknown";
  /** True once Fx advertises `_fx.lifecycle`; its feed then owns turn boundaries. */
  private lifecycleFeed = false;
  private awaitingTurnStart: AcpTurn | null = null;
  /**
   * Fx publishes `turn_ended` before it answers the prompt, so the outcome is
   * known before the session will accept another one. This stays true until
   * the prompt itself settles, which is what actually frees the slot.
   */
  private promptOutstanding = false;
  private startPromise: Promise<OrchestratorIdentity> | null = null;
  private stopPromise: Promise<void> | null = null;
  private ready = false;
  private stopped = false;

  constructor(private readonly options: FxAcpAdapterOptions) {}

  start(): Promise<OrchestratorIdentity> {
    if (this.stopped) throw new Error("cannot restart a stopped Fx ACP adapter");
    this.startPromise ??= this.startOnce();
    return this.startPromise;
  }

  async admit(text: string): Promise<OrchestratorAdmission> {
    this.assertRunning();
    const active = this.activeTurn;
    if (active) {
      const steered = await this.trySteer(text);
      if (steered) {
        return {
          delegationTurnId: steered.delegationTurnId,
          disposition: "steering",
          activeTurnId: steered.activeTurnId,
        };
      }
    }
    if (active || this.promptOutstanding) {
      const turn = this.createTurn(text);
      this.queue.push(turn);
      return {
        delegationTurnId: turn.turnId,
        disposition: "queued",
        activeTurnId: active?.turnId ?? null,
      };
    }
    const turn = this.createTurn(text);
    this.startTurn(turn);
    return { delegationTurnId: turn.turnId, disposition: "queued", activeTurnId: null };
  }

  waitForTurn(turnId: string, timeoutMs: number): Promise<OrchestratorTurnResult> {
    const turn = this.turns.get(turnId);
    if (!turn) return Promise.reject(new Error(`unknown Fx ACP turn ${turnId}`));
    if (turn.result) return Promise.resolve(turn.result);
    if (this.stopped) return Promise.reject(new Error("Fx ACP adapter is not running"));
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        turn.waiters = turn.waiters.filter((waiter) => waiter.timer !== timer);
        reject(new Error(`Fx ACP turn ${turnId} did not end within ${timeoutMs}ms`));
      }, timeoutMs);
      turn.waiters.push({ resolve: resolvePromise, reject, timer });
    });
  }

  async interrupt(): Promise<void> {
    this.assertRunning();
    const active = this.activeTurn;
    if (!active) return;
    const ended = new Promise<void>((resolvePromise) => {
      active.waiters.push({
        resolve: () => resolvePromise(),
        reject: () => resolvePromise(),
        timer: setTimeout(() => {}, 0),
      });
    });
    await this.request("session/cancel", { sessionId: this.sessionId });
    await ended;
  }

  onLifecycle(listener: OrchestratorLifecycleListener): () => void {
    return this.lifecycle.subscribe(listener);
  }

  /** Fx's own view of the active turn, its queue, and its children. */
  async snapshot(): Promise<AcpSnapshot | null> {
    this.assertRunning();
    if (!this.lifecycleFeed && this.steering !== "supported") return null;
    const result = await this.request(SNAPSHOT_METHOD, { sessionId: this.sessionId });
    const parsed = snapshotSchema.safeParse(result);
    return parsed.success ? parsed.data : null;
  }

  /**
   * Transfers the sole endpoint of Fx's credential broker. The caller must
   * keep it opaque and pass it to a schema-3 voice sidecar as descriptor 3.
   */
  acquireCredentialBrokerChannel(): Duplex {
    if (!this.ready || this.stopped) {
      throw new Error("Fx credential broker is unavailable before Fx startup");
    }
    if (!this.options.credentialBroker) {
      throw new Error("Fx credential broker was not enabled for this launch");
    }
    const channel = this.credentialBrokerChannel;
    if (!channel) throw new Error("Fx credential broker channel was already acquired");
    this.credentialBrokerChannel = null;
    channel.pause();
    return channel;
  }

  /** Every lifecycle event so far, for evidence and tests. */
  lifecycleSnapshot() {
    return this.lifecycle.snapshot();
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async startOnce(): Promise<OrchestratorIdentity> {
    // The credential descriptor is a global flag, so it precedes the
    // subcommand; `fx acp --codex-credential-fd` is not valid grammar.
    const brokerArgs = this.options.credentialBroker ? ["--codex-credential-fd", "3"] : [];
    const launch = this.options.launch ?? {
      command: this.options.fxPath ?? "fx",
      args: [
        ...brokerArgs,
        "acp",
        "--model",
        this.options.model,
        "--effort",
        this.options.reasoningEffort,
      ],
    };
    const environment = fxEnvironment({
      model: this.options.model,
      reasoningEffort: this.options.reasoningEffort,
    });
    Object.assign(environment, launch.env ?? {});
    const child = spawn(launch.command, launch.args, {
      cwd: resolve(this.options.workspace),
      env: environment,
      stdio: this.options.credentialBroker
        ? ["pipe", "pipe", "pipe", "pipe"]
        : ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.child = child;
    this.childExit = new Promise((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    });
    if (this.options.stderrLogPath) {
      this.stderrLog = createWriteStream(this.options.stderrLogPath, { flags: "wx", mode: 0o600 });
    }
    if (this.options.credentialBroker) {
      const channel = child.stdio[3];
      if (!isDuplex(channel)) {
        throw new Error("Fx did not expose a parent Duplex for credential descriptor 3");
      }
      channel.pause();
      this.credentialBrokerChannel = channel;
    }
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrLog?.write(chunk);
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    void this.childExit.then(
      ({ code, signal }) => this.onExit(`Fx ACP exited (code ${code}, signal ${signal ?? "none"})`),
      (error) => this.onExit(`Fx ACP failed to start: ${errorMessage(error)}`),
    );

    try {
      const initialized = initializeResultSchema.parse(
        await this.request("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        }),
      );
      if (initialized.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw new FxAcpError(
          `Fx ACP protocol version ${initialized.protocolVersion} is not ${ACP_PROTOCOL_VERSION}`,
        );
      }
      const extension = initialized.agentCapabilities?.["_fx"];
      if (isRecord(extension)) {
        if (extension["steer"] === true) this.markSteering("supported");
        if (typeof extension["lifecycle"] === "number" && extension["lifecycle"] >= 1) {
          this.lifecycleFeed = true;
        }
      }

      const session = sessionNewResultSchema.parse(
        await this.request("session/new", {
          cwd: resolve(this.options.workspace),
          mcpServers: [],
        }),
      );
      this.sessionId = session.sessionId;
      const mode = this.options.sessionMode === undefined ? "code" : this.options.sessionMode;
      if (mode)
        await this.request("session/set_mode", { sessionId: session.sessionId, modeId: mode });

      const configured = new Map(
        (session.configOptions ?? []).map((option) => [option.id, option.currentValue]),
      );
      const identity: OrchestratorIdentity = {
        backend: this.backend,
        version: initialized.agentInfo?.version ?? "unknown",
        buildRevision: null,
        auth: stringOrNull(configured.get("provider")),
        modelSource: stringOrNull(configured.get("provider")),
        permissionMode: mode ?? session.modes?.currentModeId ?? null,
        model: stringOrNull(configured.get("model")) ?? this.options.model,
        reasoningEffort: this.options.reasoningEffort,
      };
      if (identity.model !== this.options.model) {
        throw new FxAcpError(
          `Fx ACP session model ${identity.model} is not the requested ${this.options.model}`,
        );
      }
      this.ready = true;
      this.lifecycle.emit({
        type: "orchestrator.started",
        turnId: null,
        agentState: "idle",
        attentionKind: null,
        data: { sessionId: session.sessionId, identity },
      });
      return identity;
    } catch (error) {
      await this.stop();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private async stopOnce(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.stdin.end();
      } catch {
        // The peer may already be gone.
      }
      const exited = this.childExit ?? Promise.resolve(null);
      const graceful = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolvePromise) =>
          setTimeout(() => resolvePromise(false), TERMINATE_GRACE_MS),
        ),
      ]);
      if (!graceful) {
        signalProcessGroup(child, "SIGTERM");
        const terminated = await Promise.race([
          exited.then(() => true),
          new Promise<false>((resolvePromise) =>
            setTimeout(() => resolvePromise(false), TERMINATE_GRACE_MS),
          ),
        ]);
        if (!terminated) {
          signalProcessGroup(child, "SIGKILL");
          await exited.catch(() => null);
        }
      }
    }
    // Fx may leave the real server running past its launcher's exit; the
    // group is ours, so sweep it regardless of how the direct child ended.
    if (child) await terminateProcessGroup(child);
    this.credentialBrokerChannel?.destroy();
    this.credentialBrokerChannel = null;
    this.promptOutstanding = false;
    this.failEverything(new Error("Fx ACP adapter stopped"));
    this.stderrLog?.end();
  }

  private onExit(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    const detail = this.stderrTail.trim();
    this.failEverything(new Error(detail ? `${reason}\n${detail}` : reason));
    this.lifecycle.emit({
      type: "orchestrator.stopped",
      turnId: null,
      agentState: "idle",
      attentionKind: null,
      data: { reason },
    });
  }

  private failEverything(error: Error): void {
    for (const [id, request] of this.pending) {
      this.pending.delete(id);
      if (request.timer) clearTimeout(request.timer);
      request.reject(error);
    }
    const active = this.activeTurn;
    if (active) this.settleTurn(active, "failed", null, error.message);
    for (const turn of this.queue.splice(0)) this.settleTurn(turn, "failed", null, error.message);
  }

  private assertRunning(): void {
    if (!this.ready || this.stopped) throw new Error("Fx ACP adapter is not running");
  }

  private createTurn(text: string, steeringEntry = false): AcpTurn {
    const turn: AcpTurn = {
      turnId: `acp-turn-${++this.turnSequence}`,
      fxTurnId: null,
      steeringEntry,
      text,
      assistantText: "",
      result: null,
      waiters: [],
    };
    this.turns.set(turn.turnId, turn);
    return turn;
  }

  private startTurn(turn: AcpTurn): void {
    this.activeTurn = turn;
    this.promptOutstanding = true;
    if (this.lifecycleFeed) this.awaitingTurnStart = turn;
    else {
      this.lifecycle.emit({
        type: "turn.started",
        turnId: turn.turnId,
        agentState: "working",
        attentionKind: null,
        data: { text: turn.text },
      });
    }
    this.request(
      "session/prompt",
      { sessionId: this.sessionId, prompt: [{ type: "text", text: turn.text }] },
      null,
    ).then(
      (result) => {
        // With the lifecycle feed present, `turn_ended` is authoritative and
        // has already settled this turn with Fx's own outcome.
        if (!turn.result) {
          const parsed = promptResultSchema.safeParse(result);
          if (parsed.success) {
            this.settleTurn(
              turn,
              outcomeFromStopReason(parsed.data.stopReason),
              parsed.data.stopReason,
            );
          } else {
            this.settleTurn(turn, "failed", null, "Fx ACP prompt response had no stopReason");
          }
        }
        this.promptSettled();
      },
      (error: unknown) => {
        if (!turn.result) this.settleTurn(turn, "failed", null, errorMessage(error));
        this.promptSettled();
      },
    );
  }

  private settleTurn(
    turn: AcpTurn,
    outcome: OrchestratorTurnOutcome,
    providerDisposition: string | null,
    failure?: string,
    fromLifecycle = false,
  ): void {
    if (turn.result) return;
    const assistantText =
      outcome === "failed" && failure && !turn.assistantText ? failure : turn.assistantText;
    turn.result = { turnId: turn.turnId, outcome, providerDisposition, assistantText };
    if (this.activeTurn === turn) this.activeTurn = null;
    if (this.awaitingTurnStart === turn) this.awaitingTurnStart = null;
    if (!fromLifecycle && !turn.steeringEntry) {
      this.lifecycle.emit({
        type: "turn.ended",
        turnId: turn.turnId,
        agentState: this.agentState(),
        attentionKind: null,
        data: { outcome, providerDisposition, ...(failure ? { failure } : {}) },
      });
    }
    for (const waiter of turn.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(turn.result);
    }
  }

  /** The prompt has been answered, so Fx will accept the next one. */
  private promptSettled(): void {
    this.promptOutstanding = false;
    if (this.activeTurn || this.stopped) return;
    const next = this.queue.shift();
    if (next) this.startTurn(next);
  }

  private async trySteer(
    text: string,
  ): Promise<{ delegationTurnId: string; activeTurnId: string } | null> {
    if (this.steering === "unsupported") return null;
    try {
      const result = steerResultSchema.parse(
        await this.request(STEER_METHOD, { sessionId: this.sessionId, text }),
      );
      this.markSteering("supported");
      if (result.disposition !== "steering") return null;
      const entry = this.createTurn(text, true);
      const active = this.activeTurn;
      if (active) {
        active.waiters.push({
          resolve: (outcome) =>
            this.settleTurn(entry, outcome.outcome, outcome.providerDisposition),
          reject: (error) => this.settleTurn(entry, "failed", null, error.message),
          timer: setTimeout(() => {}, 0),
        });
      }
      return { delegationTurnId: entry.turnId, activeTurnId: result.turnId };
    } catch (error) {
      // Fx answers an unknown method with either code depending on version;
      // both mean "no steering here", never a failed admission.
      if (
        error instanceof FxAcpError &&
        (error.code === JSON_RPC_METHOD_NOT_FOUND || error.code === JSON_RPC_INVALID_REQUEST)
      ) {
        this.markSteering("unsupported");
        return null;
      }
      throw error;
    }
  }

  private markSteering(state: "supported" | "unsupported"): void {
    this.steering = state;
    this.capabilities.steering = state === "supported";
  }

  private agentState(): OrchestratorAgentState {
    if (this.pendingAttention > 0) return "blocked";
    return this.activeTurn ? "working" : "idle";
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number | null = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const child = this.child;
    if (!child || this.stopped) return Promise.reject(new Error("Fx ACP adapter is not running"));
    const id = ++this.requestSequence;
    return new Promise((resolvePromise, reject) => {
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new FxAcpError(`Fx ACP ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
      this.pending.set(id, { method, resolve: resolvePromise, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error);
      });
    });
  }

  private consume(chunk: Buffer): void {
    this.lineBuffer += chunk.toString("utf8");
    if (this.lineBuffer.length > MAX_LINE_BYTES) {
      this.onExit(`Fx ACP emitted a line over ${MAX_LINE_BYTES} bytes`);
      this.child?.kill("SIGKILL");
      return;
    }
    let newline = this.lineBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.lineBuffer.slice(0, newline).trim();
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (line) this.dispatch(line);
      newline = this.lineBuffer.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.stderrTail = `${this.stderrTail}\nnon-JSON ACP line: ${line.slice(0, 200)}`.slice(-4096);
      return;
    }
    if (!isRecord(message)) return;
    const id = message["id"];
    const method = message["method"];
    if (typeof method === "string" && (typeof id === "number" || typeof id === "string")) {
      void this.handleServerRequest(id, method, message["params"]);
      return;
    }
    if (typeof method === "string") {
      this.handleNotification(method, message["params"]);
      return;
    }
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if ("error" in message && message["error"] !== undefined && message["error"] !== null) {
      const parsed = rpcErrorSchema.safeParse(message["error"]);
      pending.reject(
        parsed.success
          ? new FxAcpError(
              `Fx ACP ${pending.method} failed: ${parsed.data.message}`,
              parsed.data.code,
            )
          : new FxAcpError(`Fx ACP ${pending.method} failed`),
      );
      return;
    }
    pending.resolve(message["result"]);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const parsed = sessionUpdateSchema.safeParse(params);
    if (!parsed.success || parsed.data.sessionId !== this.sessionId) return;
    this.options.onUpdate?.(parsed.data);
    const update = parsed.data.update;
    switch (update["sessionUpdate"]) {
      case LIFECYCLE_UPDATE:
        this.handleLifecycleUpdate(update);
        return;
      case "agent_message_chunk":
        this.appendAssistantText(update);
        return;
      case "_fx/question": {
        const question = questionUpdateSchema.safeParse(update);
        if (question.success) void this.answerQuestion(question.data);
        return;
      }
      default:
        return;
    }
  }

  /** Routes text by Fx's turn id when it is present, so a steered turn keeps its own. */
  private appendAssistantText(update: Record<string, unknown>): void {
    const parsed = chunkUpdateSchema.safeParse(update);
    if (!parsed.success || parsed.data.content.type !== "text") return;
    const fxTurnId = parsed.data.turn_id;
    // Fall back to the active turn: an id we have not bound yet must never
    // cost the caller the text.
    const turn = (fxTurnId ? this.turnByFxId(fxTurnId) : null) ?? this.activeTurn;
    if (turn) turn.assistantText += parsed.data.content.text;
  }

  private handleLifecycleUpdate(update: Record<string, unknown>): void {
    const parsed = lifecycleUpdateSchema.safeParse(update);
    if (!parsed.success) return;
    const event = parsed.data;
    const base = {
      turnId: event.turn_id,
      agentState: event.agent_state,
      attentionKind: event.attention_kind,
    };
    if (event.agent_role !== "main") {
      this.lifecycle.emit({
        type: "attention.raised",
        ...base,
        data: { event: event.event, agentName: event.agent_name, child: true },
      });
      return;
    }
    switch (event.event) {
      case "fx_started":
        return;
      case "turn_started": {
        const turn = this.awaitingTurnStart;
        this.awaitingTurnStart = null;
        if (turn && event.turn_id) turn.fxTurnId = event.turn_id;
        this.lifecycle.emit({
          type: "turn.started",
          ...base,
          data: { ...(turn ? { text: turn.text } : {}) },
        });
        return;
      }
      case "turn_ended": {
        this.lifecycle.emit({
          type: "turn.ended",
          ...base,
          data: {
            outcome: event.outcome ?? "completed",
            providerDisposition: event.provider_disposition ?? null,
          },
        });
        const turn = event.turn_id ? this.turnByFxId(event.turn_id) : this.activeTurn;
        if (turn) {
          this.settleTurn(
            turn,
            event.outcome ?? "completed",
            event.provider_disposition ?? null,
            undefined,
            true,
          );
        }
        return;
      }
      case "attention_raised":
        this.pendingAttention += 1;
        this.lifecycle.emit({
          type: "attention.raised",
          ...base,
          data: { agentName: event.agent_name },
        });
        return;
      case "attention_cleared":
        if (this.pendingAttention > 0) this.pendingAttention -= 1;
        this.lifecycle.emit({
          type: "attention.cleared",
          ...base,
          data: { agentName: event.agent_name },
        });
        return;
      case "stop":
        this.lifecycle.emit({ type: "orchestrator.stopped", ...base, data: {} });
        return;
      default:
        return;
    }
  }

  private async answerQuestion(question: AcpQuestion): Promise<void> {
    const answer = await (this.options.onQuestion?.(question) ?? Promise.resolve(null));
    if (answer === null) return;
    await this.request(QUESTION_METHOD, {
      sessionId: this.sessionId,
      questionId: question.questionId,
      answer,
    }).catch((error: unknown) => {
      this.stderrTail = `${this.stderrTail}
question answer failed: ${errorMessage(error)}`.slice(-4096);
    });
  }

  private turnByFxId(fxTurnId: string): AcpTurn | null {
    for (const turn of this.turns.values()) {
      if (turn.fxTurnId === fxTurnId && !turn.result) return turn;
    }
    return null;
  }

  private async handleServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    if (method !== "session/request_permission") {
      this.respond(id, null, { code: JSON_RPC_METHOD_NOT_FOUND, message: `unsupported ${method}` });
      return;
    }
    const parsed = permissionRequestSchema.safeParse(params);
    if (!parsed.success) {
      this.respond(id, null, { code: -32602, message: "malformed permission request" });
      return;
    }
    const turnId = this.activeTurn?.turnId ?? null;
    this.pendingAttention += 1;
    this.lifecycle.emit({
      type: "attention.raised",
      turnId,
      agentState: "blocked",
      attentionKind: "permission",
      data: { options: parsed.data.options, toolCall: parsed.data.toolCall ?? null },
    });
    let decision: AcpPermissionDecision;
    try {
      decision = await (this.options.onPermissionRequest ?? defaultPermissionDecision)(parsed.data);
    } catch (error) {
      decision = { outcome: "cancelled" };
      this.stderrTail =
        `${this.stderrTail}\npermission handler failed: ${errorMessage(error)}`.slice(-4096);
    }
    this.pendingAttention -= 1;
    this.lifecycle.emit({
      type: "attention.cleared",
      turnId,
      agentState: this.agentState(),
      attentionKind: "permission",
      data: { decision },
    });
    this.respond(id, {
      outcome:
        decision.outcome === "selected"
          ? { outcome: "selected", optionId: decision.optionId }
          : { outcome: "cancelled" },
    });
  }

  private respond(
    id: number | string,
    result: unknown,
    error?: { code: number; message: string },
  ): void {
    const payload = error
      ? { jsonrpc: "2.0", id, error }
      : { jsonrpc: "2.0", id, result: result ?? null };
    this.child?.stdin.write(`${JSON.stringify(payload)}\n`, () => {});
  }
}

async function terminateProcessGroup(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid || process.platform === "win32") return;
  const alive = () => {
    try {
      process.kill(-child.pid!, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (!alive()) return;
  signalProcessGroup(child, "SIGTERM");
  const deadline = Date.now() + GROUP_TERMINATE_GRACE_MS;
  while (alive() && Date.now() < deadline) await Bun.sleep(50);
  if (alive()) signalProcessGroup(child, "SIGKILL");
}

function signalProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

function isDuplex(value: unknown): value is Duplex {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Duplex).write === "function" &&
    typeof (value as Duplex).pause === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
