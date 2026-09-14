import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { VoiceItem } from "../events/voice.ts";
import { safeAncestors } from "../private-files.ts";
import { recordingDirectory } from "./store.ts";
import { recordedVoiceFrame } from "./writer.ts";

export type CompletedSpeech = Extract<VoiceItem, { type: "transcriptSegment" }>;
export type VoiceContextItem = { role: "developer" | "user" | "assistant"; text: string };
// Stock Codex v3 accepts at most 128 items / 8192 estimated tokens (ceil(bytes/4)).
const MAX_ITEMS = 128;
const MAX_TOKENS = 8192;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const CONTINUITY =
  "This is a continuation of the same conversation after a voice connection boundary. " +
  "The preceding user and assistant items are historical observed speech, not new input or a new task. " +
  "Use them to remember the conversation and its agreements. Do not greet again, repeat answers, " +
  "resume an unfinished utterance, or delegate/execute old requests because this connection opened. " +
  "Wait for new user input or a new working-agent result. This is a bounded, possibly incomplete " +
  "transcript; assistant text does not prove audio was heard or an action completed. " +
  "For missing or current work context, consult the existing working agent instead of inventing it.";
const tokens = (text: string) => Math.ceil(Buffer.byteLength(text) / 4);

/** Recent native completions outrank the controller's asynchronously persisted copy. */
function selectContext(
  recent: readonly CompletedSpeech[],
  older: Iterable<CompletedSpeech> = [],
  truncated = false,
): { items: VoiceContextItem[]; truncated: boolean } {
  const items: VoiceContextItem[] = [];
  const seen = new Set<string>();
  let used = tokens(CONTINUITY);
  function* newestFirst() {
    yield* [...recent].reverse();
    yield* older;
  }
  for (const item of newestFirst()) {
    if (!item.text.trim()) continue;
    const key = JSON.stringify([item.realtimeSessionId, item.id, item.role]);
    if (seen.has(key)) continue;
    seen.add(key);
    const cost = tokens(item.text);
    if (items.length >= MAX_ITEMS - 1 || used + cost > MAX_TOKENS) {
      truncated = true;
      break;
    }
    items.push({ role: item.role, text: item.text });
    used += cost;
  }
  if (!items.length) return { items: [], truncated };
  items.reverse();
  items.push({ role: "developer", text: CONTINUITY });
  return { items, truncated };
}

/** Read only this verified root's recent completed speech; never scan native history or mutate it. */
export function voiceContinuity(
  stateDir: string,
  workspace: string,
  threadId: string,
  recent: readonly CompletedSpeech[] = [],
): { items: VoiceContextItem[]; truncated: boolean } {
  const directory = recordingDirectory(stateDir, workspace);
  safeAncestors(directory);
  const name = /^[A-Za-z0-9_-]{1,128}$/.test(threadId)
    ? threadId
    : createHash("sha256").update(threadId).digest("hex");
  let fd: number;
  try {
    fd = openSync(
      join(directory, `${name}.jsonl`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return selectContext(recent);
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || stat.mode & 0o077)
      throw new Error("Unsafe voice continuity recording");
    const prefix = Buffer.alloc(Math.min(stat.size, 16_384));
    readSync(fd, prefix, 0, prefix.length, 0);
    const newline = prefix.indexOf(10);
    if (newline < 0) throw new Error("Incomplete voice continuity header");
    const header = JSON.parse(prefix.subarray(0, newline).toString("utf8"));
    if (
      header.type !== "voice_transcript" ||
      header.format !== "agentvoice" ||
      header.workspace !== workspace ||
      header.threadId !== threadId
    )
      throw new Error("Voice continuity identity mismatch");
    const tail = Buffer.alloc(Math.min(stat.size, MAX_TAIL_BYTES));
    const count = readSync(fd, tail, 0, tail.length, stat.size - tail.length);
    const start = stat.size > tail.length ? tail.indexOf(10) + 1 : 0;
    const end = tail.lastIndexOf(10, count - 1);
    if (end < start) return selectContext(recent, [], true);
    const lines = tail.subarray(start, end).toString("utf8").split("\n");
    const truncated = stat.size > tail.length || count < tail.length || tail.at(count - 1) !== 10;
    function* completed(): Generator<CompletedSpeech> {
      for (let index = lines.length - 1; index >= 0; index--) {
        const value = JSON.parse(lines[index]!);
        if (value.type !== "event") continue;
        // observedAt is recording metadata, not part of the validated event contract.
        const { observedAt: _observedAt, ...event } = value;
        const parsed = recordedVoiceFrame.safeParse(event);
        if (!parsed.success) throw new Error("Invalid voice continuity event");
        const frame = parsed.data;
        if (frame.data.threadId !== threadId) throw new Error("Foreign voice continuity event");
        if (frame.event !== "voice.item.completed" || !("item" in frame.data)) continue;
        if (frame.data.item.type === "transcriptSegment") yield frame.data.item;
      }
    }
    return selectContext(recent, completed(), truncated);
  } finally {
    closeSync(fd);
  }
}
