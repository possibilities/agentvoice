import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { observeFrontend } from "../frontend/observer.ts";
import { type FrontendObservation, frontendSocketPath } from "../frontend/protocol.ts";
import { safeAncestors } from "../private-files.ts";

export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

/** One opened inode, complete bounded records only; never follow replacement files. */
export class VoiceRecordingTail {
  private readonly fd: number;
  private readonly initialSize: number;
  private readonly inode: number;
  private readonly device: number;
  private offset = 0;
  private pending = Buffer.alloc(0);
  private header = false;
  constructor(
    private readonly path: string,
    private readonly selected: { workspace: string; threadId: string },
  ) {
    safeAncestors(dirname(path));
    this.fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(this.fd);
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.nlink !== 1 ||
      info.mode & 0o077
    ) {
      closeSync(this.fd);
      throw new Error("Unsafe voice transcript");
    }
    this.inode = info.ino;
    this.device = info.dev;
    this.initialSize = info.size;
  }
  get initialHistoryLoaded(): boolean {
    return this.offset >= this.initialSize;
  }
  read(): string[] {
    const info = lstatSync(this.path);
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.nlink !== 1 ||
      info.mode & 0o077 ||
      info.ino !== this.inode ||
      info.dev !== this.device ||
      info.size < this.offset
    )
      throw new Error("Voice transcript was replaced or truncated");
    if (info.size > MAX_TRANSCRIPT_BYTES)
      throw new Error("Voice transcript exceeds the viewer limit");
    const chunk = Buffer.alloc(Math.min(64 * 1024, info.size - this.offset));
    const count = readSync(this.fd, chunk, 0, chunk.length, this.offset);
    this.offset += count;
    this.pending = Buffer.concat([this.pending, chunk.subarray(0, count)]);
    const lines: string[] = [];
    for (;;) {
      const newline = this.pending.indexOf(10);
      if (newline < 0) break;
      if (newline > 1024 * 1024) throw new Error("Voice record exceeds the viewer limit");
      const line = new TextDecoder("utf-8", { fatal: true }).decode(
        this.pending.subarray(0, newline),
      );
      const record = JSON.parse(line) as Record<string, unknown>;
      if (!record || typeof record !== "object" || Array.isArray(record))
        throw new Error("Invalid voice record");
      if (!this.header) {
        if (
          record["type"] !== "voice_transcript" ||
          record["format"] !== "agentvoice" ||
          record["workspace"] !== this.selected.workspace ||
          record["threadId"] !== this.selected.threadId
        )
          throw new Error("Voice transcript identity changed");
        this.header = true;
      }
      lines.push(line);
      this.pending = this.pending.subarray(newline + 1);
    }
    if (this.pending.length > 1024 * 1024) throw new Error("Voice record exceeds the viewer limit");
    return lines;
  }
  close() {
    closeSync(this.fd);
  }
}

export async function observeAttachmentServer(
  stateDir: string,
  workspace?: string,
  fallbackToDefault = true,
) {
  let path = frontendSocketPath(stateDir, workspace);
  if (fallbackToDefault && workspace && !lstatSync(path, { throwIfNoEntry: false }))
    path = frontendSocketPath(stateDir);
  let latest: FrontendObservation | undefined;
  const observation = await observeFrontend(path, (value) => {
    latest = value;
  });
  latest ??= observation.initial;
  return { ...observation, latest: () => latest! };
}
