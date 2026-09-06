import { randomUUID } from "node:crypto";
import {
  type ConversationReadMethod,
  type ConversationReadParams,
  type ConversationReadResult,
  conversationId,
  conversationTurnSchema,
  MAX_HISTORY_BYTES,
  ObservationError,
  readResultSchema,
  safeContent,
  threadDetailsSchema,
} from "../events/conversation.ts";
import { readConversationItems } from "./conversation-items.ts";
import { ORCHESTRATOR_THREAD_SOURCE } from "./params.ts";

type Request = (method: string, params: unknown, timeout?: number) => Promise<unknown>;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
type Cursor = { native: string; scope: string; expires: number };

/** Reads native persisted data without resuming, loading, or submitting work on a thread. */
export class ConversationReader {
  private pending = 0;
  private readonly cursors = new Map<string, Cursor>();
  constructor(
    private readonly request: Request,
    private readonly workspace: string,
    private readonly revision: () => number,
    private readonly secrets: readonly string[] = [],
  ) {}

  async read(
    method: ConversationReadMethod,
    params: ConversationReadParams,
  ): Promise<ConversationReadResult> {
    if (this.pending >= 4) throw new ObservationError("busy");
    this.pending++;
    const deadline = Date.now() + 6_000;
    const revisionBefore = this.revision();
    const call: Request = async (method, params) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ObservationError("unavailable");
      try {
        return await this.request(method, params, Math.min(2_000, remaining));
      } catch (error) {
        if (record(error)["code"] === -32601) throw new ObservationError("unsupported");
        if (
          record(error)["code"] === -32600 &&
          ["thread/turns/list", "thread/items/list"].includes(method)
        )
          throw new ObservationError("history_unavailable");
        throw new ObservationError("unavailable");
      }
    };
    try {
      const metadata = new Map<string, Record<string, unknown>>();
      const get = async (id: string) => {
        if (metadata.has(id)) return metadata.get(id)!;
        const raw = record(
          record(await call("thread/read", { threadId: id, includeTurns: false }))["thread"],
        );
        if (raw["id"] !== id) throw new ObservationError("forbidden_thread");
        metadata.set(id, raw);
        return raw;
      };
      const root = await get(params.rootThreadId);
      if (
        root["cwd"] !== this.workspace ||
        root["threadSource"] !== ORCHESTRATOR_THREAD_SOURCE ||
        root["parentThreadId"] ||
        root["ephemeral"]
      )
        throw new ObservationError("forbidden_thread");
      const authorize = async (id: string) => {
        const seen = new Set<string>();
        let current = id;
        for (let depth = 0; depth < 32; depth++) {
          if (current === params.rootThreadId) return;
          if (seen.has(current)) break;
          seen.add(current);
          const row = await get(current);
          const parent = conversationId.safeParse(row["parentThreadId"]);
          if (!parent.success) break;
          current = parent.data;
        }
        throw new ObservationError("forbidden_thread");
      };
      const threadId = "threadId" in params ? params.threadId : undefined;
      if (threadId) await authorize(threadId);
      // Opaque cursors cannot be transplanted to another root, thread, turn, or ordering.
      const scope = JSON.stringify([
        method,
        params.rootThreadId,
        threadId,
        "turnId" in params ? params.turnId : null,
        "archived" in params ? params.archived : null,
        "sortDirection" in params ? params.sortDirection : null,
      ]);
      for (const [token, cursor] of this.cursors)
        if (cursor.expires <= Date.now()) this.cursors.delete(token);
      let nativeCursor: string | undefined;
      if ("cursor" in params && params.cursor) {
        const cursor = this.cursors.get(params.cursor);
        if (!cursor || cursor.scope !== scope) throw new ObservationError("cursor_expired");
        nativeCursor = cursor.native;
      }
      let data: unknown;
      let next: unknown = null;
      if (method === "conversation.thread.get" || method === "conversation.live.get") {
        data = threadDetailsSchema.parse(safeContent(await get(threadId!), this.secrets));
      } else {
        if (threadId && (await get(threadId))["ephemeral"] === true)
          throw new ObservationError("history_unavailable");
        const limit = "limit" in params ? params.limit : 20;
        const nativeParams: Record<string, unknown> = {
          limit,
          ...(nativeCursor ? { cursor: nativeCursor } : {}),
        };
        let nativeMethod: string;
        if (method === "conversation.threads.list") {
          nativeMethod = "thread/list";
          Object.assign(nativeParams, {
            ancestorThreadId: params.rootThreadId,
            archived: "archived" in params && params.archived,
            modelProviders: [],
            sourceKinds: [
              "subAgent",
              "subAgentThreadSpawn",
              "subAgentReview",
              "subAgentCompact",
              "subAgentOther",
            ],
            sortKey: "created_at",
            sortDirection: "desc",
          });
        } else {
          nativeMethod = "thread/turns/list";
          Object.assign(nativeParams, {
            threadId,
            sortDirection: "sortDirection" in params ? params.sortDirection : "desc",
          });
          if (method === "conversation.turns.list") nativeParams["itemsView"] = "notLoaded";
          if ("turnId" in params && params.turnId) nativeParams["turnId"] = params.turnId;
        }
        const response =
          method === "conversation.items.list"
            ? record(
                await readConversationItems(
                  call,
                  {
                    threadId: threadId!,
                    limit,
                    sortDirection: "sortDirection" in params ? params.sortDirection : "asc",
                    ...("turnId" in params && params.turnId ? { turnId: params.turnId } : {}),
                    ...(nativeCursor ? { cursor: nativeCursor } : {}),
                  },
                  this.secrets,
                ),
              )
            : record(await call(nativeMethod, nativeParams));
        const rows = response["data"];
        if (!Array.isArray(rows) || rows.length > limit) throw new ObservationError("unsupported");
        next = response["nextCursor"] ?? null;
        if (
          next !== null &&
          (typeof next !== "string" || next.length > 16384 || next === nativeCursor)
        )
          throw new ObservationError("unsupported");
        if (method === "conversation.threads.list") {
          data = [];
          for (const row of rows) {
            const id = conversationId.parse(record(row)["id"]);
            if (id === params.rootThreadId) throw new ObservationError("forbidden_thread");
            await authorize(id);
            (data as unknown[]).push(
              threadDetailsSchema.parse(safeContent(await get(id), this.secrets)),
            );
          }
        } else if (method === "conversation.turns.list") {
          data = rows.map((row) => safeContent(conversationTurnSchema.parse(row), this.secrets));
        } else {
          data = rows.map((row) => {
            const entry = record(row);
            const turnId = conversationId.parse(entry["turnId"]);
            if ("turnId" in params && params.turnId && params.turnId !== turnId)
              throw new ObservationError("unsupported");
            return { turnId, item: entry["item"] };
          });
        }
      }
      const revisionAfter = this.revision();
      const nextCursor = next === null ? null : randomUUID();
      const result = readResultSchema.parse({
        method,
        rootThreadId: params.rootThreadId,
        ...(threadId ? { threadId } : {}),
        revisionBefore,
        revisionAfter,
        changedDuringRead: revisionBefore !== revisionAfter,
        data,
        nextCursor,
      });
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_HISTORY_BYTES)
        throw new ObservationError("oversized");
      if (nextCursor) {
        if (this.cursors.size >= 256) this.cursors.delete(this.cursors.keys().next().value!);
        this.cursors.set(nextCursor, {
          native: next as string,
          scope,
          expires: Date.now() + 5 * 60_000,
        });
      }
      return result;
    } catch (error) {
      if (error instanceof ObservationError) throw error;
      throw new ObservationError("unsupported");
    } finally {
      this.pending--;
    }
  }
}
