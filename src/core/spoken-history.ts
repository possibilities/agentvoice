import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { AppServerError } from "./attach.ts";

export interface SpokenItem {
  role: "user" | "assistant";
  text: string;
}
export interface SpokenHistory {
  items: SpokenItem[];
  truncated: boolean;
}
type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;

// Leave space for the developer boundary within native v3's 128 items / 8192 tokens.
export const SPOKEN_HISTORY_MAX_ITEMS = 64;
export const SPOKEN_HISTORY_MAX_BYTES = 24_000;
const ROLLOUT_TAIL_BYTES = 8 * 1024 * 1024;
const ROLLOUT_HEADER_BYTES = 1024 * 1024;
const MAX_TIMELINE_PAGES = 32;

function segment(value: unknown): SpokenItem | undefined {
  const item = object(value);
  if (!item || !["transcriptSegment", "transcript_segment"].includes(String(item["type"])))
    return undefined;
  if ((item["role"] !== "user" && item["role"] !== "assistant") || typeof item["text"] !== "string")
    throw new Error("Invalid native speech transcript");
  return item["text"].length > 0 ? { role: item["role"], text: item["text"] } : undefined;
}

/** Keep a contiguous recent tail, preserving text and chronological order. */
export function boundSpokenHistory(items: readonly SpokenItem[]): SpokenHistory {
  const tail: SpokenItem[] = [];
  let bytes = 0;
  let truncated = false;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    const size = Buffer.byteLength(item.text);
    if (tail.length === SPOKEN_HISTORY_MAX_ITEMS || bytes + size > SPOKEN_HISTORY_MAX_BYTES) {
      // Never skip a large recent utterance and then present an older one as the last reply.
      if (tail.length === 0) throw new Error("Last spoken segment exceeds the replay limit");
      truncated = true;
      break;
    }
    tail.push(item);
    bytes += size;
  }
  return { items: tail.reverse(), truncated };
}

/** Native owns persistence. The fallback reads only a verified, flat local rollout. */
export class SpokenHistoryReader {
  constructor(private readonly request: Request) {}

  async read(threadId: string, workspace: string, current = () => true): Promise<SpokenHistory> {
    try {
      try {
        return await this.timeline(threadId, current);
      } catch (error) {
        if (!(error instanceof AppServerError) || error.code !== -32601) throw error;
        // Legacy threads do not support timeline reads in stock 0.153.4.
        // Retry on later reads: a later Fresh may use paginated native history.
      }
      if (!current()) return { items: [], truncated: false };
      const result = object(await this.request("thread/read", { threadId, includeTurns: false }));
      if (!current()) return { items: [], truncated: false };
      const thread = object(result?.["thread"]);
      if (
        thread?.["id"] !== threadId ||
        thread["cwd"] !== workspace ||
        thread["threadSource"] !== "agentvoice-orchestrator" ||
        thread["parentThreadId"] ||
        thread["ephemeral"] === true
      )
        throw new Error("Native history no longer matches the selected AgentVoice conversation");
      return await readRollout(thread["path"], threadId, workspace);
    } catch (error) {
      throw new Error(
        `Cannot restore spoken history: ${error instanceof Error ? error.message : String(error)}. Set voice.replay-spoken-history=false to reconnect without it.`,
      );
    }
  }

