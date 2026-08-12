/**
 * Worker dispatch: the orchestrator agent's surface for running asynchronous
 * work as sibling app-server threads instead of inside its own turn.
 *
 * Three dynamic tools ride the orchestrator's `thread/start` when
 * `orchestrator.dispatch` is on. A call arrives as an `item/tool/call`
 * server→client request; this module owns the registry and the pure logic,
 * with every app-server interaction injected as an effect (session.ts's
 * pattern). Worker completion is push: the server routes `turn/completed`
 * notifications for worker threads here, and the composed worker report is
 * started as a turn on the orchestrator's thread — upstream admission steers
 * it into a running turn or opens a fresh one (verified against 0.147).
 *
 * Workers are in-memory, scoped to one app-server child: when the child dies,
 * running workers are marked lost rather than resumed — the orchestrator
 * learns that from its next check or dispatch, not from a ghost report. A
 * Worker's task outcome and thread cleanup are deliberately separate: a
 * terminal outcome is preserved for check/report while archival retries until
 * app-server confirms the live thread has been retired.
 */

import type { WorkerSnapshot } from "../protocol.ts";

export type WorkerStatus = WorkerSnapshot["status"];

/** Classifies whether a failed turn/start may nevertheless have submitted work. */
export class WorkerTurnStartError extends Error {
  readonly mayHaveStarted: boolean;

  constructor(message: string, mayHaveStarted: boolean) {
    super(message);
    this.mayHaveStarted = mayHaveStarted;
  }
}

type WorkerRpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasRpcDetail(error: unknown, detail: string): boolean {
  return errorMessage(error).includes(detail);
}

/**
 * Idempotently delete a definitively pre-turn Worker root. Upstream removes
 * and shuts down the live runtime before its store operation, which reports
 * no-rollout for the expected unmaterialized case.
 */
export async function deleteWorkerThread(request: WorkerRpc, threadId: string): Promise<void> {
  try {
    await request("thread/delete", { threadId });
  } catch (error) {
    if (
      hasRpcDetail(error, `thread not found: ${threadId}`) ||
      hasRpcDetail(error, `no rollout found for thread id ${threadId}`)
    ) {
      return;
    }
    throw error;
  }
}

/**
 * Idempotently archive a materialized Worker root. A no-rollout response is
 * ambiguous on retry: thread/read distinguishes already-archived history
 * (notLoaded) from a pre-rollout root (idle while loaded, `thread not loaded`
 * after an app-server restart), which is safe to delete.
 */
export async function archiveWorkerThread(request: WorkerRpc, threadId: string): Promise<void> {
  try {
    await request("thread/archive", { threadId });
    return;
  } catch (error) {
    if (hasRpcDetail(error, `thread not found: ${threadId}`)) return;
    if (!hasRpcDetail(error, `no rollout found for thread id ${threadId}`)) throw error;

    let read: { thread?: { status?: { type?: string } } };
    try {
      read = (await request("thread/read", {
        threadId,
        includeTurns: false,
      })) as { thread?: { status?: { type?: string } } };
    } catch (readError) {
      if (hasRpcDetail(readError, `thread not found: ${threadId}`)) return;
      if (hasRpcDetail(readError, `thread not loaded: ${threadId}`)) {
        await deleteWorkerThread(request, threadId);
        return;
      }
      throw readError;
    }
    if (read.thread?.status?.type === "notLoaded") return;
    if (read.thread?.status?.type !== "idle") throw error;
    await deleteWorkerThread(request, threadId);
  }
}

export interface WorkerRecord {
  /** Short speakable handle: w1, w2, … — never a thread id. */
  id: string;
  threadId: string;
  turnId?: string;
  title: string;
  brief: string;
  status: WorkerStatus;
  startedAt: number;
  finishedAt?: number;
  /** Final agent message of the worker's turn, trimmed for the report. */
  report?: string;
  /** A terminal notification was consumed; independent of the public status. */
  terminalObserved: boolean;
  /** No further terminal notification is required before the task is settled. */
  taskSettled: boolean;
  terminalPublished: boolean;
  terminalStatus?: TerminalWorkerStatus;
  cancellation: CancellationStatus;
  cleanup: WorkerCleanup;
}

