import {
  conversationId,
  MAX_HISTORY_BYTES,
  ObservationError,
  projectItem,
} from "../events/conversation.ts";

type Request = (method: string, params: unknown) => Promise<unknown>;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Page native items individually so one large historical turn cannot monopolize the shared socket. */
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
  let cursor = params.cursor;
  const selected: { turnId: string; item: ReturnType<typeof projectItem> }[] = [];
  let bytes = 0;
  while (selected.length < params.limit) {
    const page = record(
      await request("thread/items/list", {
        threadId: params.threadId,
        limit: 1,
        sortDirection: params.sortDirection,
        ...(params.turnId ? { turnId: params.turnId } : {}),
        ...(cursor ? { cursor } : {}),
      }),
    );
    const rows = page["data"];
    if (!Array.isArray(rows) || rows.length > 1) throw new ObservationError("unsupported");
    const next = page["nextCursor"] ?? null;
    if (next !== null && (typeof next !== "string" || next.length > 8192 || next === cursor))
      throw new ObservationError("unsupported");
    if (rows.length === 0) {
      if (next !== null) throw new ObservationError("unsupported");
      return { data: selected, nextCursor: null };
    }
    const nativeEntry = record(rows[0]);
    const turnId = conversationId.parse(nativeEntry["turnId"]);
    if (params.turnId && turnId !== params.turnId) throw new ObservationError("unsupported");
    const entry = { turnId, item: projectItem(nativeEntry["item"], secrets) };
    const entryBytes = Buffer.byteLength(JSON.stringify(entry));
    if (selected.length > 0 && bytes + entryBytes > MAX_HISTORY_BYTES - 16 * 1024) {
      if (!cursor) throw new ObservationError("unsupported");
      return { data: selected, nextCursor: cursor };
    }
    selected.push(entry);
    bytes += entryBytes;
    if (next === null) return { data: selected, nextCursor: null };
    cursor = next;
  }
  return { data: selected, nextCursor: cursor ?? null };
}
