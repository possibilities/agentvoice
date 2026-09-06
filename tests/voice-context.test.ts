import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ConfigValues, parseJsonConfig, resolveConfig } from "../src/core/config.ts";
import { realtimeParams } from "../src/core/params.ts";
import type { RuntimeOptions } from "../src/core/runtime.ts";
import { runtimeHarness } from "./fixtures/runtime-harness.ts";

describe("voice context passthrough", () => {
  const params = (values: ConfigValues = {}) =>
    realtimeParams(resolveConfig({}, values, {}, "/test"), {}, "thread", "call", "sdp");

  test("default voice startup carries no application history or reconnect instruction", () => {
    const request = params();
    for (const key of [
      "initialItems",
      "prompt",
      "realtimeStartInstructions",
      "realtimeEndInstructions",
    ])
      expect(request).not.toHaveProperty(key);
    expect(request["includeStartupContext"]).toBe(false);
    expect(request).not.toHaveProperty("flushTranscriptTailOnSessionEnd");
  });

  test("explicit initial items retain empty, null and populated values", () => {
    for (const initialItems of [[], null, [{ role: "developer", text: "Operator context" }]])
      expect(params({ voice: { extra: { initialItems } } })["initialItems"]).toEqual(initialItems);
    for (const version of [null, "v1"])
      expect(params({ voice: { extra: { version } } })).not.toHaveProperty("initialItems");
    expect(() =>
      params({
        voice: { version: "v1", extra: { initialItems: [{ role: "user", text: "seed" }] } },
      }),
    ).toThrow("require effective realtime v3");
  });

  test("retired replay configuration gives removal guidance even when false", () => {
    for (const value of [true, false, null])
      expect(() =>
        parseJsonConfig(JSON.stringify({ voice: { "replay-spoken-history": value } }), "test.json"),
      ).toThrow("voice.replay-spoken-history has been retired; remove this key");
  });
});

describe("native voice continuity without application replay", () => {
  for (const mode of ["continue", "resume", "fresh"] as const) {
    test(`${mode}, redial and Fresh never read or inject speech history`, async () => {
      const h = runtimeHarness(
        {},
        mode === "resume" ? { resume: "existing" } : { fresh: mode === "fresh" },
      );
      h.native.main("existing", h.directory);
      h.native.override = (method) =>
        method === "thread/timeline/list"
          ? Promise.reject(new Error("Speech history is unavailable"))
          : undefined;
      const offer = async () => {
        const before = h.native.calls.length;
        await h.runtime.offer("sdp");
        const calls = h.native.calls.slice(before);
        expect(calls.map((call) => call.method)).toEqual(["thread/realtime/start"]);
        const request = calls[0]!.params;
        expect(request["threadId"]).toBe(h.runtime.currentReady!.threadId);
        expect(request).not.toHaveProperty("initialItems");
        expect(request).not.toHaveProperty("prompt");
        expect(request["includeStartupContext"]).toBe(false);
        h.native.options.onNotification("thread/realtime/started", request);
      };
      try {
        await h.runtime.start();
        if (mode !== "fresh") {
          expect(h.runtime.currentReady!.threadId).toBe("existing");
          expect(h.native.calls.some((call) => call.method === "thread/resume")).toBe(true);
        }
        await offer();
        await offer();
        await h.runtime.fresh();
        expect(h.runtime.currentReady!.threadId).not.toBe("existing");
        await offer();
        expect(h.native.calls.some((call) => call.method === "thread/timeline/list")).toBe(false);
        expect(h.native.calls.some((call) => call.method === "turn/start")).toBe(false);
      } finally {
        await h.cleanup();
      }
    });
  }

  for (const [voice, expected] of [
    [{ "include-startup-context": true }, { includeStartupContext: true }],
    [{ extra: { includeStartupContext: null } }, { includeStartupContext: null }],
    [{ extra: { initialItems: [] } }, { initialItems: [] }],
    [{ extra: { initialItems: null } }, { initialItems: null }],
    [
      { extra: { initialItems: [{ role: "user", text: "Explicit operator seed" }] } },
      { initialItems: [{ role: "user", text: "Explicit operator seed" }] },
    ],
    [{ version: "v1" }, { version: "v1" }],
  ] satisfies [NonNullable<ConfigValues["voice"]>, Record<string, unknown>][]) {
    test(`native overrides survive resume and redial: ${JSON.stringify(voice)}`, async () => {
      const h = runtimeHarness({ voice });
      h.native.main("existing", h.directory);
      try {
        await h.runtime.start();
        expect(h.native.calls.some((call) => call.method === "thread/resume")).toBe(true);
        for (const sdp of ["first", "redial"]) {
          const before = h.native.calls.length;
          await h.runtime.offer(sdp);
          expect(h.native.calls.slice(before).map((call) => call.method)).toEqual([
            "thread/realtime/start",
          ]);
          const request = h.native.calls.at(-1)!.params;
          expect(request).toMatchObject({ threadId: "existing", ...expected });
          if (!Object.hasOwn(expected, "initialItems"))
            expect(request).not.toHaveProperty("initialItems");
          expect(request).not.toHaveProperty("prompt");
          h.native.options.onNotification("thread/realtime/started", request);
        }
      } finally {
        await h.cleanup();
      }
    });
  }
});