type CleanupDisposition = "archive" | "delete";
type CleanupStatus = "idle" | "pending" | "running" | "complete";
type TerminalWorkerStatus = Exclude<WorkerStatus, "running" | "cancelled" | "lost">;
type CancellationStatus = "none" | "pending" | "accepted";

interface WorkerCleanup {
  disposition?: CleanupDisposition;
  status: CleanupStatus;
  attempts: number;
}

export interface WorkerEffects {
  /** thread/start for a fresh worker. */
  startWorkerThread(): Promise<{ threadId: string }>;
  /** turn/start after the manager has registered ownership of its thread. */
  startWorkerTurn(threadId: string, brief: string): Promise<{ turnId: string }>;
  /** turn/interrupt on a running worker's thread. */
  interruptWorker(threadId: string, turnId: string): Promise<void>;
  /** Retire a materialized Worker thread while preserving its history. */
  archiveWorker(threadId: string): Promise<void>;
  /** Remove a Worker thread whose initial turn never became established. */
  deleteWorker(threadId: string): Promise<void>;
  /** Schedule an unref'ed cleanup retry so it cannot keep shutdown alive. */
  scheduleCleanupRetry(run: () => void, delayMs: number): void;
  /** Start the report turn on the orchestrator's thread; never awaited by callers. */
  reportToOrchestrator(text: string): void;
  /** A worker changed state — the client-facing progress feed. */
  onWorkerUpdate?(worker: WorkerSnapshot): void;
  /** Work or cleanup settled; callers may re-evaluate lifecycle gates. */
  onWorkSettled?(): void;
  now(): number;
  debug?(line: string): void;
}

/**
 * Every tool answer is a DynamicToolCallResponse:
 * `{ contentItems: [{ type: "inputText", text }], success }` — typed as the
 * open record the JSON-RPC response layer carries.
 */
type ToolResponse = Record<string, unknown>;

/**
 * Wire specs for `thread/start.dynamicTools` (0.147 DynamicToolFunctionSpec).
 * The descriptions are model-visible behavior contracts, so they follow the
 * report mode: pushed reports promise "a report will arrive"; pull-only says
 * to check. A description that promises events the server will not send
 * would be a lie in the orchestrator's prompt surface.
 */
export function dispatchTools(pushReports: boolean): ReadonlyArray<Record<string, unknown>> {
  return [
    {
      type: "function",
      name: "dispatch_worker",
      description:
        "Run asynchronous work as a separate worker thread with its own context. " +
        "Give a crisp, self-contained brief: what to do, where, what done looks " +
        "like, and where to write results. Returns a worker handle immediately; " +
        (pushReports
          ? "a worker report arrives as a later message when it finishes, so do " +
            "not wait or poll — keep the conversation going."
          : "nothing is pushed to you when it finishes — call check_workers when " +
            "you want status or results."),
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "A few speakable words naming the work, e.g. 'lint sweep'.",
          },
          brief: {
            type: "string",
            description: "The complete instructions the worker executes, standing alone.",
          },
        },
        required: ["title", "brief"],
      },
    },
    {
      type: "function",
      name: "check_workers",
      description:
        "List dispatched workers and their status (running, completed, failed, " +
        "interrupted, cancelled, lost) with each finished worker's report.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      type: "function",
      name: "cancel_worker",
      description: "Interrupt a running worker by its handle (for example w2).",
      inputSchema: {
        type: "object",
        properties: {
          worker: { type: "string", description: "The worker handle, e.g. w2." },
        },
        required: ["worker"],
      },
    },
  ];
}

/** Keeps a worker's final message from flooding the orchestrator's context. */
const REPORT_LIMIT_CHARS = 4_000;
const CLEANUP_RETRY_INITIAL_MS = 250;
const CLEANUP_RETRY_CAP_MS = 30_000;

