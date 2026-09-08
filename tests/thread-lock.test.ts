import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { libcLibraryForRuntime, lockThread } from "../src/core/thread-lock.ts";

test("selects the desktop libc names", () => {
  expect(libcLibraryForRuntime("darwin", {}, "/usr/local/bin/bun")).toBe("libc.dylib");
  expect(libcLibraryForRuntime("linux", {}, "/usr/local/bin/bun")).toBe("libc.so.6");
});

test("selects Bionic when Bun reports Linux in Termux", () => {
  expect(
    libcLibraryForRuntime(
      "linux",
      { ANDROID_ROOT: "/system", ANDROID_DATA: "/data" },
      "/usr/bin/bun",
    ),
  ).toBe("libc.so");
  expect(libcLibraryForRuntime("linux", {}, "/data/user/0/com.termux/files/usr/bin/bun")).toBe(
    "libc.so",
  );
});

test("selects Bionic for a native Android platform report", () => {
  expect(libcLibraryForRuntime("android", {}, "/data/app/agentvoice/bun")).toBe("libc.so");
});

test("thread ownership is exclusive across processes and releases after SIGKILL", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentvoice-lock-test-"));
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "fixtures/lock-holder.ts"), directory, "thread"],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    reader.releaseLock();
    expect(() => lockThread(directory, "thread")).toThrow("already open");
    lockThread(directory, "another-thread")();
    child.kill("SIGKILL");
    await child.exited;
    const release = lockThread(directory, "thread");
    release();
    release();
  } finally {
    child.kill();
    await child.exited;
    rmSync(directory, { recursive: true, force: true });
  }
});