interface ContextCase {
  label: string;
  values: ConfigValues;
  realtime: Record<string, unknown>;
  nativeConfig?: Record<string, unknown>;
}

const cases: ContextCase[] = [
  { label: "unset baseline", values: {}, realtime: {} },
  {
    label: "verbatim shipped example",
    values: parseJsonConfig(
      readFileSync(join(import.meta.dir, "..", "server.json.example"), "utf8"),
      "server.json.example",
    ),
    realtime: {},
  },
  {
    label: "startup off without configuring tail flush",
    values: { voice: { "include-startup-context": false } },
    realtime: { includeStartupContext: false },
  },
  {
    label: "tail flush on without configuring startup context",
    values: { voice: { "flush-transcript-tail-on-session-end": true } },
    realtime: { flushTranscriptTailOnSessionEnd: true },
  },
  {
    label: "raw overrides win, including an empty snapshot",
    values: {
      voice: {
        "include-startup-context": true,
        "flush-transcript-tail-on-session-end": false,
        extra: { includeStartupContext: false, flushTranscriptTailOnSessionEnd: true },
      },
      orchestrator: {
        config: { experimental_realtime_ws_startup_context: "Replaced" },
        extra: { config: { experimental_realtime_ws_startup_context: "" } },
      },
    },
    realtime: { includeStartupContext: false, flushTranscriptTailOnSessionEnd: true },
    nativeConfig: { experimental_realtime_ws_startup_context: "" },
  },
];

for (const include of [false, true]) {
  for (const flush of [false, true]) {
    cases.push({
      label: `explicit startup ${include}, tail flush ${flush}`,
      values: {
        voice: {
          "include-startup-context": include,
          "flush-transcript-tail-on-session-end": flush,
        },
      },
      realtime: { includeStartupContext: include, flushTranscriptTailOnSessionEnd: flush },
    });
  }
}
for (const snapshot of ["", "Operator-provided startup context"]) {
  const nativeConfig = { experimental_realtime_ws_startup_context: snapshot };
  cases.push({
    label: `${snapshot === "" ? "empty" : "custom"} snapshot without configuring either boolean`,
    values: { orchestrator: { config: nativeConfig } },
    realtime: {},
    nativeConfig,
  });
}

describe("native voice context across call and conversation boundaries", () => {
  for (const mode of ["fresh", "continue", "resume"] as const) {
    for (const scenario of cases) {
      test(`${mode}: ${scenario.label} survives redial and Fresh`, async () => {
        const values = parseJsonConfig(JSON.stringify(scenario.values), "test config");
        const options: RuntimeOptions =
          mode === "resume" ? { resume: "existing" } : mode === "fresh" ? { fresh: true } : {};
        const h = runtimeHarness(values, options);
        h.native.main("existing", h.directory);
        try {
          await h.runtime.start();
          const originalThread = h.ready[0]!.threadId;
          if (mode === "fresh") expect(originalThread).not.toBe("existing");
          else expect(originalThread).toBe("existing");

          const offer = async (sdp: string, threadId: string): Promise<void> => {
            await h.runtime.offer(sdp);
            const call = h.native.calls.at(-1)!;
            expect(call.method).toBe("thread/realtime/start");
            // AgentVoice adds no history items or reconnect-specific overrides.
            expect(call.params).toEqual({
              version: "v3",
              includeStartupContext: false,
              threadId,
              realtimeSessionId: expect.any(String),
              outputModality: "audio",
              transport: { type: "webrtc", sdp },
              ...scenario.realtime,
            });
            h.native.options.onNotification("thread/realtime/started", {
              threadId,
              realtimeSessionId: call.params["realtimeSessionId"],
            });
          };
          await offer("initial", originalThread);
          await offer("redial", originalThread);
          await h.runtime.fresh();
          const freshThread = h.ready.at(-1)!.threadId;
          expect(freshThread).not.toBe(originalThread);
          await offer("fresh", freshThread);
          await h.runtime.shutdown();

          const threads = h.native.calls.filter(
            (call) => call.method === "thread/start" || call.method === "thread/resume",
          );
          expect(threads.map((call) => call.method)).toEqual([
            mode === "fresh" ? "thread/start" : "thread/resume",
            "thread/start",
          ]);
          for (const call of threads) {
            if (scenario.nativeConfig === undefined)
              expect(call.params).not.toHaveProperty("config");
            else expect(call.params["config"]).toEqual(scenario.nativeConfig);
          }
          expect(
            h.native.calls
              .filter((call) => call.method === "thread/realtime/stop")
              .map((call) => call.params),
          ).toEqual([{ threadId: originalThread }, { threadId: freshThread }]);
          // Native Codex owns any flush-triggered turn; AgentVoice does not synthesize one.
          expect(h.native.calls.filter((call) => call.method === "turn/start")).toEqual([]);
          expect(h.native.closes).toBe(1);
          expect(h.fatal).toEqual([]);
        } finally {
          await h.cleanup();
        }
      });
    }
  }
});