  private async timeline(threadId: string, current: () => boolean): Promise<SpokenHistory> {
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let items: SpokenItem[] = [];
    let newestPosition = Number.POSITIVE_INFINITY;
    for (let pageNumber = 0; pageNumber < MAX_TIMELINE_PAGES && current(); pageNumber++) {
      const page = object(
        await this.request("thread/timeline/list", {
          threadId,
          limit: 256,
          ...(cursor ? { cursor } : {}),
        }),
      );
      if (!current()) return { items: [], truncated: false };
      if (!Array.isArray(page?.["data"])) throw new Error("Native timeline returned no data array");
      const older: SpokenItem[] = [];
      let position = -1;
      for (const value of page["data"]) {
        const entry = object(value);
        const next = entry?.["position"];
        if (
          !Number.isSafeInteger(next) ||
          (next as number) < 0 ||
          (next as number) < position ||
          (next as number) > newestPosition
        )
          throw new Error("Native timeline returned invalid history order");
        position = next as number;
        if (entry?.["type"] === "realtime") {
          const speech = segment(entry["item"]);
          if (speech) older.push(speech);
        }
      }
      if (page["data"].length > 0)
        newestPosition = (page["data"][0] as ObjectValue)["position"] as number;
      items = [...older, ...items];
      const bounded = boundSpokenHistory(items);
      const next = page["nextCursor"];
      if (next != null && (typeof next !== "string" || !next || cursors.has(next)))
        throw new Error("Native timeline returned an invalid or repeated cursor");
      if (next == null || bounded.truncated || items.length >= SPOKEN_HISTORY_MAX_ITEMS)
        return { items: bounded.items, truncated: bounded.truncated || next != null };
      cursors.add(next as string);
      cursor = next as string;
    }
    if (!current()) return { items: [], truncated: false };
    const bounded = boundSpokenHistory(items);
    return { items: bounded.items, truncated: true };
  }
}

async function readRollout(
  path: unknown,
  threadId: string,
  workspace: string,
): Promise<SpokenHistory> {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    !basename(path).startsWith("rollout-") ||
    !basename(path).endsWith(`-${threadId}.jsonl`)
  )
    throw new Error("Native conversation has no supported local JSONL rollout");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Native rollout is not a regular file");
    const header = Buffer.alloc(Math.min(stat.size, ROLLOUT_HEADER_BYTES));
    const { bytesRead: headerBytes } = await file.read(header, 0, header.length, 0);
    const newline = header.subarray(0, headerBytes).indexOf(10);
    if (newline < 0) throw new Error("Native rollout has no complete metadata record");
    const meta = parseRecord(header.subarray(0, newline).toString("utf8"));
    const identity = object(meta?.["payload"]);
    if (
      meta?.["type"] !== "session_meta" ||
      identity?.["id"] !== threadId ||
      identity["cwd"] !== workspace
    )
      throw new Error("Native rollout identity does not match the selected conversation");
    if (identity["history_base"] != null || identity["forked_from_id"] != null)
      throw new Error("Shared or forked rollout history requires native timeline support");
    const start = Math.max(0, stat.size - ROLLOUT_TAIL_BYTES);
    const tail = Buffer.alloc(stat.size - start);
    const { bytesRead } = await file.read(tail, 0, tail.length, start);
    const end = tail.subarray(0, bytesRead).lastIndexOf(10);
    const begin = start === 0 ? 0 : tail.indexOf(10) + 1;
    if (end < begin) throw new Error("Native rollout tail has no complete records");
    const items: SpokenItem[] = [];
    for (const line of tail.subarray(begin, end).toString("utf8").split("\n")) {
      if (!line) continue;
      const record = parseRecord(line);
      const payload = object(record?.["payload"]);
      if (record?.["type"] === "event_msg" && payload?.["type"] === "thread_rolled_back")
        throw new Error("Rolled-back history requires native timeline support");
      if (record?.["type"] !== "realtime_item") continue;
      const speech = segment(payload);
      if (speech) items.push(speech);
    }
    const bounded = boundSpokenHistory(items);
    return { items: bounded.items, truncated: start > 0 || bounded.truncated };
  } finally {
    await file.close();
  }
}

function parseRecord(line: string): ObjectValue {
  try {
    const record = object(JSON.parse(line));
    if (!record) throw new Error("Expected a native record");
    return record;
  } catch {
    // Parser messages can quote private prompt/tool text from a damaged record.
    throw new Error("Malformed native rollout record");
  }
}