function ok(text: string): ToolResponse {
  return { contentItems: [{ type: "inputText", text }], success: true };
}

function refuse(text: string): ToolResponse {
  return { contentItems: [{ type: "inputText", text }], success: false };
}

function trimReport(text: string): string {
  if (text.length <= REPORT_LIMIT_CHARS) return text;
  return `${text.slice(0, REPORT_LIMIT_CHARS)}\n…report truncated…`;
}

function describe(worker: WorkerRecord, now: number): string {
  const seconds = Math.max(0, Math.round(((worker.finishedAt ?? now) - worker.startedAt) / 1000));
  const head = `${worker.id} "${worker.title}" — ${worker.status} (${seconds}s)`;
  return worker.report === undefined ? head : `${head}\n${worker.report}`;
}

function snapshot(worker: WorkerRecord): WorkerSnapshot {
  return {
    id: worker.id,
    title: worker.title,
    status: worker.status,
    startedAt: worker.startedAt,
    ...(worker.finishedAt === undefined ? {} : { finishedAt: worker.finishedAt }),
    ...(worker.report === undefined ? {} : { report: worker.report }),
  };
}

export class WorkerManager {
  private readonly effects: WorkerEffects;
  /** Push `<worker_report>` turns on completion; off leaves check_workers as the only read. */
  private readonly pushReports: boolean;
  private readonly workers = new Map<string, WorkerRecord>();
  private nextWorker = 1;

  constructor(effects: WorkerEffects, pushReports: boolean) {
    this.effects = effects;
    this.pushReports = pushReports;
  }

  /** Thread ids of workers, for routing notifications. */
  ownsThread(threadId: string): boolean {
    for (const worker of this.workers.values()) {
      if (worker.threadId === threadId) return true;
    }
    return false;
  }

  /**
   * One entry point for every dispatch tool call; always resolves to a tool
   * response — a broken dispatch is a refusal the model can read, never a
   * hung request.
   */
  async handleToolCall(tool: string, args: Record<string, unknown>): Promise<ToolResponse> {
    switch (tool) {
      case "dispatch_worker":
        return this.dispatch(args);
      case "check_workers":
        return this.check();
      case "cancel_worker":
        return this.cancel(args);
      default:
        return refuse(`unknown dispatch tool "${tool}"`);
    }
  }

  private async dispatch(args: Record<string, unknown>): Promise<ToolResponse> {
    const title = typeof args["title"] === "string" ? args["title"].trim() : "";
    const brief = typeof args["brief"] === "string" ? args["brief"].trim() : "";
    if (title === "" || brief === "") {
      return refuse("dispatch_worker needs both a title and a brief");
    }
    const id = `w${this.nextWorker++}`;
    let worker: WorkerRecord | undefined;
    try {
      const { threadId } = await this.effects.startWorkerThread();
      worker = {
        id,
        threadId,
        title,
        brief,
        status: "running",
        startedAt: this.effects.now(),
        terminalObserved: false,
        taskSettled: false,
        terminalPublished: false,
        cancellation: "none",
        cleanup: { status: "idle", attempts: 0 },
      };
      // Ownership begins before turn/start. app-server may deliver a very fast
      // turn/completed in the same stdout batch as the turn/start response.
      this.workers.set(id, worker);
      const { turnId } = await this.effects.startWorkerTurn(threadId, brief);
      worker.turnId = turnId;
      this.effects.debug?.(`worker ${id} dispatched on thread ${threadId}`);
      if (worker.status === "running") this.effects.onWorkerUpdate?.(snapshot(worker));
      return ok(
        worker.status === "running"
          ? this.pushReports
            ? `${id} "${title}" is running. Its report will arrive as a message when it finishes — continue the conversation, don't wait.`
            : `${id} "${title}" is running. Nothing is pushed when it finishes — check_workers reads status and results.`
          : `${id} "${title}" finished before dispatch returned; check_workers has its ${worker.status} result.`,
      );
    } catch (error) {
      // The id is not reused: a racing dispatch may already hold the next one.
      const detail = error instanceof Error ? error.message : String(error);
      if (!worker) return refuse(`dispatch failed: ${detail}`);
      // A notification or child reset can settle the task before the rejected
      // turn/start promise resumes. Never overwrite that real outcome.
      if (worker.taskSettled) {
        return ok(
          `${id} "${title}" settled before dispatch returned; check_workers has its ${worker.status} result.`,
        );
      }
      worker.status = "failed";
      worker.finishedAt = this.effects.now();
      worker.report = `worker turn failed to start: ${detail}`;
      worker.taskSettled = true;
      this.effects.onWorkerUpdate?.(snapshot(worker));
      // A JSON-RPC rejection is definitively pre-turn and can be deleted. A
      // timeout or lost response may follow successful submission upstream;
      // archive it so any real history is retained while resources still die.
      this.requestCleanup(
        worker,
        error instanceof WorkerTurnStartError && !error.mayHaveStarted ? "delete" : "archive",
      );
      return refuse(`dispatch failed for ${id}: ${detail}`);
    }
  }

