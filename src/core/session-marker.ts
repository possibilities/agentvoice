import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const SESSION_MARKER = ".agentvoice-session";
const validId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id);

/** One workspace's explicit pointer; native Codex still owns all history. */
export function readSessionMarker(workspace: string): string | null {
  const path = join(workspace, SESSION_MARKER);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      !lstatSync(path, { throwIfNoEntry: false })
    )
      return null;
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || info.mode & 0o022)
      throw new Error(`Unsafe workspace session marker: ${path}`);
    const buffer = Buffer.alloc(258);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytes).toString("utf8");
    const id = text.endsWith("\n") ? text.slice(0, -1) : text;
    if (!validId(id))
      throw new Error(
        `Invalid workspace session marker: ${path}; remove it to start a new session`,
      );
    return id;
  } finally {
    closeSync(fd);
  }
}

function syncWorkspace(workspace: string) {
  const fd = openSync(workspace, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Publish without replacing a marker created while native startup was pending. */
export function saveSessionMarker(workspace: string, threadId: string): void {
  if (!validId(threadId)) throw new Error("Invalid native thread ID for workspace session marker");
  const temporary = join(workspace, `${SESSION_MARKER}.${randomUUID()}.tmp`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      writeFileSync(fd, `${threadId}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(temporary, join(workspace, SESSION_MARKER));
  } finally {
    unlinkSync(temporary);
  }
  syncWorkspace(workspace);
}

/** Call owners serialize this with startup; changed user choices are never overwritten. */
export function clearSessionMarker(workspace: string, expected: string | null): void {
  if (readSessionMarker(workspace) !== expected)
    throw new Error("Workspace session marker changed during new-session preparation");
  if (expected !== null) {
    unlinkSync(join(workspace, SESSION_MARKER));
    syncWorkspace(workspace);
  }
}
