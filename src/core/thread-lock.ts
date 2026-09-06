import { dlopen, FFIType } from "bun:ffi";
import { createHash } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

let library: ReturnType<typeof openLibrary> | undefined;
function openLibrary() {
  return dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
}

/** Kernel-owned locks release even after a crash. Never unlink a lock inode. */
export function lockThread(directory: string, threadId: string): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = createHash("sha256").update(threadId).digest("hex");
  const fd = openSync(
    join(directory, `${name}.lock`),
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  let locked = false;
  try {
    library ??= openLibrary();
    locked = library.symbols.flock(fd, 2 | 4) === 0; // LOCK_EX | LOCK_NB
    if (!locked)
      throw new Error(
        `Conversation ${threadId} is already open in another AgentVoice process; start without --continue/--resume for a separate conversation`,
      );
  } finally {
    if (!locked) closeSync(fd);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(fd);
  };
}
