import type { RawFrameEvent } from "./model.ts";
import {
  applyTranscriptFrame,
  createTranscript,
  hydrateTranscript,
  mergeTranscriptStates,
  type TranscriptState,
} from "./transcript.ts";

export interface TranscriptConnection {
  request(method: string, params: unknown): Promise<unknown>;
}

export class TranscriptSource {
  private readonly states = new Map<string, TranscriptState>();
  private readonly hydrated = new Set<string>();
  private readonly pending = new Map<string, Promise<TranscriptState>>();
  private retained: ReadonlySet<string> | null = null;

  constructor(private readonly connection: TranscriptConnection) {}

  get(threadId: string): TranscriptState | null {
    return this.states.get(threadId) ?? null;
  }

  record(event: RawFrameEvent): TranscriptState {
    const threadId = event.threadId;
    if (!threadId) return createTranscript("");
    if (this.retained && !this.retained.has(threadId)) return createTranscript(threadId);
    const current = this.states.get(threadId) ?? createTranscript(threadId);
    const next = applyTranscriptFrame(current, event);
    this.states.set(threadId, next);
    return next;
  }

  hydrate(threadId: string, force = false): Promise<TranscriptState> {
    if (!force && this.hydrated.has(threadId)) {
      return Promise.resolve(this.states.get(threadId) ?? createTranscript(threadId));
    }
    const existing = this.pending.get(threadId);
    if (existing) return existing;

    const pending = this.connection
      .request("thread/read", { threadId, includeTurns: true })
      .then((result) => hydrateTranscript(threadId, result))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes("includeTurns is unavailable before first user message") ||
          message.includes("not materialized yet")
        ) {
          return createTranscript(threadId);
        }
        throw error;
      })
      .then((historical) => {
        const live = this.states.get(threadId) ?? createTranscript(threadId);
        const merged = mergeTranscriptStates(historical, live);
        if (this.retained && !this.retained.has(threadId)) return merged;
        this.states.set(threadId, merged);
        this.hydrated.add(threadId);
        return merged;
      })
      .finally(() => {
        this.pending.delete(threadId);
      });
    this.pending.set(threadId, pending);
    return pending;
  }

  retain(threadIds: readonly string[]): void {
    const retained = new Set(threadIds);
    this.retained = retained;
    for (const threadId of this.states.keys()) {
      if (!retained.has(threadId)) this.states.delete(threadId);
    }
    for (const threadId of this.hydrated) {
      if (!retained.has(threadId)) this.hydrated.delete(threadId);
    }
  }
}
