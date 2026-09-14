import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runConsoleHost } from "../src/console/host.ts";
import type { VoiceHost } from "../src/console/state.ts";
import { hostHarness } from "./fixtures/host-harness.ts";
import { deferred } from "./fixtures/runtime-harness.ts";

function observer() {
  let host: VoiceHost;
  const end = deferred();
  return {
    create: async (bindings: VoiceHost) => {
      host = bindings;
      return {
        done: end.promise,
        refresh() {},
        cancelInputs() {},
        shutdown: async () => {
          end.resolve();
        },
      };
    },
    close: () => {
      void host.shutdown();
      end.resolve();
    },
    state: () => host.state(),
  };
}

async function until(predicate: () => boolean) {
  for (let n = 0; n < 200 && !predicate(); n++) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

test("startup failure restores terminal and closes child/media", async () => {
  const h = hostHarness({}, { savedThread: "existing" });
  h.native.override = (m) =>
    m === "thread/read" ? Promise.reject(new Error("lookup failed")) : undefined;
  const setup = observer();
  try {
    await expect(
      runConsoleHost(h.config, "test", {
        mediaFactory: h.mediaFactory,
        runtime: h.runtimeOptions,
        observe: setup.create,
      }),
    ).rejects.toThrow("lookup failed");
    expect(h.native.closes).toBe(1);
    expect(h.calls).not.toContain("audio:start");
    expect(h.calls).toContain("audio:stop");
    expect(h.calls).toContain("transport:stop");
  } finally {
    await h.cleanup();
  }
});

test("quitting while audio opens stops late-opened audio and the prepared child", async () => {
  const h = hostHarness();
  const opening = deferred();
  const entered = deferred();
  h.audio.start = () => {
    entered.resolve();
    return opening.promise;
  };
  const setup = observer();
  const run = runConsoleHost(h.config, "test", {
    mediaFactory: h.mediaFactory,
    runtime: h.runtimeOptions,
    observe: setup.create,
  });
  try {
    await entered.promise;
    expect(h.calls).not.toContain("ready");
    setup.close();
    opening.resolve();
    await run;
    expect(h.calls.filter((c) => c === "audio:stop").length).toBeGreaterThanOrEqual(2);
    expect(h.native.calls.some((c) => c.method === "thread/start")).toBe(true);
    expect(h.native.closes).toBe(1);
    expect(h.calls).not.toContain("ready");
  } finally {
    opening.resolve();
    await run;
    await h.cleanup();
  }
});
test("invalid prompt, protocol, native requirements and Fast readiness never open audio", async () => {
  for (const failure of ["prompt", "protocol", "permissions", "fast"] as const) {
    const h = hostHarness(failure === "protocol" ? { voice: { version: "v2" } } : {});
    if (failure === "prompt") mkdirSync(join(h.directory, "VOICE_AGENT_SYSTEM_PROMPT.md"));
    if (failure === "permissions")
      h.native.override = (method) =>
        method === "thread/start"
          ? Promise.reject(new Error("native managed requirements rejected thread"))
          : undefined;
    if (failure === "fast") h.native.models = [];
    const setup = observer();
    try {
      await expect(
        runConsoleHost(h.config, "test", {
          mediaFactory: h.mediaFactory,
          runtime: { ...h.runtimeOptions, ...(failure === "fast" ? { fast: true } : {}) },
          observe: setup.create,
        }),
      ).rejects.toThrow();
      expect(h.calls).not.toContain("audio:start");
      expect(h.calls).not.toContain("ready");
      expect(h.native.closes).toBe(failure === "permissions" || failure === "fast" ? 1 : 0);
    } finally {
      await h.cleanup();
    }
  }
});

test("quit during native readiness closes the child without opening audio", async () => {
  const h = hostHarness({}, { savedThread: "existing" });
  const pending = deferred<unknown>();
  const entered = deferred();
  h.native.override = (method) => {
    if (method !== "thread/read") return undefined;
    entered.resolve();
    return pending.promise;
  };
  const setup = observer();
  const run = runConsoleHost(h.config, "test", {
    mediaFactory: h.mediaFactory,
    runtime: h.runtimeOptions,
    observe: setup.create,
  });
  try {
    await entered.promise;
    setup.close();
    pending.resolve({ data: [], nextCursor: null });
    await run;
    expect(h.native.closes).toBe(1);
    expect(h.calls).not.toContain("audio:start");
    expect(h.calls).not.toContain("ready");
  } finally {
    pending.resolve({ data: [], nextCursor: null });
    await run;
    await h.cleanup();
  }
});

test("audio-open failure closes the prepared child without negotiating", async () => {
  const h = hostHarness();
  h.audio.start = async () => {
    throw new Error("device unavailable");
  };
  const setup = observer();
  try {
    await expect(
      runConsoleHost(h.config, "test", {
        mediaFactory: h.mediaFactory,
        runtime: h.runtimeOptions,
        observe: setup.create,
      }),
    ).rejects.toThrow("device unavailable");
    expect(h.native.closes).toBe(1);
    expect(h.calls).not.toContain("ready");
  } finally {
    await h.cleanup();
  }
});

test("rapid frontend detach and reattach fences old media and settles on the latest state", async () => {
  const h = hostHarness();
  const stopped = deferred();
  h.native.override = (method) => (method === "thread/realtime/stop" ? stopped.promise : undefined);
  const setup = observer();
  const started = deferred();
  let setAttached!: (attached: boolean) => Promise<void>;
  const run = runConsoleHost(h.config, "test", {
    mediaFactory: h.mediaFactory,
    runtime: h.runtimeOptions,
    observe: setup.create,
    onStarted: started.resolve,
    onFrontendReady: (set) => {
      setAttached = set;
    },
  });
  try {
    await started.promise;
    h.offer("offer");
    await until(() => h.native.calls.some((call) => call.method === "thread/realtime/start"));

    const detaching = setAttached(false);
    expect(h.calls.at(-1)).toBe("transport:attached:false");
    expect(h.audio.micMuted).toBe(true);
    expect(h.audio.speakerMuted).toBe(true);
    expect(setup.state().mic.effectiveMuted).toBe(true);
    expect(setup.state().speaker.effectiveMuted).toBe(true);
    await until(() => h.native.calls.some((call) => call.method === "thread/realtime/stop"));

    const attaching = setAttached(true);
    expect(h.audio.micMuted).toBe(false);
    expect(h.audio.speakerMuted).toBe(false);
    stopped.resolve();
    await Promise.all([detaching, attaching]);
    expect(h.calls.filter((call) => call.startsWith("transport:attached:"))).toEqual([
      "transport:attached:false",
      "transport:attached:true",
    ]);
  } finally {
    stopped.resolve();
    setup.close();
    await run;
    await h.cleanup();
  }
});

test("failed strict detach keeps queued and future attachments fenced", async () => {
  const h = hostHarness();
  const stopped = Promise.withResolvers<void>();
  h.native.override = (method) => (method === "thread/realtime/stop" ? stopped.promise : undefined);
  const setup = observer();
  const started = deferred();
  let setAttached!: (attached: boolean) => Promise<void>;
  const run = runConsoleHost(h.config, "test", {
    mediaFactory: h.mediaFactory,
    runtime: h.runtimeOptions,
    observe: setup.create,
    onStarted: started.resolve,
    onFrontendReady: (set) => {
      setAttached = set;
    },
  });
  try {
    await started.promise;
    h.offer("offer");
    await until(() => h.native.calls.some((call) => call.method === "thread/realtime/start"));
    const detached = setAttached(false);
    const attached = setAttached(true);
    const outcomes = Promise.allSettled([detached, attached]);
    stopped.reject(new Error("stop not acknowledged"));
    expect((await outcomes).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    await expect(setAttached(true)).rejects.toThrow("stop not acknowledged");
    expect(h.calls.filter((call) => call.startsWith("transport:attached:"))).toEqual([
      "transport:attached:false",
    ]);
  } finally {
    stopped.resolve();
    setup.close();
    await run;
    await h.cleanup();
  }
});
