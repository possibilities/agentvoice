import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { safeAncestors } from "../private-files.ts";

export function recordingDirectory(stateDir: string, workspace: string): string {
  return join(stateDir, "voice", createHash("sha256").update(workspace).digest("hex"));
}
export type SavedRecording = {
  path: string;
  threadId: string;
  updatedAt: string;
  interrupted: boolean;
};

/** Only inspect bounded headers/tails; transcript size never determines discovery memory. */
export function savedRecordings(stateDir: string, workspace: string): SavedRecording[] {
  const directory = recordingDirectory(stateDir, workspace);
  safeAncestors(directory);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const results: SavedRecording[] = [];
  for (const name of names) {
    if (!/^[A-Za-z0-9_-]{1,128}\.jsonl$/.test(name)) continue;
    const path = join(directory, name);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        info.nlink !== 1 ||
        info.mode & 0o077
      )
        throw new Error(`Unsafe voice recording: ${path}`);
      const prefix = Buffer.alloc(Math.min(info.size, 16_384));
      readSync(fd, prefix, 0, prefix.length, 0);
      const end = prefix.indexOf(10);
      if (end < 0) throw new Error(`Incomplete voice recording header: ${path}`);
      const header = JSON.parse(prefix.subarray(0, end).toString("utf8"));
      if (
        header.type !== "voice_transcript" ||
        header.format !== "agentvoice" ||
        header.workspace !== workspace ||
        typeof header.threadId !== "string" ||
        !header.threadId ||
        header.threadId.length > 256 ||
        name !==
          `${/^[A-Za-z0-9_-]{1,128}$/.test(header.threadId) ? header.threadId : createHash("sha256").update(header.threadId).digest("hex")}.jsonl`
      )
        throw new Error(`Voice recording identity mismatch: ${path}`);
      const tail = Buffer.alloc(Math.min(info.size, 16_384));
      readSync(fd, tail, 0, tail.length, info.size - tail.length);
      let interrupted = true;
      if (tail.at(-1) === 10) {
        try {
          interrupted =
            JSON.parse(tail.toString("utf8").trimEnd().split("\n").at(-1)!).type !==
            "recording.ended";
        } catch {
          /* A long final event means the writer has not finalized. */
        }
      }
      results.push({
        path,
        threadId: header.threadId,
        updatedAt: info.mtime.toISOString(),
        interrupted,
      });
    } finally {
      closeSync(fd);
    }
  }
  return results.sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.path.localeCompare(b.path),
  );
}
