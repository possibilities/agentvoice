import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { libcLibraryForRuntime, lockFile, lockThread } from "../src/core/thread-lock.ts";

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

test("a named file lock remains reusable after its owner is killed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentvoice-file-lock-test-"));
  const path = join(directory, "service.lock");
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "fixtures/lock-holder.ts"), "--file", path],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    reader.releaseLock();
    expect(() => lockFile(path, "busy")).toThrow("busy");
    child.kill("SIGKILL");
    await child.exited;
    const release = lockFile(path, "busy");
    expect(existsSync(path)).toBe(true);
    release();
    release();
  } finally {
    child.kill();
    await child.exited;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a named file lock refuses unsafe existing files", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentvoice-file-lock-safety-test-"));
  const path = join(directory, "service.lock");
  try {
    writeFileSync(path, "", { mode: 0o600 });
    chmodSync(path, 0o666);
    expect(() => lockFile(path, "busy")).toThrow("Unsafe lock file");

    chmodSync(path, 0o700);
    expect(() => lockFile(path, "busy")).toThrow("Unsafe lock file");

    rmSync(path);
    writeFileSync(path, "", { mode: 0o600 });
    linkSync(path, join(directory, "second-link"));
    expect(() => lockFile(path, "busy")).toThrow("Unsafe lock file");

    rmSync(path);
    symlinkSync(join(directory, "second-link"), path);
    expect(() => lockFile(path, "busy")).toThrow();

    rmSync(path);
    mkdirSync(path, { mode: 0o700 });
    expect(() => lockFile(path, "busy")).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a named file lock refuses a file that is not owned by the current user", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentvoice-file-lock-owner-test-"));
  const path = join(directory, "service.lock");
  const getuid = process.getuid!;
  try {
    writeFileSync(path, "", { mode: 0o600 });
    Object.defineProperty(process, "getuid", {
      configurable: true,
      value: () => getuid() + 1,
    });
    expect(() => lockFile(path, "busy")).toThrow("Unsafe lock file");
  } finally {
    Object.defineProperty(process, "getuid", { configurable: true, value: getuid });
    rmSync(directory, { recursive: true, force: true });
  }
});
