import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceRuntime } from "../src/core/runtime.ts";
import {
  clearSessionMarker,
  readSessionMarker,
  SESSION_MARKER,
  saveSessionMarker,
} from "../src/core/session-marker.ts";
import { NativeStub, runtimeHarness } from "./fixtures/runtime-harness.ts";

test("marker publication is exclusive, private, bounded, and never follows a link", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "av-marker-")));
  const path = join(root, SESSION_MARKER);
  try {
    expect(readSessionMarker(root)).toBeNull();
    saveSessionMarker(root, "saved-id");
    expect(readSessionMarker(root)).toBe("saved-id");
    expect(() => saveSessionMarker(root, "other-id")).toThrow();
    expect(() => clearSessionMarker(root, "other-id")).toThrow("changed");
    expect(readSessionMarker(root)).toBe("saved-id");
    clearSessionMarker(root, "saved-id");
    for (const value of ["", "two\nids", "x".repeat(300), "../elsewhere", '{"id":"old"}']) {
      writeFileSync(path, value, { mode: 0o600 });
      expect(() => readSessionMarker(root)).toThrow("Invalid");
    }
    writeFileSync(path, "saved-id\n");
    chmodSync(path, 0o666);
    expect(() => readSessionMarker(root)).toThrow("Unsafe");
    unlinkSync(path);
    const target = join(root, "target");
    writeFileSync(target, "unchanged");
    symlinkSync(target, path);
    expect(() => readSessionMarker(root)).toThrow();
    expect(() => clearSessionMarker(root, null)).toThrow();
    expect(readFileSync(target, "utf8")).toBe("unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a new call resumes the saved exact thread across new native children; deletion starts fresh", async () => {
  const h = runtimeHarness();
  const runtimes: VoiceRuntime[] = [];
  try {
    await h.runtime.start();
    const id = h.runtime.currentReady!.threadId;
    expect(readSessionMarker(h.directory)).toBe(id);
    await h.runtime.shutdown();
    const native = new NativeStub();
    native.main("newer-unrelated-thread", h.directory);
    native.main(id, h.directory);
    const resumed = new VoiceRuntime(h.config, "test", h.events, {
      ...h.runtimeOptions,
      connect: native.connect,
    });
    runtimes.push(resumed);
    await resumed.start();
    expect(resumed.currentReady!.threadId).toBe(id);
    expect(native.calls.map((c) => c.method)).toEqual(["thread/read", "thread/resume"]);
    await resumed.shutdown();
    unlinkSync(join(h.directory, SESSION_MARKER));
    const next = new NativeStub();
    next.override = (method) =>
      method === "thread/start" ? Promise.resolve({ thread: { id: "new-session" } }) : undefined;
    const fresh = new VoiceRuntime(h.config, "test", h.events, {
      ...h.runtimeOptions,
      connect: next.connect,
    });
    runtimes.push(fresh);
    await fresh.start();
    expect(fresh.currentReady!.threadId).toBe("new-session");
    expect(readSessionMarker(h.directory)).toBe("new-session");
    expect(native.threads.some((t) => t.id === id)).toBe(true);
  } finally {
    for (const runtime of runtimes) await runtime.shutdown();
    await h.cleanup();
  }
});

test("a failed post-start readiness check retains the new thread marker", async () => {
  const h = runtimeHarness({}, { fast: true });
  h.native.tiers = true;
  h.native.override = (method) =>
    method === "thread/start"
      ? Promise.resolve({ thread: { id: "created-before-failure" }, model: "unexpected" })
      : undefined;
  try {
    await expect(h.runtime.start()).rejects.toThrow();
    expect(readSessionMarker(h.directory)).toBe("created-before-failure");
  } finally {
    await h.cleanup();
  }
});

test("a changed marker during native creation is preserved, never overwritten", async () => {
  const h = runtimeHarness();
  h.native.override = (method) => {
    if (method !== "thread/start") return;
    saveSessionMarker(h.directory, "operator-choice");
    return Promise.resolve({ thread: { id: "newly-created" } });
  };
  try {
    await expect(h.runtime.start()).rejects.toThrow();
    expect(readSessionMarker(h.directory)).toBe("operator-choice");
    expect(h.native.closes).toBe(1);
  } finally {
    await h.cleanup();
  }
});

test("ephemeral sessions fail preflight before native startup or marker creation", async () => {
  const h = runtimeHarness({ orchestrator: { ephemeral: true } });
  try {
    await expect(h.runtime.start()).rejects.toThrow("persisted Codex history");
    expect(h.native.calls).toEqual([]);
    expect(existsSync(join(h.directory, SESSION_MARKER))).toBe(false);
  } finally {
    await h.cleanup();
  }
});
