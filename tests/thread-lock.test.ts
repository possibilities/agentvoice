import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockThread } from "../src/core/thread-lock.ts";

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
