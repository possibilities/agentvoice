import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { stateDirectory } from "../paths.ts";
import { safeAncestors } from "../private-files.ts";
import { savedRecordings } from "../recording/store.ts";
import { recordedVoiceFrame } from "../recording/writer.ts";

export interface MessagePresence {
  hasMessages(): boolean;
  close(): void;
}

/** Read only until the first visible message; never retain conversation text. */
export class VoiceMessagePresence implements MessagePresence {
  private fd?: number;
  private offset = 0;
  private pending = Buffer.alloc(0);
  private header = false;
  private found = false;
  private readonly active = new Set<string>();
  private readonly identity: { dev: number; ino: number };

  constructor(
    private readonly path: string,
    private readonly workspace: string,
    private readonly threadId: string,
  ) {
    safeAncestors(dirname(path));
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        info.nlink !== 1 ||
        info.mode & 0o077
      )
        throw new Error("Unsafe voice recording");
      this.identity = info;
      this.fd = fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  hasMessages(): boolean {
    if (this.found || this.fd === undefined) return this.found;
    const info = statSync(this.path);
    if (info.dev !== this.identity.dev || info.ino !== this.identity.ino || info.size < this.offset)
      throw new Error("Voice recording changed; reopen the composition");
    const chunk = Buffer.alloc(64 * 1024);
    // Bound each poll so large saved recordings cannot block shutdown or layout changes.
    for (let reads = 0; reads < 64; reads++) {
      const count = readSync(this.fd, chunk, 0, chunk.length, this.offset);
      if (!count) break;
      this.offset += count;
      this.pending = Buffer.concat([this.pending, chunk.subarray(0, count)]);
      let newline = this.pending.indexOf(10);
      while (newline >= 0) {
        if (newline > 1 << 20) throw new Error("Voice recording line exceeds 1 MiB");
        const record = JSON.parse(this.pending.subarray(0, newline).toString("utf8"));
        this.pending = this.pending.subarray(newline + 1);
        if (this.accept(record)) {
          this.found = true;
          this.close();
          return true;
        }
        newline = this.pending.indexOf(10);
      }
      if (this.pending.length > 1 << 20) throw new Error("Voice recording line exceeds 1 MiB");
    }
    return false;
  }

  private accept(record: Record<string, unknown>): boolean {
    if (!this.header) {
      if (
        record["type"] !== "voice_transcript" ||
        record["format"] !== "agentvoice" ||
        record["workspace"] !== this.workspace ||
        record["threadId"] !== this.threadId
      )
        throw new Error("Voice recording identity mismatch");
      this.header = true;
      return false;
    }
    if (
      ["recording.started", "recording.gap", "recording.ended"].includes(String(record["type"]))
    ) {
      this.active.clear();
      return false;
    }
    const { observedAt: _, ...value } = record;
    const frame = recordedVoiceFrame.parse(value);
    if (frame.data.threadId !== this.threadId) throw new Error("Voice recording identity changed");
    const key = (id: string) => JSON.stringify([frame.data.instanceId, frame.data.generation, id]);
    if (!("item" in frame.data))
      return this.active.has(key(frame.data.itemId)) && frame.data.delta.trim().length > 0;
    const item = frame.data.item;
    if (item.type !== "transcriptSegment") {
      if (item.type !== "bemItemPromoted") this.active.clear();
      return false;
    }
    if (item.text.trim()) return true;
    if (frame.event === "voice.item.started") {
      if (this.active.size >= 100_000) throw new Error("Voice recording item limit exceeded");
      this.active.add(key(item.id));
    } else this.active.delete(key(item.id));
    return false;
  }

  close() {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
    this.pending = Buffer.alloc(0);
    this.active.clear();
  }
}

export function openVoiceMessages(workspace: string, threadId: string): MessagePresence {
  const recording = savedRecordings(stateDirectory(process.env, homedir()), workspace).find(
    (entry) => entry.threadId === threadId,
  );
  if (!recording) throw new Error("No voice recording for this call");
  return new VoiceMessagePresence(recording.path, workspace, threadId);
}
