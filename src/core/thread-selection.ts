import { ORCHESTRATOR_THREAD_SOURCE } from "./params.ts";

export interface SessionSelection {
  fresh?: boolean;
  continue?: boolean;
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

function listCandidate(value: unknown, workspace: string): value is NativeThread {
  if (!value || typeof value !== "object") return false;
  const t = value as NativeThread;
  return (
    typeof t.id === "string" &&
    t.id.length > 0 &&
    t.cwd === workspace &&
    !t.parentThreadId &&
    t.ephemeral !== true &&
    (t.threadSource == null || t.threadSource === ORCHESTRATOR_THREAD_SOURCE)
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
  if (selection.continue && (selection.fresh || selection.resume))
    throw new Error("--continue cannot be combined with --no-continue/--fresh or --resume");
  if (!selection.continue && !selection.resume) return null;
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = (await request("thread/list", {
      cwd: workspace,
      // Stock 0.153.3 classifies third-party app-server threads as `vscode`.
      // Keep `appServer` for native rows that use the protocol's dedicated kind.
      sourceKinds: ["appServer", "vscode"],
      modelProviders: [],
      archived: false,
      sortKey: "updated_at",
      sortDirection: "desc",
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    })) as { data?: unknown[]; nextCursor?: string | null };
    if (!page || !Array.isArray(page.data)) throw new Error("thread/list returned no thread list");
    for (const thread of page.data) {
      if (!listCandidate(thread, workspace) || (selection.resume && thread.id !== selection.resume))
        continue;
      // 0.153.3 can omit the persisted threadSource from thread/list rows even
      // though thread/read restores it. Verify ownership before selecting a
      // conversation so ordinary Codex/VS Code history remains excluded.
      const read = (await request("thread/read", {
        threadId: thread.id,
        includeTurns: false,
      })) as { thread?: unknown };
      if (eligible(read?.thread, workspace)) return thread.id;
      if (thread.threadSource === ORCHESTRATOR_THREAD_SOURCE)
        throw new Error(`Conversation ${thread.id} no longer matches this AgentVoice workspace`);
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
