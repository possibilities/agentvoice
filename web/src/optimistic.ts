import type { LocalImageAttachment } from "../../src/attachment/image-contract";
import type { TranscriptMessage } from "./transcript-ui/transcript/index.ts";
import type { AgentQueuedMessage, LiveView } from "./types.ts";

export type OptimisticSubmission = {
  id: string;
  viewId: string;
  text: string;
  images?: LocalImageAttachment[];
  action: "send" | "steer" | "queue";
  anchor?: string;
  state: "pending" | "accepted" | "unknown";
};

export function observed(view: LiveView, id: string) {
  return (
    view.agent.some((message) => message.id === `client:${id}` && message.status === "complete") ||
    view.agentControls?.queue.some((row) => row.id === id) === true
  );
}

/** Native identity, never text similarity, reconciles a submitted message. */
export function optimisticMessages(
  messages: TranscriptMessage[],
  submissions: OptimisticSubmission[],
): TranscriptMessage[] {
  const completed = new Set(
    messages.filter((message) => message.status === "complete").map((message) => message.id),
  );
  const pending = submissions.filter(
    (row) => row.action !== "queue" && !completed.has(`client:${row.id}`),
  );
  if (!pending.length) return messages;
  const pendingById = new Map(pending.map((row) => [`client:${row.id}`, row]));
  const localMessage = (row: OptimisticSubmission): TranscriptMessage => ({
    id: `client:${row.id}`,
    role: "user",
    content: row.text,
    status: row.state === "unknown" ? "error" : "working",
    ...(row.images?.length ? { pendingImageCount: row.images.length } : {}),
    deliveryStatus:
      row.state === "unknown"
        ? "Delivery unknown · check before resending"
        : row.state === "accepted"
          ? "Accepted · waiting for transcript"
          : row.action === "steer"
            ? "Steering…"
            : "Sending…",
  });
  // A native item can expose an exact client identity before its content settles.
  // Keep the stable local row at that position until the completed item replaces it.
  const projected = messages.map((message) => {
    const row = pendingById.get(message.id);
    return row && message.status !== "complete" ? localMessage(row) : message;
  });
  const ids = new Set(projected.map((message) => message.id));
  const anchors = new Set([...ids, ...pending.map((row) => `client:${row.id}`)]);
  const insertions = new Map<string | undefined, TranscriptMessage[]>();
  for (const row of pending) {
    if (ids.has(`client:${row.id}`)) continue;
    // A pruned/reverted anchor cannot conceal an unresolved local submission.
    const anchor = row.anchor && anchors.has(row.anchor) ? row.anchor : projected.at(-1)?.id;
    const insertion = insertions.get(anchor) ?? [];
    insertion.push(localMessage(row));
    insertions.set(anchor, insertion);
  }
  const expand = (rows: TranscriptMessage[]): TranscriptMessage[] =>
    rows.flatMap((message) => [message, ...expand(insertions.get(message.id) ?? [])]);
  if (!projected.length) return expand(insertions.get(undefined) ?? []);
  return expand(projected);
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
      images: row.images,
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
