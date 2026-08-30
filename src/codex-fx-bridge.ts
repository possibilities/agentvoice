import type { AppServerClient } from "./app-server.ts";
import type { EventJournal } from "./events.ts";
import {
  type DelegationHandoffPhase,
  type DelegationOrchestrator,
  FxDelegationController,
} from "./fx-delegation.ts";

interface SpeechAppender {
  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
}

interface SteeringAcknowledgement {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

/** Routes Codex V3 client delegations into Fx and returns speakable handoffs. */
export class CodexFxBridge {
  readonly fatal: Promise<never>;

  private readonly tasks = new Set<Promise<void>>();
  private readonly handoffIds = new Set<string>();
  private readonly steeringAcknowledgements = new Map<string, SteeringAcknowledgement>();
  private speechTail: Promise<void> = Promise.resolve();
  private rejectFatal: ((error: Error) => void) | null = null;
  private failure: Error | null = null;
  private closed = false;

  constructor(
    private readonly options: {
      appServer: SpeechAppender | AppServerClient;
      threadId: string;
      orchestrator: DelegationOrchestrator;
      journal: EventJournal;
    },
  ) {
    this.fatal = new Promise<never>((_resolve, reject) => {
      this.rejectFatal = reject;
    });
    void this.fatal.catch(() => {});
  }

  handleNotification(method: string, params: Record<string, unknown>): boolean {
    if (method !== "thread/realtime/itemAdded" || params["threadId"] !== this.options.threadId) {
      return false;
    }
    const item = record(params["item"]);
    if (item?.["type"] !== "handoff_request") return false;

    try {
      this.startDelegation(item);
    } catch (error) {
      this.fail(asError(error));
    }
    return true;
  }

  async drain(): Promise<void> {
    while (this.tasks.size > 0) await Promise.all([...this.tasks]);
    await this.speechTail;
    if (this.failure) throw this.failure;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.options.journal.record("bridge", "bridge.closed");
  }

  private startDelegation(item: Record<string, unknown>): void {
    if (this.closed) throw new Error("received a delegation after the Codex-Fx bridge closed");
    const handoffId = requiredString(item, "handoff_id");
    const itemId = requiredString(item, "item_id");
    const request = requiredString(item, "input_transcript").trim();
    if (request.length === 0) throw new Error(`handoff ${handoffId} had an empty input transcript`);
    if (this.handoffIds.has(handoffId)) {
      this.options.journal.record("bridge", "delegation.duplicate", { handoffId, itemId });
      return;
    }
    this.handoffIds.add(handoffId);
    this.options.journal.record("bridge", "delegation.forwarded", {
      handoffId,
      itemId,
      text: request,
      activeTranscript: Array.isArray(item["active_transcript"]) ? item["active_transcript"] : [],
    });

    // One lightweight controller per handoff lets every asynchronous telemetry
    // event retain its native realtime identity without shared mutable context.
    const controller = new FxDelegationController(this.options.orchestrator, {
      emit: async (type, data) => {
        if (type === "delegation.created" && data?.["disposition"] === "steering") {
          this.reserveSteeringAcknowledgement(handoffId);
        }
        this.options.journal.record(
          "bridge",
          type === "delegation.created" ? "delegation.admitted" : type,
          { ...data, handoffId, itemId },
        );
      },
    });

    let task: Promise<void>;
    task = controller
      .delegate(request, (message, phase) => this.appendSpeech(handoffId, message, phase))
      .catch((error) => {
        const failure = asError(error);
        this.fail(failure);
        throw failure;
      })
      .finally(() => {
        this.tasks.delete(task);
      });
    this.tasks.add(task);
    void task.catch(() => {});
  }

  private async appendSpeech(
    handoffId: string,
    text: string,
    phase: DelegationHandoffPhase,
  ): Promise<void> {
    // A turn can complete immediately after a steering admission. Delay
    // scheduling its result until every steering admission already visible to
    // the bridge has queued and completed its acknowledgement. Waiting before
    // chaining onto speechTail lets that progress append move ahead of the
    // result without deadlocking the serialized speech queue.
    if (phase === "result") {
      await Promise.all(
        [...this.steeringAcknowledgements.values()].map(
          (acknowledgement) => acknowledgement.promise,
        ),
      );
    }
    const append = this.speechTail.then(async () => {
      this.options.journal.record("bridge", "handoff.append.started", {
        handoffId,
        phase,
        text,
      });
      await this.options.appServer.request(
        "thread/realtime/appendSpeech",
        { threadId: this.options.threadId, text },
        30_000,
      );
      this.options.journal.record("bridge", "handoff.append.completed", {
        handoffId,
        phase,
      });
    });
    this.speechTail = append.catch(() => {});
    try {
      await append;
      if (phase === "progress") this.resolveSteeringAcknowledgement(handoffId);
    } catch (error) {
      if (phase === "progress") this.rejectSteeringAcknowledgement(handoffId, asError(error));
      throw error;
    }
  }

  private reserveSteeringAcknowledgement(handoffId: string): void {
    if (this.steeringAcknowledgements.has(handoffId)) return;
    let resolveAcknowledgement!: () => void;
    let rejectAcknowledgement!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveAcknowledgement = resolve;
      rejectAcknowledgement = reject;
    });
    void promise.catch(() => {});
    this.steeringAcknowledgements.set(handoffId, {
      promise,
      resolve: resolveAcknowledgement,
      reject: rejectAcknowledgement,
    });
  }

  private resolveSteeringAcknowledgement(handoffId: string): void {
    const acknowledgement = this.steeringAcknowledgements.get(handoffId);
    if (!acknowledgement) return;
    this.steeringAcknowledgements.delete(handoffId);
    acknowledgement.resolve();
  }

  private rejectSteeringAcknowledgement(handoffId: string, error: Error): void {
    const acknowledgement = this.steeringAcknowledgements.get(handoffId);
    if (!acknowledgement) return;
    this.steeringAcknowledgements.delete(handoffId);
    acknowledgement.reject(error);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const [handoffId] of this.steeringAcknowledgements) {
      this.rejectSteeringAcknowledgement(handoffId, error);
    }
    this.options.journal.record("bridge", "bridge.failed", { message: error.message });
    this.rejectFatal?.(error);
    this.rejectFatal = null;
  }
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`handoff request had no ${key}`);
  return field;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
