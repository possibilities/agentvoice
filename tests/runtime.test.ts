import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { VoiceRuntime } from "../src/core/runtime.ts";
import { lockThread } from "../src/core/thread-lock.ts";
import { loadLaunchConfig, parseArgs } from "../src/main.ts";
import {
  deferred,
  NativeStub,
  nativeFullAccess,
  runtimeHarness,
} from "./fixtures/runtime-harness.ts";

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
    h.native.override = (method) =>
      method === "thread/list"
        ? Promise.resolve({
            data: h.native.threads.map((thread) => ({ ...thread, threadSource: null })),
            nextCursor: null,
          })
        : undefined;
    try {
      await h.runtime.start();
      expect(h.native.calls.map((c) => c.method)).toEqual([
        "thread/list",
        "thread/read",
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
  test("native completions never trigger report turns; Fresh preserves active conversation cleanup", async () => {
    const h = runtimeHarness();
    try {
      await h.runtime.start();
      const parent = h.runtime.currentReady!.threadId;
      h.native.options.onNotification("turn/started", {
        threadId: parent,
        turn: { id: "parent-turn" },
      });
      await h.runtime.fresh();
      const fresh = h.runtime.currentReady!.threadId;
      h.native.options.onNotification("turn/completed", {
        threadId: "native-child",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", text: "done" }],
        },
      });
      expect(
        h.native.calls.some((c) =>
          ["turn/start", "turn/steer", "thread/archive", "thread/delete"].includes(c.method),
        ),
      ).toBe(false);
      expect(h.native.threads).toHaveLength(2);
      for (const call of h.native.calls.filter((c) => c.method === "thread/start")) {
        expect(call.params).not.toHaveProperty("dynamicTools");
        expect(call.params).not.toHaveProperty("baseInstructions");
        expect(call.params).not.toHaveProperty("developerInstructions");
      }
      expect(h.native.options).not.toHaveProperty("onRequest");
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
  test("quota and account events never replace the child, resume or submit work", async () => {
    let opens = 0;
    const h = runtimeHarness();
    const runtime = new VoiceRuntime(h.config, "test", h.events, {
      ...h.runtimeOptions,
      connect: (options) => {
        opens++;
        return h.native.connect(options);
      },
    });
    try {
      await runtime.start();
      const id = runtime.currentReady!.threadId;
      const before = [...h.native.calls];
      for (const busy of [false, true]) {
        if (busy)
          h.native.options.onNotification("turn/started", {
            threadId: id,
            turn: { id: "native-turn" },
          });
        for (const usedPercent of [95, 99, 100]) {
          h.native.options.onNotification("account/rateLimits/updated", {
            rateLimits: { primary: { usedPercent }, secondary: { usedPercent } },
          });
          h.native.options.onNotification("account/updated", { authMode: "chatgpt" });
        }
        if (busy)
          h.native.options.onNotification("turn/completed", {
            threadId: id,
            turn: { id: "native-turn", status: "completed" },
          });
        await Bun.sleep(10);
        expect(opens).toBe(1);
        expect(h.native.closes).toBe(0);
        expect(h.native.calls).toEqual(before);
        expect(runtime.currentReady!.threadId).toBe(id);
      }
      await runtime.fresh();
      expect(opens).toBe(1);
      expect(h.native.closes).toBe(0);
      expect(h.fatal).toEqual([]);
    } finally {
      await runtime.shutdown();
      await h.cleanup();
    }
  });
  test("quit waits for its child to close and is idempotent", async () => {
    const closing = deferred();
    const entered = deferred();
    const h = runtimeHarness();
    h.native.close = async () => {
      entered.resolve();
      await closing.promise;
      h.native.alive = false;
      h.native.closes++;
    };
    try {
      await h.runtime.start();
      let done = false;
      const shutdown = h.runtime.shutdown();
      expect(h.runtime.shutdown()).toBe(shutdown);
      void shutdown.then(() => {
        done = true;
      });
      await entered.promise;
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

describe("launch configuration and reported identity", () => {
  test("file edits do not change settings or prompt contents on redial or Fresh", async () => {
    const h = runtimeHarness();
    const configPath = join(h.directory, "server.json");
    const promptPath = join(h.directory, "VOICE_AGENT_SYSTEM_PROMPT.md");
    writeFileSync(
      configPath,
      JSON.stringify({
        "codex-config": ["model=launch-model"],
        voice: { name: "cove", "include-startup-context": false },
      }),
    );
    writeFileSync(promptPath, "launch prompt");
    const config = await loadLaunchConfig(parseArgs(["--config", configPath]), h.directory);
    const runtime = new VoiceRuntime(config, "test", h.events, h.runtimeOptions);
    const offer = async () => {
      await runtime.offer("sdp");
      const call = h.native.calls.at(-1)!;
      expect(call.params).toMatchObject({
        voice: "cove",
        prompt: "launch prompt",
        includeStartupContext: false,
      });
      h.native.options.onNotification("thread/realtime/started", {
        threadId: runtime.currentReady!.threadId,
        realtimeSessionId: call.params["realtimeSessionId"],
      });
    };
    try {
      await runtime.start();
      await offer();
      writeFileSync(
        configPath,
        JSON.stringify({
          "codex-config": ["model=later-model"],
          voice: { name: "vale", "include-startup-context": true },
        }),
      );
      writeFileSync(promptPath, "later prompt");
      await Bun.sleep(350);
      await offer();
      await runtime.fresh();
      await offer();
      expect(h.native.options.argv).toContain("model=launch-model");
      expect(h.native.closes).toBe(0);
    } finally {
      await runtime.shutdown();
      await h.cleanup();
    }
  });

  test("status uses native model/effort reports and attributes protocol to the current session", async () => {
    const h = runtimeHarness({
      orchestrator: { model: "requested", effort: "high" },
      voice: { version: "v3" },
    });
    h.native.main("saved", h.directory);
    h.native.override = (method) =>
      method === "thread/resume"
        ? Promise.resolve({
            thread: h.native.threads[0],
            ...nativeFullAccess,
            model: "reported",
            reasoningEffort: "low",
          })
        : undefined;
    try {
      await h.runtime.start();
      expect(h.runtime.currentReady).toMatchObject({
        model: "reported",
        effort: "low",
        conversationMode: "continued",
        voiceVersion: null,
      });
      await h.runtime.offer("first");
      const first = h.native.calls.at(-1)!.params["realtimeSessionId"];
      await h.runtime.offer("second");
      const second = h.native.calls.at(-1)!.params["realtimeSessionId"];
      const started = (realtimeSessionId: unknown, version: string) =>
        h.native.options.onNotification("thread/realtime/started", {
          threadId: "saved",
          realtimeSessionId,
          version,
        });
      started(first, "v1");
      expect(h.runtime.currentReady!.voiceVersion).toBeNull();
      started(second, "v3");
      started(first, "v1");
      expect(h.runtime.currentReady!.voiceVersion).toBe("v3");
      h.native.options.onNotification("thread/settings/updated", {
        threadId: "saved",
        threadSettings: {
          ...nativeFullAccess,
          sandboxPolicy: nativeFullAccess.sandbox,
          model: "updated",
          reasoningEffort: "medium",
        },
      });
      expect(h.runtime.currentReady).toMatchObject({ model: "updated", effort: "medium" });
      await h.runtime.fresh();
      expect(h.runtime.currentReady).toMatchObject({
        model: null,
        effort: null,
        conversationMode: "started",
        voiceVersion: null,
      });
      h.native.options.onNotification("thread/settings/updated", {
        threadId: "saved",
        threadSettings: {
          ...nativeFullAccess,
          sandboxPolicy: nativeFullAccess.sandbox,
          model: "old work",
        },
      });
      expect(h.runtime.currentReady!.model).toBeNull();
    } finally {
      await h.cleanup();
    }
  });
});
