/**
 * The console's coordination runtime: one attachment to the resident
 * app-server, one orchestrator agent, at most one realtime (WebRTC) voice
 * session. Audio flows peer-to-peer between the console and the voice agent;
 * this runtime only coordinates — it relays SDP offers into
 * `thread/realtime/start` and answers back out, owns the persisted thread,
 * reconciles workers after a restart, and rotates the resident across
 * accounts at idle. Session lifecycle lives in session.ts; worker logic in
 * workers.ts; this file is wiring.
 *
 * The resident process itself is launchd's job. This runtime attaches,
 * reattaches with backoff when the attachment drops (resident crash, upgrade,
 * rotation), and resumes the same orchestrator agent each time.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  residentSocketPath,
  residentStateFilePath,
  stateDirectory,
  threadStateFilePath,
  workersStateFilePath,
} from "../paths.ts";
import { RESIDENT_LABEL, readResidentState } from "../resident/contract.ts";
import {
  accountsDirectory,
  balancerCliPresent,
  discoverProfiles,
  listPoolAccounts,
  maxUsedPercent,
  onboardingFailureMessage,
  runBalancerCommand,
  selectAccount,
} from "./accounts.ts";
import { AppServerError, ResidentAttachment } from "./attach.ts";
import { PROMPT_FILES, promptFilenames, readPrompts, type ServerConfig } from "./config.ts";
import { ConfigWatcher, configWithVoiceName, type WatchedConfigSource } from "./config-watch.ts";
import { realtimeParams, threadParams, workerThreadParams } from "./params.ts";
import { VoiceSessionManager } from "./session.ts";
import {
  type AdoptionOutcome,
  archiveWorkerThread,
  deleteWorkerThread,
  finalAgentMessage,
  type PersistedWorker,
  WorkerManager,
  type WorkerSnapshot,
  WorkerTurnStartError,
} from "./workers.ts";

const REATTACH_BACKOFF_INITIAL_MS = 500;
const REATTACH_BACKOFF_CAP_MS = 30_000;
const SHUTDOWN_STOP_TIMEOUT_MS = 1_500;

export interface ReadyInfo {
  threadId: string;
  workspace: string;
  /** null means "codex default". */
  model: string | null;
  effort: string | null;
  voiceModel: string | null;
  voice: string | null;
  /** Prompt files priming the agents. */
  prompts: string[];
}

/** The runtime's outward face — what the WebSocket protocol used to carry. */
export interface RuntimeEvents {
  /** Offers are accepted from now on; re-emitted whenever offers reopen. */
  onReady(info: ReadyInfo): void;
  onAnswer(sdp: string): void;
  /** The voice session ended; wait for the next onReady, then re-offer. */
  onClosed(reason?: string): void;
  /** Negotiate a replacement voice session against the same agent. */
  onRedial(reason: string): void;
  /** fatal: the session is dead — close the peer and wait for onReady. */
  onError(message: string, fatal: boolean): void;
  onWorker(worker: WorkerSnapshot): void;
  /** One-line notices for the event feed. */
  onStatus(line: string): void;
  debug?(line: string): void;
}

export interface RuntimeOptions {
  /** Abandon the persisted orchestrator agent and start a fresh thread. */
  fresh?: boolean;
  configSource?: WatchedConfigSource;
}

interface ThreadReadShape {
  thread?: {
    status?: { type?: string };
    turns?: Array<Record<string, unknown>>;
  };
}

function loadThreadState(path: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return typeof raw["threadId"] === "string" ? raw["threadId"] : null;
  } catch {
    return null;
  }
}

function loadPersistedWorkers(path: string): PersistedWorker[] {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const workers = raw["workers"];
    return Array.isArray(workers) ? (workers as PersistedWorker[]) : [];
  } catch {
    return [];
  }
}

