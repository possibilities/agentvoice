import type { Message } from "../types/message.ts";

export function isSystemEventMessage(message: Message): boolean {
  return message.role === "system" && message.nativeItemType !== undefined;
}

/** The native item carries identity only; do not invent a summary or token counts. */
export function contextCompactionMessage(completed: boolean): Omit<Message, "id"> {
  return {
    role: "system",
    status: completed ? "complete" : "working",
    content: completed
      ? "Older conversation context was summarized to make room for new work."
      : "Older conversation context is being summarized.",
    nativeItemType: "contextCompaction",
  };
}
