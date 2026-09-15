import type { Message } from "../types/message";
import type { TranscriptSnapshot, TranscriptUpdate } from "./types";

/** Preserve order and stable IDs, including in-place streaming revisions. Never mutate input. */
export function mergeTranscript(
  snapshot: TranscriptSnapshot,
  update: TranscriptUpdate,
): TranscriptSnapshot {
  if (!update.messages.length) {
    return snapshot.cursor === update.cursor && snapshot.status === update.status
      ? snapshot
      : { ...snapshot, cursor: update.cursor, status: update.status };
  }
  let messages: Message[] | undefined;
  const positions = new Map(snapshot.messages.map((message, index) => [message.id, index]));
  for (const message of update.messages) {
    const position = positions.get(message.id);
    if (position === undefined) {
      messages ??= [...snapshot.messages];
      positions.set(message.id, messages.length);
      messages.push(message);
    } else if ((messages ?? snapshot.messages)[position] !== message) {
      messages ??= [...snapshot.messages];
      messages[position] = message;
    }
  }
  if (!messages && snapshot.cursor === update.cursor && snapshot.status === update.status)
    return snapshot;
  return { ...snapshot, ...update, messages: messages ?? snapshot.messages };
}
