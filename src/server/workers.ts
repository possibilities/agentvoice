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
 * learns that from its next check or dispatch, not from a ghost report.
 */

import type { WorkerSnapshot } from "../protocol.ts";

export type WorkerStatus = WorkerSnapshot["status"];

export interface WorkerRecord {
  /** Short speakable handle: w1, w2, … — never a thread id. */
  id: string;
  threadId: string;
  turnId: string;
  title: string;
  brief: string;
  status: WorkerStatus;
  startedAt: number;
  finishedAt?: number;
  /** Final agent message of the worker's turn, trimmed for the report. */
  report?: string;
}

export interface WorkerEffects {
  /** thread/start + turn/start for a fresh worker; resolves once both landed. */
  startWorker(brief: string): Promise<{ threadId: string; turnId: string }>;
  /** turn/interrupt on a running worker's thread. */
  interruptWorker(threadId: string, turnId: string): Promise<void>;
  /** Start the report turn on the orchestrator's thread; never awaited by callers. */
  reportToOrchestrator(text: string): void;
  /** A worker changed state — the client-facing progress feed. */
  onWorkerUpdate?(worker: WorkerSnapshot): void;
  now(): number;
  debug?(line: string): void;
}

/**
 * Every tool answer is a DynamicToolCallResponse:
 * `{ contentItems: [{ type: "inputText", text }], success }` — typed as the
 * open record the JSON-RPC response layer carries.
 */
type ToolResponse = Record<string, unknown>;

/** Wire specs for `thread/start.dynamicTools` (0.147 DynamicToolFunctionSpec). */
export const DISPATCH_TOOLS: ReadonlyArray<Record<string, unknown>> = [
  {
    type: "function",
    name: "dispatch_worker",
    description:
      "Run asynchronous work as a separate worker thread with its own context. " +
      "Give a crisp, self-contained brief: what to do, where, what done looks " +
      "like, and where to write results. Returns a worker handle immediately; " +
      "a worker report arrives as a later message when it finishes, so do not " +
      "wait or poll — keep the conversation going.",
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

/** Keeps a worker's final message from flooding the orchestrator's context. */
const REPORT_LIMIT_CHARS = 4_000;

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
  private readonly workers = new Map<string, WorkerRecord>();
  private nextWorker = 1;

  constructor(effects: WorkerEffects) {
    this.effects = effects;
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
    try {
      const { threadId, turnId } = await this.effects.startWorker(brief);
      this.workers.set(id, {
        id,
        threadId,
        turnId,
        title,
        brief,
        status: "running",
        startedAt: this.effects.now(),
      });
      this.effects.debug?.(`worker ${id} dispatched on thread ${threadId}`);
      const record = this.workers.get(id);
      if (record) this.effects.onWorkerUpdate?.(snapshot(record));
      return ok(
        `${id} "${title}" is running. Its report will arrive as a message when it finishes — continue the conversation, don't wait.`,
      );
    } catch (error) {
      // The id is not reused: a racing dispatch may already hold the next one.
      return refuse(`dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
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
    try {
      await this.effects.interruptWorker(worker.threadId, worker.turnId);
      worker.status = "cancelled";
      worker.finishedAt = this.effects.now();
      this.effects.onWorkerUpdate?.(snapshot(worker));
      return ok(`${worker.id} "${worker.title}" cancelled`);
    } catch (error) {
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
    if (worker?.status !== "running") return;

    const status = turn["status"];
    worker.status =
      status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "failed";
    worker.finishedAt = this.effects.now();
    worker.report = trimReport(finalAgentMessage(turn) ?? "(the worker produced no final message)");
    this.effects.onWorkerUpdate?.(snapshot(worker));

    this.effects.reportToOrchestrator(
      [
        `<worker_report worker="${worker.id}" title="${worker.title}" status="${worker.status}">`,
        worker.report,
        "</worker_report>",
        "Automated worker report — not the user speaking. Integrate it; tell the user only what matters to them.",
      ].join("\n"),
    );
  }

  /** The app-server child died: running workers are gone, not resumable. */
  reset(): void {
    const now = this.effects.now();
    for (const worker of this.workers.values()) {
      if (worker.status === "running") {
        worker.status = "lost";
        worker.finishedAt = now;
        worker.report = "lost with an app-server restart";
        this.effects.onWorkerUpdate?.(snapshot(worker));
      }
    }
  }

  /** Every worker this run, for replaying state to a connecting client. */
  snapshots(): WorkerSnapshot[] {
    return [...this.workers.values()].map(snapshot);
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