/** Atomic write: a torn state file must never eat the orchestrator agent. */
function writeStateFile(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export class VoiceRuntime {
  private readonly config: ServerConfig;
  private readonly version: string;
  private readonly events: RuntimeEvents;
  private readonly socketPath: string;
  private readonly threadStatePath: string;
  private readonly workersStatePath: string;
  private readonly residentStatePath: string;
  private readonly accountsDir: string;
  private prompts: Awaited<ReturnType<typeof readPrompts>> = {};
  private foundPrompts: string[] = [];

  private attachment: ResidentAttachment | null = null;
  private threadId: string | null = null;
  private threadReady = false;
  private activeVoiceName: string | undefined;
  private activeAccount: string | null = null;
  private orchestratorTurnActive = false;
  private exhaustedPercent: number | null = null;
  private rotating = false;
  private reattachFailures = 0;
  private reattaching = false;
  private shuttingDown = false;
  private freshInFlight = false;
  private workers: WorkerManager | null = null;
  private readonly sessions: VoiceSessionManager;
  private configWatcher: ConfigWatcher | null = null;

  private constructor(config: ServerConfig, version: string, events: RuntimeEvents) {
    this.config = config;
    this.version = version;
    this.events = events;
    this.activeVoiceName = config.voice.name;
    const home = homedir();
    this.socketPath = residentSocketPath(process.env, home);
    this.threadStatePath = threadStateFilePath(process.env, home);
    this.workersStatePath = workersStateFilePath(process.env, home);
    this.residentStatePath = residentStateFilePath(process.env, home);
    this.accountsDir = accountsDirectory(process.env, home);

    this.sessions = new VoiceSessionManager({
      sendAnswer: (sdp) => this.events.onAnswer(sdp),
      sendClosed: (reason) => this.events.onClosed(reason),
      sendFailed: (message) => this.events.onError(message, true),
      sendReady: () => this.emitReady(),
      startRealtime: (realtimeSessionId, sdp) => {
        const attachment = this.attachment;
        const threadId = this.threadId;
        if (!attachment || !threadId) {
          return Promise.reject(new AppServerError("not attached to the app-server"));
        }
        return attachment
          .request(
            "thread/realtime/start",
            realtimeParams(
              configWithVoiceName(this.config, this.activeVoiceName),
              this.prompts,
              threadId,
              realtimeSessionId,
              sdp,
            ),
          )
          .then(() => {});
      },
      stopRealtime: () => {
        const attachment = this.attachment;
        const threadId = this.threadId;
        if (!attachment || !threadId) {
          return Promise.reject(new AppServerError("not attached to the app-server"));
        }
        return attachment.request("thread/realtime/stop", { threadId }).then(() => {});
      },
      debug: (line) => this.events.debug?.(line),
    });
  }

  static async start(
    config: ServerConfig,
    version: string,
    events: RuntimeEvents,
    options: RuntimeOptions = {},
  ): Promise<VoiceRuntime> {
    const runtime = new VoiceRuntime(config, version, events);
    await runtime.boot(options);
    return runtime;
  }

  get currentReady(): ReadyInfo | null {
    if (!this.threadReady || !this.threadId) return null;
    return {
      threadId: this.threadId,
      workspace: this.config.orchestrator.workspace,
      model: this.config.orchestrator.model ?? null,
      effort: this.config.orchestrator.effort ?? null,
      voiceModel: this.config.voice.model ?? null,
      voice: this.activeVoiceName ?? null,
      prompts: this.foundPrompts,
    };
  }

  workerSnapshots(): WorkerSnapshot[] {
    return this.workers?.snapshots() ?? [];
  }

  /** A new offer supersedes whatever voice session is running. */
  offer(sdp: string): void {
    if (!this.threadReady || !this.attachment) {
      this.events.onError("no orchestrator agent yet; wait for ready", false);
      return;
    }
    this.sessions.handleOffer(sdp);
  }

  /**
   * Abandon the current orchestrator agent and start a fresh thread. The
   * running voice session is torn down silently; the console re-offers when
   * the new thread announces ready.
   */
  async fresh(): Promise<void> {
    const attachment = this.attachment;
    if (this.freshInFlight || this.shuttingDown || !attachment || !this.threadReady) return;
    this.freshInFlight = true;
    try {
      this.threadReady = false;
      if (this.sessions.hasSession) this.sessions.handleClientGone();
      this.events.onClosed("fresh-thread");
      const started = await attachment.request(
        "thread/start",
        threadParams(this.config, this.prompts, "start"),
      );
      this.threadId = extractThreadId(started);
      writeStateFile(this.threadStatePath, { threadId: this.threadId });
      this.threadReady = true;
      this.events.onStatus(`fresh orchestrator agent (${this.threadId.slice(0, 8)}…)`);
      this.emitReady();
    } catch (error) {
      this.threadReady = this.threadId !== null;
      this.events.onError(
        `fresh thread failed: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
      if (this.threadReady) this.emitReady();
    } finally {
      this.freshInFlight = false;
    }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.configWatcher?.stop();
    await Promise.race([
      this.sessions.shutdown(),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_STOP_TIMEOUT_MS)),
    ]);
    this.persistWorkers();
    this.attachment?.close();
    this.attachment = null;
  }

  // -------------------------------------------------------------------------

  private async boot(options: RuntimeOptions): Promise<void> {
    mkdirSync(join(stateDirectory(process.env, homedir()), "app-server"), {
      recursive: true,
      mode: 0o700,
    });
    mkdirSync(this.config.orchestrator.workspace, { recursive: true, mode: 0o700 });
    this.prompts = await readPrompts(this.config.configDir);
    this.foundPrompts = promptFilenames(this.prompts);
    if (this.prompts.orchestratorBaseInstructions !== undefined) {
      this.events.onStatus(
        `warning: ${PROMPT_FILES.orchestratorBaseInstructions} replaces codex's entire system prompt`,
      );
    }

    // Balancing on + a balancing setup installed + nothing onboarded is a
    // configuration error, not a degraded mode: exit with the exact commands.
    if (this.config.accounts.balance && balancerCliPresent()) {
      const profiles = discoverProfiles(this.accountsDir);
      if (!profiles.some((profile) => profile.identity !== null)) {
        throw new Error(onboardingFailureMessage(await listPoolAccounts()));
      }
    }

    if (options.fresh !== true) {
      this.threadId = loadThreadState(this.threadStatePath);
    }

    // Boot fails fast: the operator is present. Later drops are supervised.
    await this.attachOnce();

    if (options.configSource) {
      this.configWatcher = new ConfigWatcher(options.configSource, this.config, {
        voiceNameChanged: (name) => {
          this.activeVoiceName = name;
          this.events.onStatus(`voice changed to ${name ?? "upstream default"}`);
          this.emitReady();
          if (this.sessions.hasSession) this.events.onRedial("voice-name-changed");
        },
        rejected: (error) => {
          this.events.onStatus(
            `config change ignored: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      });
      this.configWatcher.start();
      void this.configWatcher.reload();
    }
  }

  /** One attach → thread → reconcile → ready cycle. Throws on failure. */
  private async attachOnce(): Promise<void> {
    const attachment = await ResidentAttachment.connect({
      socketPath: this.socketPath,
      clientVersion: this.version,
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (method, params) => this.handleRequest(method, params),
      onClose: (info) => this.handleDetached(attachment, info),
      debug: (line) => this.events.debug?.(line),
    }).catch((error) => {
      throw new AppServerError(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `Is the resident app-server running? Install it with: agentvoice resident install\n` +
          `Inspect it with: agentvoice resident status`,
      );
    });
    this.attachment = attachment;
    this.activeAccount = readResidentState(this.residentStatePath)?.account ?? null;
    this.exhaustedPercent = null;
    this.orchestratorTurnActive = false;

    try {
      this.threadId = await this.openThread(attachment);
      writeStateFile(this.threadStatePath, { threadId: this.threadId });
      await this.interruptStrandedTurns(attachment, this.threadId);
      await this.reconcileWorkers(attachment);
    } catch (error) {
      this.attachment = null;
      attachment.close();
      throw error;
    }
    this.threadReady = true;
    this.events.onStatus(
      `attached (account: ${this.activeAccount ?? "canonical"}, thread ${this.threadId.slice(0, 8)}…)`,
    );
    this.emitReady();
  }

  private async openThread(attachment: ResidentAttachment): Promise<string> {
    if (this.threadId) {
      const previous = this.threadId;
      try {
        return extractThreadId(
          await attachment.request("thread/resume", {
            threadId: previous,
            excludeTurns: true,
            ...threadParams(this.config, this.prompts, "resume"),
          }),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.events.onStatus(`thread/resume failed (${detail}); starting fresh`);
        // A no-rollout thread is definitively pre-turn: it holds nothing and
        // can never be resumed, but it may still be loaded in the resident.
        // Delete it so silent console restarts don't accumulate empty threads.
        if (detail.includes(`no rollout found for thread id ${previous}`)) {
          attachment.request("thread/delete", { threadId: previous }).catch(() => {});
        }
      }
    }
    return extractThreadId(
      await attachment.request("thread/start", threadParams(this.config, this.prompts, "start")),
    );
  }

  /**
   * A turn still in flight on the orchestrator's thread was driven by a
   * console that no longer exists — and if it is parked on a dispatch tool
   * call, the answerable connection died with it (an unanswered dynamic tool
   * call parks its turn indefinitely; verified by resident-probe). Interrupt
   * rather than adopt: the conversation that wanted the answer is gone.
   */
  private async interruptStrandedTurns(
    attachment: ResidentAttachment,
    threadId: string,
  ): Promise<void> {
    let read: ThreadReadShape;
    try {
      read = (await attachment.request("thread/read", {
        threadId,
        includeTurns: true,
      })) as ThreadReadShape;
    } catch {
      return; // a fresh thread has nothing to read
    }
    for (const turn of read.thread?.turns ?? []) {
      if (turn["status"] !== "inProgress" || typeof turn["id"] !== "string") continue;
      try {
        await attachment.request("turn/interrupt", { threadId, turnId: turn["id"] });
        this.events.onStatus("interrupted a turn stranded by the previous console run");
      } catch (error) {
        this.events.debug?.(
          `stranded-turn interrupt failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** Rebuild the worker registry from disk against the resident's state. */
  private async reconcileWorkers(attachment: ResidentAttachment): Promise<void> {
    if (this.config.orchestrator.dispatch !== true) {
      this.workers = null;
      return;
    }
    const persisted =
      this.workers?.persistenceRecords() ?? loadPersistedWorkers(this.workersStatePath);
    const manager = this.buildWorkerManager();
    this.workers = manager;
    for (const record of persisted) {
      let outcome: AdoptionOutcome = { kind: "lost" };
      if (record.status === "running") {
        outcome = await this.classifyWorkerThread(attachment, record.threadId);
      }
      manager.adopt(record, outcome);
    }
    this.persistWorkers();
  }

  /** running / finished / lost, by resuming and reading the worker's thread. */
  private async classifyWorkerThread(
    attachment: ResidentAttachment,
    threadId: string,
  ): Promise<AdoptionOutcome> {
    try {
      // Resume first: it re-subscribes this connection to the thread, so a
      // still-running turn's completion notification reaches this console.
      await attachment.request("thread/resume", { threadId, excludeTurns: true });
      const read = (await attachment.request("thread/read", {
        threadId,
        includeTurns: true,
      })) as ThreadReadShape;
      if (read.thread?.status?.type === "active") return { kind: "running" };
      const turns = read.thread?.turns ?? [];
      const last = turns[turns.length - 1];
      if (!last) return { kind: "lost" };
      const status = last["status"];
      return {
        kind: "finished",
        status:
          status === "completed"
            ? "completed"
            : status === "interrupted"
              ? "interrupted"
              : "failed",
        report: finalAgentMessage(last),
      };
    } catch {
      return { kind: "lost" };
    }
  }

  private buildWorkerManager(): WorkerManager {
    let manager: WorkerManager;
    const request = (method: string, params: unknown) => {
      const attachment = this.attachment;
      if (!attachment) return Promise.reject(new AppServerError("not attached to the app-server"));
      return attachment.request(method, params);
    };
    manager = new WorkerManager(
      {
        startWorkerThread: async () => ({
          threadId: extractThreadId(await request("thread/start", workerThreadParams(this.config))),
        }),
        startWorkerTurn: async (workerThreadId, brief) => {
          let turn: { turn?: { id?: string } };
          try {
            turn = (await request("turn/start", {
              threadId: workerThreadId,
              input: [{ type: "text", text: brief }],
            })) as { turn?: { id?: string } };
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            // A JSON-RPC error means submission was rejected; a timeout or
            // detachment can lose a response after core accepted the turn.
            const mayHaveStarted = !(error instanceof AppServerError && error.code !== undefined);
            throw new WorkerTurnStartError(detail, mayHaveStarted);
          }
          const turnId = turn?.turn?.id;
          if (!turnId) {
            throw new WorkerTurnStartError("app-server returned no turn id for the worker", true);
          }
          return { turnId };
        },
        interruptWorker: async (workerThreadId, turnId) => {
          await request("turn/interrupt", { threadId: workerThreadId, turnId });
        },
        archiveWorker: (workerThreadId) =>
          archiveWorkerThread((method, params) => request(method, params), workerThreadId),
        deleteWorker: (workerThreadId) =>
          deleteWorkerThread((method, params) => request(method, params), workerThreadId),
        scheduleCleanupRetry(run, delayMs) {
          setTimeout(run, delayMs).unref();
        },
        reportToOrchestrator: (text) => {
          const threadId = this.threadId;
          if (!this.attachment || !threadId) return;
          // Fire and forget: upstream admission steers the report into a
          // running turn or opens a fresh one; a failure only loses one report.
          request("turn/start", { threadId, input: [{ type: "text", text }] }).catch((error) => {
            this.events.onStatus(
              `worker report failed to land: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        },
        onWorkerUpdate: (worker) => {
          if (this.workers !== manager) return; // a superseded registry
          this.events.onWorker(worker);
          this.persistWorkers();
        },
        onWorkSettled: () => {
          if (this.workers !== manager) return;
          this.persistWorkers();
          this.maybeRotate();
        },
        now: () => Date.now(),
        debug: (line) => this.events.debug?.(line),
      },
      this.config.orchestrator.dispatchReports === true,
    );
    return manager;
  }

  private persistWorkers(): void {
    if (this.config.orchestrator.dispatch !== true) return;
    const workers = this.workers?.persistenceRecords() ?? [];
    try {
      writeStateFile(this.workersStatePath, { workers });
    } catch (error) {
      this.events.debug?.(
        `worker persistence failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private emitReady(): void {
    const info = this.currentReady;
    if (info) this.events.onReady(info);
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === "turn/started" && params["threadId"] === this.threadId) {
      this.orchestratorTurnActive = true;
    } else if (method === "turn/completed" && params["threadId"] === this.threadId) {
      this.orchestratorTurnActive = false;
    } else if (method === "account/rateLimits/updated" && this.config.accounts.balance) {
      const used = maxUsedPercent(params);
      this.exhaustedPercent =
        used !== null && used >= this.config.accounts.switchThreshold ? used : null;
    }
    if (method === "turn/completed" && this.workers) {
      const turnThread = params["threadId"];
      if (typeof turnThread === "string" && this.workers.ownsThread(turnThread)) {
        this.workers.handleTurnCompleted(
          turnThread,
          (params["turn"] ?? {}) as Record<string, unknown>,
        );
      }
      this.maybeRotate();
      return;
    }
    if (method.startsWith("thread/realtime/")) {
      if (params["threadId"] === undefined || params["threadId"] === this.threadId) {
        this.sessions.handleNotification(method, params);
      }
    }
    this.maybeRotate();
  }

  private handleRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> | null {
    if (method !== "item/tool/call" || !this.workers) return null;
    // Only the orchestrator's thread carries the dispatch tools; anything
    // else falls through to the fail-closed denial.
    if (params["threadId"] !== this.threadId) return null;
    const tool = typeof params["tool"] === "string" ? params["tool"] : "";
    const args = (params["arguments"] ?? {}) as Record<string, unknown>;
    return this.workers.handleToolCall(tool, args);
  }

  private handleDetached(
    attachment: ResidentAttachment,
    info: { expected: boolean; error?: string },
  ): void {
    if (this.attachment !== attachment) return; // an attachment we replaced
    this.attachment = null;
    this.threadReady = false;
    this.orchestratorTurnActive = false;
    const hadSession = this.sessions.hasSession;
    this.sessions.reset(); // the voice session cannot outlive the attachment
    this.persistWorkers(); // workers may still be alive; reconcile on reattach
    if (this.shuttingDown || info.expected) return;
    if (hadSession) this.events.onClosed("app-server-detached");
    this.events.onStatus(
      `resident app-server detached${info.error ? ` (${info.error})` : ""}; reattaching`,
    );
    this.scheduleReattach();
  }

  private scheduleReattach(): void {
    if (this.reattaching || this.shuttingDown) return;
    this.reattaching = true;
    const delay = Math.min(
      REATTACH_BACKOFF_INITIAL_MS * 2 ** this.reattachFailures,
      REATTACH_BACKOFF_CAP_MS,
    );
    setTimeout(() => {
      void (async () => {
        try {
          await this.attachOnce();
          this.reattachFailures = 0;
        } catch (error) {
          this.reattachFailures++;
          this.events.onStatus(
            `reattach failed (${error instanceof Error ? error.message : String(error)})`,
          );
        } finally {
          this.reattaching = false;
          if (!this.attachment && !this.shuttingDown) this.scheduleReattach();
        }
      })();
    }, delay);
  }

  /**
   * An exhausted account rotates only between things: never under a voice
   * session, a running orchestrator turn, or live workers. The balancer is
   * consulted first — picking the already-active account disarms instead of
   * restarting into the same exhaustion. The restart itself is launchd's:
   * kickstart re-runs the wrapper, whose pick is authoritative.
   */
  private maybeRotate(): void {
    if (this.exhaustedPercent === null || this.rotating || this.shuttingDown) return;
    if (!this.config.accounts.balance || !this.attachment || !this.threadReady) return;
    if (this.sessions.hasSession || this.orchestratorTurnActive) return;
    if (this.workers?.hasUnfinishedWork()) return;
    this.rotating = true;
    const usedPercent = this.exhaustedPercent;
    void (async () => {
      try {
        const selection = await selectAccount(
          discoverProfiles(this.accountsDir),
          runBalancerCommand,
        );
        if (selection.kind === "canonical" || selection.email === this.activeAccount) {
          this.exhaustedPercent = null; // nothing better; re-armed by the next update
          return;
        }
        if (
          !this.attachment ||
          this.sessions.hasSession ||
          this.orchestratorTurnActive ||
          this.workers?.hasUnfinishedWork()
        ) {
          return;
        }
        this.events.onStatus(
          `rotating off ${this.activeAccount ?? "canonical"} (${usedPercent}% used) to ${selection.email}`,
        );
        await kickstartResident();
        // The attachment drops as the resident restarts; the reattach loop
        // resumes the same orchestrator agent under the wrapper's new pick.
      } catch (error) {
        this.events.onStatus(
          `rotation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        this.rotating = false;
      }
    })();
  }
}

function extractThreadId(result: unknown): string {
  const shape = result as { thread?: { id?: string }; threadId?: string };
  const id = shape?.thread?.id ?? shape?.threadId;
  if (!id) throw new AppServerError("app-server returned no thread id");
  return id;
}

/** `launchctl kickstart -k`: restart the resident under launchd supervision. */
export async function kickstartResident(): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("no uid; launchctl needs a gui domain");
  const child = Bun.spawn(["launchctl", "kickstart", "-k", `gui/${uid}/${RESIDENT_LABEL}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await child.exited;
  if (code !== 0) {
    const stderr = await new Response(child.stderr).text();
    throw new Error(`launchctl kickstart failed (${code}): ${stderr.trim()}`);
  }
}
