import type { Message } from "../types/message";
import { isSystemEventMessage } from "./system-events";

export type TranscriptEntry =
  | { kind: "message"; id: string; message: Message }
  | { kind: "activity"; id: string; messages: readonly Message[] };

// Never group across prose or an explicit system event. The first id stays
// stable when live items append, preserving disclosure state during polling.
export function groupTranscript(messages: readonly Message[]): TranscriptEntry[] {
  const entries: Array<
    | { kind: "message"; id: string; message: Message }
    | { kind: "activity"; id: string; messages: Message[] }
  > = [];
  for (const message of messages) {
    if (message.role === "user" || message.role === "assistant" || isSystemEventMessage(message)) {
      entries.push({ kind: "message", id: message.id, message });
      continue;
    }
    const previous = entries.at(-1);
    if (previous?.kind === "activity") {
      previous.messages.push(message);
    } else {
      entries.push({ kind: "activity", id: message.id, messages: [message] });
    }
  }
  return entries;
}

export function activitySummary(messages: readonly Message[]) {
  const kinds = new Map<string, number>();
  let errors = 0;
  let running = 0;
  let files = 0;
  for (const message of messages) {
    const name = message.toolActivity?.name ?? "Activity";
    kinds.set(name, (kinds.get(name) ?? 0) + 1);
    if (message.status === "error" || message.toolActivity?.state === "error") errors++;
    if (message.toolActivity?.state === "running" || message.status === "working") running++;
    files += message.fileChanges?.length ?? 0;
  }
  return { kinds: [...kinds], errors, running, files };
}
