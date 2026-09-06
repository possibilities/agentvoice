import { createHash } from "node:crypto";
import { conversationId, ObservationError, projectItem } from "../events/conversation.ts";

type Request = (method: string, params: unknown) => Promise<unknown>;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Stock 0.153.4 exposes items through full turn pages; thread/items/list is a stub. */
export async function readConversationItems(
  request: Request,
  params: {
    threadId: string;
    turnId?: string;
    limit: number;
    sortDirection: "asc" | "desc";
    cursor?: string;
  },
  secrets: readonly string[],
) {
  const anchor = params.cursor
    ? (JSON.parse(params.cursor) as { cursor?: string; offset: number; digest?: string })
    : { offset: 0, cursor: undefined, digest: undefined };
  const page = record(
    await request("thread/turns/list", {
      threadId: params.threadId,
      limit: 1,
      itemsView: "full",
      sortDirection: params.sortDirection,
      ...(anchor.cursor ? { cursor: anchor.cursor } : {}),
    }),
  );
  if (!Array.isArray(page["data"]) || page["data"].length > 1)
    throw new ObservationError("unsupported");
  const next = page["nextCursor"] ?? null;
  if (next !== null && (typeof next !== "string" || next.length > 8192 || next === anchor.cursor))
    throw new ObservationError("unsupported");
  const continueAtNextTurn = () =>
    next === null ? null : JSON.stringify({ cursor: next, offset: 0 });
  const turn = record(page["data"][0]);
  if (page["data"].length === 0) return { data: [], nextCursor: continueAtNextTurn() };
  const turnId = conversationId.parse(turn["id"]);
  if (params.turnId && turnId !== params.turnId) {
    if (anchor.offset) throw new ObservationError("cursor_expired");
    return { data: [], nextCursor: continueAtNextTurn() };
  }
  const rawItems = turn["items"];
  if (!Array.isArray(rawItems) || turn["itemsView"] !== "full")
    throw new ObservationError("unsupported");
  if (rawItems.length > 4096 || Buffer.byteLength(JSON.stringify(rawItems)) > 16 * 1024 * 1024)
    throw new ObservationError("oversized");
  const digest = createHash("sha256")
    .update(JSON.stringify({ turnId, items: rawItems }))
    .digest("hex");
  if (anchor.digest && anchor.digest !== digest) throw new ObservationError("cursor_expired");
  const items = params.sortDirection === "desc" ? [...rawItems].reverse() : rawItems;
  const selected = items.slice(anchor.offset, anchor.offset + params.limit);
  const offset = anchor.offset + selected.length;
  return {
    data: selected.map((item) => ({ turnId, item: projectItem(item, secrets) })),
    nextCursor:
      offset < items.length
        ? JSON.stringify({ cursor: anchor.cursor, offset, digest })
        : params.turnId
          ? null
          : continueAtNextTurn(),
  };
}
