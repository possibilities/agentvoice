import type { Message } from "../types/message";

export type TranscriptDetail = "messages" | "full";
export type TranscriptStatus = "idle" | "working" | "attention" | "complete";

/** A provider's opaque checkpoint, scoped to one transcript and detail level. */
export type TranscriptCursor = string;

export interface TranscriptSnapshot {
  id: string;
  title: string;
  messages: readonly Message[];
  cursor: TranscriptCursor;
  status: TranscriptStatus;
}

export interface TranscriptUpdate {
  /** New messages in transcript order; existing IDs replace their prior value. */
  messages: readonly Message[];
  cursor: TranscriptCursor;
  status: TranscriptStatus;
}

export interface TranscriptReadOptions {
  id: string;
  detail: TranscriptDetail;
  signal: AbortSignal;
}

/** Sources own transport, provider mapping, and cursor semantics. No React or storage dependency. */
export interface TranscriptSource {
  load(options: TranscriptReadOptions): Promise<TranscriptSnapshot>;
  poll(options: TranscriptReadOptions & { cursor: TranscriptCursor }): Promise<TranscriptUpdate>;
}