  private check(): ToolResponse {
    if (this.workers.size === 0) return ok("no workers have been dispatched this run");
    const now = this.effects.now();
    const lines = [...this.workers.values()].map((worker) => describe(worker, now));
    return ok(lines.join("\n"));
  }

  private async cancel(args: Record<string, unknown>): Promise<ToolResponse> {
    const handle = typeof args["worker"] === "string" ? args["worker"].trim() : "";
    const worker = this.workers.get(handle);
    if (!worker) return refuse(`no worker "${handle}"; check_workers lists handles`);
    if (worker.status !== "running") {
      return refuse(`${worker.id} is already ${worker.status}`);
    }
    if (worker.cancellation === "pending") {
      return refuse(`${worker.id} already has a cancellation request in flight`);
    }
    const turnId = worker.turnId;
    if (!turnId) return refuse(`${worker.id} is still starting; try cancellation again`);
    worker.cancellation = "pending";
    try {
      await this.effects.interruptWorker(worker.threadId, turnId);
      worker.cancellation = "accepted";
      if (worker.terminalObserved) {
        this.requestCleanup(worker, "archive");
        this.publishTerminal(worker);
      } else {
        worker.status = "cancelled";
        worker.finishedAt = this.effects.now();
        this.effects.onWorkerUpdate?.(snapshot(worker));
      }
      return ok(`${worker.id} "${worker.title}" cancellation requested`);
    } catch (error) {
      worker.cancellation = "none";
      if (worker.terminalObserved) {
        this.requestCleanup(worker, "archive");
        this.publishTerminal(worker);
        return ok(`${worker.id} "${worker.title}" finished before cancellation landed`);
      }
      return refuse(`cancel failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Route a `turn/completed` for a worker thread: record the outcome and fire
   * the report turn at the orchestrator. The payload's `turn.items` carries
   * the worker's final agent message (verified by probe against 0.147).
   */
  handleTurnCompleted(threadId: string, turn: Record<string, unknown>): void {
    const worker = [...this.workers.values()].find((candidate) => candidate.threadId === threadId);
    if (!worker || worker.terminalObserved) return;

    worker.terminalObserved = true;
    worker.taskSettled = true;
    const status = turn["status"];
    worker.terminalStatus =
      status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "failed";
    worker.report = trimReport(finalAgentMessage(turn) ?? "(the worker produced no final message)");
    // If completion races turn/interrupt's response, wait for success versus
    // rejection before publishing cancelled versus the actual terminal state.
    if (worker.cancellation !== "pending") {
      this.requestCleanup(worker, "archive");
      this.publishTerminal(worker);
    }
  }

  /** The app-server child died: running workers are gone, not resumable. */
  reset(): void {
    const now = this.effects.now();
    for (const worker of this.workers.values()) {
      if (!worker.taskSettled) {
        if (worker.status === "running") {
          worker.status = "lost";
          worker.finishedAt = now;
          worker.report = "lost with an app-server restart";
        } else if (worker.status === "cancelled") {
          worker.report = "cancelled before an app-server restart";
        }
        worker.taskSettled = true;
        this.effects.onWorkerUpdate?.(snapshot(worker));
        this.requestCleanup(worker, "archive");
      } else if (worker.terminalObserved && worker.cleanup.status === "idle") {
        // A completion can race an interrupt response that is then lost with
        // the child. The child exit retires live resources; retain/retry the
        // archival bookkeeping on the replacement app-server.
        this.requestCleanup(worker, "archive");
      }
    }
  }

  /** Running tasks and unconfirmed cleanup both make an account rotation unsafe. */
  hasUnfinishedWork(): boolean {
    return [...this.workers.values()].some(
      (worker) =>
        !worker.taskSettled ||
        worker.cancellation === "pending" ||
        worker.cleanup.status === "pending" ||
        worker.cleanup.status === "running",
    );
  }

  /** Every worker this run, for replaying state to a connecting client. */
  snapshots(): WorkerSnapshot[] {
    return [...this.workers.values()].map(snapshot);
  }

  private requestCleanup(worker: WorkerRecord, disposition: CleanupDisposition): void {
    if (worker.cleanup.status === "complete") return;
    worker.cleanup.disposition = disposition;
    if (worker.cleanup.status === "running" || worker.cleanup.status === "pending") return;
    worker.cleanup.status = "pending";
    this.runCleanup(worker);
  }

  private publishTerminal(worker: WorkerRecord): void {
    if (worker.terminalPublished || !worker.terminalStatus || worker.report === undefined) return;
    worker.terminalPublished = true;
    worker.status = worker.cancellation === "accepted" ? "cancelled" : worker.terminalStatus;
    worker.finishedAt ??= this.effects.now();
    this.effects.onWorkerUpdate?.(snapshot(worker));
    if (this.pushReports) {
      this.effects.reportToOrchestrator(
        [
          `<worker_report worker="${worker.id}" title="${worker.title}" status="${worker.status}">`,
          worker.report,
          "</worker_report>",
          "Automated worker report — not the user speaking. Integrate it; tell the user only what matters to them.",
        ].join("\n"),
      );
    }
    this.effects.onWorkSettled?.();
  }

  private runCleanup(worker: WorkerRecord): void {
    if (worker.cleanup.status !== "pending" || !worker.cleanup.disposition) return;
    const disposition = worker.cleanup.disposition;
    worker.cleanup.status = "running";
    const cleanup =
      disposition === "archive"
        ? this.effects.archiveWorker(worker.threadId)
        : this.effects.deleteWorker(worker.threadId);
    void cleanup.then(
      () => {
        worker.cleanup.status = "complete";
        this.effects.debug?.(`worker ${worker.id} thread ${worker.threadId} ${disposition}d`);
        this.effects.onWorkSettled?.();
      },
      (error) => {
        worker.cleanup.status = "pending";
        worker.cleanup.attempts++;
        const delay = Math.min(
          CLEANUP_RETRY_INITIAL_MS * 4 ** (worker.cleanup.attempts - 1),
          CLEANUP_RETRY_CAP_MS,
        );
        this.effects.debug?.(
          `worker ${worker.id} ${disposition} failed (${errorMessage(error)}); retrying in ${delay}ms`,
        );
        this.effects.scheduleCleanupRetry(() => this.runCleanup(worker), delay);
      },
    );
  }
}

/** Last agent message text in a completed turn's `items`, if any. */
export function finalAgentMessage(turn: Record<string, unknown>): string | null {
  const items = turn["items"];
  if (!Array.isArray(items)) return null;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index] as Record<string, unknown> | undefined;
    if (item?.["type"] === "agentMessage" && typeof item["text"] === "string") {
      return item["text"];
    }
  }
  return null;
}
