import type { TranscriptMessage } from "@agentchats/transcript";
import type { AgentQueuedMessage, LiveView } from "./types.ts";

export type OptimisticSubmission = {
  id: string;
  viewId: string;
  text: string;
  action: "send" | "steer" | "queue";
  anchor?: string;
  state: "pending" | "accepted" | "unknown";
};

export function observed(view: LiveView, id: string) {
  return (
    view.agent.some((message) => message.id === `client:${id}`) ||
    view.agentControls?.queue.some((row) => row.id === id) === true
  );
}

/** Native identity, never text similarity, reconciles a submitted message. */
export function optimisticMessages(
  messages: TranscriptMessage[],
  submissions: OptimisticSubmission[],
): TranscriptMessage[] {
  const ids = new Set(messages.map((message) => message.id));
  const pending = submissions.filter(
    (row) => row.action !== "queue" && !ids.has(`client:${row.id}`),
  );
  if (!pending.length) return messages;
  const anchors = new Set([...ids, ...pending.map((row) => `client:${row.id}`)]);
  const insertions = new Map<string | undefined, TranscriptMessage[]>();
  for (const row of pending) {
    // A pruned/reverted anchor cannot conceal an unresolved local submission.
    const anchor = row.anchor && anchors.has(row.anchor) ? row.anchor : messages.at(-1)?.id;
    const insertion = insertions.get(anchor) ?? [];
    insertion.push({
      id: `client:${row.id}`,
      role: "user",
      content: row.text,
      status: row.state === "unknown" ? "error" : "working",
      deliveryStatus:
        row.state === "unknown"
          ? "Delivery unknown · check before resending"
          : row.state === "accepted"
            ? "Accepted · waiting for transcript"
            : row.action === "steer"
              ? "Steering…"
              : "Sending…",
    });
    insertions.set(anchor, insertion);
  }
  const expand = (rows: TranscriptMessage[]): TranscriptMessage[] =>
    rows.flatMap((message) => [message, ...expand(insertions.get(message.id) ?? [])]);
  if (!messages.length) return expand(insertions.get(undefined) ?? []);
  return expand(messages);
}

export function optimisticQueue(
  queue: AgentQueuedMessage[],
  submissions: OptimisticSubmission[],
  messages: TranscriptMessage[],
): AgentQueuedMessage[] {
  const known = new Set([
    ...queue.map((row) => row.id),
    ...messages.map((message) => message.id.replace(/^client:/, "")),
  ]);
  const additions = submissions.filter((row) => row.action === "queue" && !known.has(row.id));
  if (!additions.length) return queue;
  return [
    ...queue,
    ...additions.map((row) => ({
      id: row.id,
      text: row.text,
      pausedReason:
        row.state === "unknown"
          ? "Queue delivery unknown. Check before resending."
          : row.state === "accepted"
            ? "Queued · waiting for confirmation"
            : "Queueing…",
      canSteer: false,
      canResume: false,
      disabled: true,
    })),
  ];
}
