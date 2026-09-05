import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ConfigValues, parseJsonConfig } from "../src/core/config.ts";
import type { RuntimeOptions } from "../src/core/runtime.ts";
import { runtimeHarness } from "./fixtures/runtime-harness.ts";

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
            // Default reconnects add no AgentVoice initial items, transcript or
            // context/tail-flush override: the call matches a first connection.
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
