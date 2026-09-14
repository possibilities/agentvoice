import { expect, test } from "bun:test";
import { voiceProtocol } from "../src/core/voice-inspection.ts";
import { runtimeHarness } from "./fixtures/runtime-harness.ts";

const catalog = {
  voices: { v1: ["cove", "maple"], v2: ["marin"], defaultV1: "cove", defaultV2: "marin" },
};

test("voice inspection confirms only this thread's current started request and never invents a default", async () => {
  for (const voice of ["maple", undefined]) {
    const h = runtimeHarness({ voice: { name: voice } });
    h.native.override = (method) =>
      method === "thread/realtime/listVoices" ? Promise.resolve(catalog) : undefined;
    try {
      await h.runtime.start();
      expect((await h.runtime.inspectVoice()).selectionSource).toBe("unknown");
      await h.runtime.offer("offer");
      const params = h.native.calls.find((call) => call.method === "thread/realtime/start")!.params;
      h.native.options.onNotification("thread/realtime/started", { ...params, threadId: "other" });
      h.native.options.onNotification("thread/realtime/started", {
        ...params,
        realtimeSessionId: "stale",
      });
      expect((await h.runtime.inspectVoice()).selectionSource).toBe("unknown");
      h.native.options.onNotification("thread/realtime/started", { ...params, version: "v3" });
      expect(await h.runtime.inspectVoice()).toMatchObject({
        requestedVoice: voice ?? null,
        selectionSource: voice ? "explicit-request" : "native-resolution",
        defaultVoice: "cove",
        choices: ["cove", "maple"],
        protocol: "v3",
      });
      await h.runtime.offer("renewal");
      h.native.options.onNotification("thread/realtime/started", { ...params, version: "v3" });
      expect((await h.runtime.inspectVoice()).selectionSource).toBe("unknown");
    } finally {
      await h.cleanup();
    }
  }
});

test("native membership validation rejects unknown and wrong-family names before changing settings", async () => {
  const h = runtimeHarness({ voice: { name: "cove" } });
  h.native.override = (method) =>
    method === "thread/realtime/listVoices" ? Promise.resolve(catalog) : undefined;
  try {
    await h.runtime.start();
    await h.runtime.validateVoiceSelection("maple");
    await expect(h.runtime.validateVoiceSelection("marin")).rejects.toThrow("not supported");
    await expect(h.runtime.validateVoiceSelection("typo")).rejects.toThrow("not supported");
    expect(h.config.voice.name).toBe("cove");
    expect(
      h.native.calls.filter((call) => call.method === "thread/realtime/listVoices"),
    ).toHaveLength(1);
    expect(h.native.calls.some((call) => call.method === "thread/realtime/start")).toBe(false);
  } finally {
    await h.cleanup();
  }
});

test("unsupported native catalog is inspectable without preventing ordinary startup or clearing selection", async () => {
  const h = runtimeHarness();
  h.native.override = (method) =>
    method === "thread/realtime/listVoices"
      ? Promise.reject(new Error("method not found: private native text"))
      : undefined;
  try {
    await h.runtime.start();
    expect(h.ready).toHaveLength(1);
    const read = await h.runtime.inspectVoice();
    expect(read.catalog.status).toBe("unavailable");
    expect(read.choices).toEqual([]);
    expect(read.defaultVoice).toBeNull();
    await expect(h.runtime.validateVoiceSelection("cove")).rejects.toThrow(
      "catalog is unavailable",
    );
    await h.runtime.validateVoiceSelection(null);
    expect(h.fatal).toEqual([]);
  } finally {
    await h.cleanup();
  }
});

test("raw voice selection is reported but cannot be silently overwritten", async () => {
  const h = runtimeHarness({ voice: { name: "cove", extra: { voice: "maple" } } });
  h.native.override = (method) =>
    method === "thread/realtime/listVoices" ? Promise.resolve(catalog) : undefined;
  try {
    await h.runtime.start();
    await h.runtime.offer("offer");
    const params = h.native.calls.find((call) => call.method === "thread/realtime/start")!.params;
    h.native.options.onNotification("thread/realtime/started", { ...params, version: "v3" });
    expect(await h.runtime.inspectVoice()).toMatchObject({
      masked: true,
      managedVoice: "cove",
      requestedVoice: "maple",
    });
    await expect(h.runtime.validateVoiceSelection("cove")).rejects.toThrow("masks");
  } finally {
    await h.cleanup();
  }
});

test("compatible protocol follows final raw overrides and marks alternate media paths unsupported", () => {
  expect(voiceProtocol({})).toBe("v3");
  expect(voiceProtocol({ version: "v1" })).toBe("v1");
  expect(voiceProtocol({ version: "v3", extra: { version: null } })).toBe("v1");
  expect(voiceProtocol({ version: "v1", extra: { version: "v3" } })).toBe("v3");
  expect(voiceProtocol({ extra: { transport: { type: "websocket" } } })).toBeNull();
  expect(voiceProtocol({ extra: { transport: null } })).toBeNull();
  expect(voiceProtocol({ version: "v2" })).toBeNull();
});
