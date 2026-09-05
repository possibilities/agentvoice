import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { VoiceRuntime } from "../src/core/runtime.ts";
import { lockThread } from "../src/core/thread-lock.ts";
import { deferred, NativeStub, runtimeHarness } from "./fixtures/runtime-harness.ts";

async function until(predicate: () => boolean) {
  const end = Date.now() + 2_000;
  while (!predicate() && Date.now() < end) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}
describe("foreground runtime ownership", () => {
  test("new starts share the canonical workspace; Fresh changes identity and clears media", async () => {
    const h = runtimeHarness();
    try {
      await h.runtime.start();
      const first = h.runtime.currentReady!;
      expect(first.workspace).toBe(h.directory);
      expect(h.native.options.cwd).toBe(h.directory);
      await h.runtime.fresh();
      expect(h.runtime.currentReady!.threadId).not.toBe(first.threadId);
      expect(h.closed).toContain("fresh-thread");
      expect(
        h.native.calls
          .filter((c) => c.method === "thread/start")
          .every((c) => c.params["cwd"] === h.directory),
      ).toBe(true);
      expect(() => lockThread(join(h.directory, "locks"), first.threadId)).toThrow("already open");
      await h.runtime.shutdown();
      const release = lockThread(join(h.directory, "locks"), first.threadId);
      release();
      release();
      expect(h.native.closes).toBe(1);
    } finally {
      await h.cleanup();
    }
  });
  test("continues native history by default and verifies it before resuming", async () => {
    const h = runtimeHarness();
    h.native.main("existing", h.directory);
    try {
      await h.runtime.start();
      expect(h.native.calls.map((c) => c.method)).toEqual([
        "thread/list",
        "thread/read",
        "thread/resume",
      ]);
      expect(h.runtime.currentReady?.threadId).toBe("existing");
    } finally {
      await h.cleanup();
    }
  });
  test("fresh skips lookup, while explicit resume errors never create a replacement", async () => {
    const h = runtimeHarness({}, { fresh: true });
    const missing = runtimeHarness({}, { resume: "missing" });
    try {
      await h.runtime.start();
      expect(h.native.calls[0]?.method).toBe("thread/start");
      await expect(missing.runtime.start()).rejects.toThrow("no unarchived AgentVoice");
      expect(missing.native.calls.some((c) => c.method === "thread/start")).toBe(false);
      expect(missing.native.closes).toBe(1);
    } finally {
      await h.cleanup();
      await missing.cleanup();
    }
  });
  test("refuses a changed workspace or identity and releases failed-start locks", async () => {
    for (const failure of ["workspace", "identity", "resume"]) {
      const h = runtimeHarness();
      h.native.main("existing", h.directory);
      h.native.override = (m) => {
        if (m === "thread/read" && failure !== "resume")
          return Promise.resolve({
            thread: {
              ...h.native.threads[0],
              ...(failure === "workspace" ? { cwd: "/elsewhere" } : { id: "other" }),
            },
          });
        if (m === "thread/resume" && failure === "resume")
          return Promise.resolve({ thread: { id: "other" } });
        return undefined;
      };
      try {
        await expect(h.runtime.start()).rejects.toThrow();
        expect(h.native.closes).toBe(1);
        lockThread(join(h.directory, "locks"), "existing")();
      } finally {
        await h.cleanup();
      }
    }
  });
  test("two workspaces can run independently; two owners of the same conversation cannot", async () => {
    const h = runtimeHarness();
    const elsewhere = runtimeHarness();
    const secondNative = new NativeStub();
    h.native.main("shared", h.directory);
    secondNative.main("shared", h.directory);
    const second = new VoiceRuntime(h.config, "test", h.events, {
      ...h.runtimeOptions,
      connect: secondNative.connect,
    });
    try {
      await h.runtime.start();
      await elsewhere.runtime.start();
      await expect(second.start()).rejects.toThrow("already open");
      expect(secondNative.closes).toBe(1);
      expect(h.native.alive).toBe(true);
      expect(elsewhere.runtime.currentReady?.workspace).toBe(elsewhere.directory);
    } finally {
      await second.shutdown();
      await elsewhere.cleanup();
      await h.cleanup();
    }
  });
  test("late connections after quit are closed, and no thread is started", async () => {
    const pending = deferred<NativeStub>();
    const entered = deferred();
    const h = runtimeHarness(
      {},
      {
        connect: () => {
          entered.resolve();
          return pending.promise;
        },
      },
    );
    const starting = h.runtime.start().catch((e) => e);
    await entered.promise;
    await h.runtime.shutdown();
    pending.resolve(h.native);
    expect(await starting).toBeInstanceOf(Error);
    expect(h.native.calls).toHaveLength(0);
    expect(h.native.closes).toBe(1);
    await h.cleanup();
  });
  test("worker reports stay with their originating parent after Fresh; quit interrupts both", async () => {
    const h = runtimeHarness({ orchestrator: { dispatch: true, "dispatch-reports": true } });
    try {
      await h.runtime.start();
      const parent = h.runtime.currentReady!.threadId;
      await h.native.options.onRequest!("item/tool/call", {
        threadId: parent,
        tool: "dispatch_worker",
        arguments: { title: "check", brief: "inspect only" },
      });
      const worker = h.native.threads.find((t) => t.threadSource === "agentvoice-worker")!;
      expect(worker.cwd).toBe(h.directory);
      await h.runtime.fresh();
      const fresh = h.runtime.currentReady!.threadId;
      h.native.options.onNotification("turn/completed", {
        threadId: worker.id,
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", text: "done" }],
        },
      });
      await until(() =>
        h.native.calls.some((c) => c.method === "turn/start" && c.params["threadId"] === parent),
      );
      expect(
        h.native.calls.some((c) => c.method === "turn/start" && c.params["threadId"] === fresh),
      ).toBe(false);
      expect(h.runtime.workerSnapshots()).toEqual([]);
      h.native.options.onNotification("turn/started", {
        threadId: fresh,
        turn: { id: "fresh-turn" },
      });
      await h.runtime.shutdown();
      const interrupted = h.native.calls
        .filter((c) => c.method === "turn/interrupt")
        .map((c) => c.params["threadId"]);
      expect(interrupted).toContain(parent);
      expect(interrupted).toContain(fresh);
    } finally {
      await h.cleanup();
    }
  });
  test("unexpected child closure notifies the host without reconnecting", async () => {
    const h = runtimeHarness();
    try {
      await h.runtime.start();
      h.native.alive = false;
      h.native.options.onClose({ expected: false, error: "child crashed" });
      expect(h.fatal).toEqual(["child crashed"]);
      expect(h.runtime.currentReady).toBeNull();
    } finally {
      await h.cleanup();
    }
  });
  test("quota selection waits for active turns and outstanding worker report submissions", async () => {
    let picks = 0;
    const h = runtimeHarness(
      { accounts: { balance: true }, orchestrator: { dispatch: true, "dispatch-reports": true } },
      {
        pickAccount: async () => {
          picks++;
          return { kind: "canonical", reason: "test" };
        },
      },
    );
    const report = deferred<unknown>();
    try {
      await h.runtime.start();
      const parent = h.runtime.currentReady!.threadId;
      await h.native.options.onRequest!("item/tool/call", {
        threadId: parent,
        tool: "dispatch_worker",
        arguments: { title: "check", brief: "inspect" },
      });
      const worker = h.native.threads.find((t) => t.threadSource === "agentvoice-worker")!;
      h.native.options.onNotification("account/rateLimits/updated", {
        rateLimits: { primary: { usedPercent: 99 } },
      });
      expect(picks).toBe(1);
      h.native.override = (m, p) =>
        m === "turn/start" && p["threadId"] === parent ? report.promise : undefined;
      h.native.options.onNotification("turn/completed", {
        threadId: worker.id,
        turn: { id: "turn-1", status: "completed", items: [] },
      });
      await Bun.sleep(10);
      expect(picks).toBe(1);
      report.resolve({ turn: { id: "report" } });
      await until(() => picks === 2);
    } finally {
      report.resolve({});
      await h.cleanup();
    }
  });
  test("idle rotation replaces only this launch's child and resumes the same workspace/thread", async () => {
    let picks = 0;
    const h = runtimeHarness({ accounts: { balance: true } });
    const replacement = new NativeStub();
    h.native.main("persisted", h.directory);
    replacement.main("persisted", h.directory);
    let opens = 0;
    const profileDir = join(h.directory, "profile");
    const runtime = new VoiceRuntime(h.config, "test", h.events, {
      locksDir: join(h.directory, "locks"),
      connect: (options) => (++opens === 1 ? h.native : replacement).connect(options),
      pickAccount: async () =>
        ++picks === 1
          ? { kind: "canonical", reason: "initial" }
          : {
              kind: "profile",
              email: "test@example.invalid",
              reason: "test",
              profile: { directory: profileDir, slug: "test", identity: null },
            },
    });
    try {
      await runtime.start();
      h.native.options.onNotification("account/rateLimits/updated", {
        rateLimits: { primary: { usedPercent: 99 } },
      });
      await until(() => replacement.calls.some((c) => c.method === "thread/resume"));
      await until(() => h.ready.length === 2);
      expect(h.native.closes).toBe(1);
      expect(runtime.currentReady?.threadId).toBe("persisted");
      expect(replacement.options.cwd).toBe(h.directory);
      expect(replacement.options.env?.["CODEX_HOME"]).toBe(profileDir);
      expect(replacement.calls.some((c) => c.method === "thread/start")).toBe(false);
      expect(h.fatal).toEqual([]);
    } finally {
      await runtime.shutdown();
      await h.cleanup();
    }
  });
  test("quit waits for the old child already closing during rotation", async () => {
    let picks = 0;
    const closing = deferred();
    const entered = deferred();
    const h = runtimeHarness(
      { accounts: { balance: true } },
      {
        pickAccount: async () =>
          ++picks === 1
            ? { kind: "canonical", reason: "initial" }
            : {
                kind: "profile",
                email: "test@example.invalid",
                reason: "test",
                profile: {
                  directory: "/unused-agentvoice-test-profile",
                  slug: "test",
                  identity: null,
                },
              },
      },
    );
    h.native.close = async () => {
      entered.resolve();
      await closing.promise;
      h.native.alive = false;
      h.native.closes++;
    };
    try {
      await h.runtime.start();
      h.native.options.onNotification("account/rateLimits/updated", {
        rateLimits: { primary: { usedPercent: 99 } },
      });
      await entered.promise;
      let done = false;
      const shutdown = h.runtime.shutdown().then(() => {
        done = true;
      });
      await Bun.sleep(10);
      expect(done).toBe(false);
      closing.resolve();
      await shutdown;
      expect(h.native.closes).toBe(1);
      expect(h.fatal).toEqual([]);
    } finally {
      closing.resolve();
      await h.cleanup();
    }
  });
});
