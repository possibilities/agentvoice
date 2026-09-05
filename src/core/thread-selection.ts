import { ORCHESTRATOR_THREAD_SOURCE } from "./params.ts";

export interface SessionSelection {
  fresh?: boolean;
  resume?: string;
}

export type NativeRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export interface NativeThread {
  id: string;
  cwd: string;
  threadSource?: string;
  parentThreadId?: string | null;
  ephemeral?: boolean;
}

function eligible(value: unknown, workspace: string): value is NativeThread {
  if (!value || typeof value !== "object") return false;
  const t = value as NativeThread;
  return (
    typeof t.id === "string" &&
    t.id.length > 0 &&
    t.cwd === workspace &&
    t.threadSource === ORCHESTRATOR_THREAD_SOURCE &&
    !t.parentThreadId &&
    t.ephemeral !== true
  );
}

/** Selection is native history lookup, never a second session index. */
export async function selectThread(
  request: NativeRequest,
  workspace: string,
  selection: SessionSelection,
): Promise<string | null> {
  if (selection.fresh && selection.resume)
    throw new Error("--resume cannot be combined with --no-continue/--fresh");
  if (selection.fresh) return null;
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = (await request("thread/list", {
      cwd: workspace,
      sourceKinds: ["appServer"],
      modelProviders: [],
      archived: false,
      sortKey: "updated_at",
      sortDirection: "desc",
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    })) as { data?: unknown[]; nextCursor?: string | null };
    if (!page || !Array.isArray(page.data)) throw new Error("thread/list returned no thread list");
    for (const thread of page.data) {
      if (eligible(thread, workspace) && (!selection.resume || thread.id === selection.resume)) {
        return thread.id;
      }
    }
    if (page.nextCursor != null && (typeof page.nextCursor !== "string" || !page.nextCursor)) {
      throw new Error("thread/list returned an invalid cursor");
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor && cursors.has(cursor)) throw new Error("thread/list repeated a pagination cursor");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  if (selection.resume) {
    throw new Error(
      `Cannot resume ${selection.resume}: no unarchived AgentVoice conversation in ${workspace} matches that id`,
    );
  }
  return null;
}
