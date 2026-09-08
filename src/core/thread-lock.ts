import { dlopen, FFIType } from "bun:ffi";
import { createHash } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

let library: ReturnType<typeof openLibrary> | undefined;

export function libcLibraryForRuntime(
  platform: string,
  environment: Readonly<Record<string, string | undefined>>,
  executablePath: string,
): string {
  if (platform === "darwin") return "libc.dylib";
  // Bun's Android build can report Linux; Bionic cannot open glibc's libc.so.6.
  if (
    platform === "android" ||
    environment["ANDROID_ROOT"] === "/system" ||
    environment["ANDROID_DATA"] === "/data" ||
    environment["TERMUX_VERSION"] !== undefined ||
    environment["PREFIX"]?.startsWith("/data/data/com.termux/") ||
    environment["PREFIX"]?.startsWith("/data/user/0/com.termux/") ||
    executablePath.startsWith("/data/data/com.termux/") ||
    executablePath.startsWith("/data/user/0/com.termux/")
  )
    return "libc.so";
  return "libc.so.6";
}

function openLibrary() {
  return dlopen(libcLibraryForRuntime(process.platform, process.env, process.execPath), {
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
