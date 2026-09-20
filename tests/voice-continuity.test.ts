import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VoiceRuntime } from "../src/core/runtime.ts";
import { EVENT_PROTOCOL_VERSION } from "../src/events/contract.ts";
import { recordingDirectory } from "../src/recording/store.ts";
import { VoiceRecording } from "../src/recording/writer.ts";
import { runtimeHarness } from "./fixtures/runtime-harness.ts";

// Incident-shaped observations, not a hosted-model simulator. These tests prove
// that AgentVoice supplies no historical input for native delegation to replay.
for (const [name, history] of [
  [
    "Ledger prior-completion reconnect",
    [
      ["user", "Open Ledger"],
      ["assistant", "Ledger is open. That request is complete."],
    ],
  ],
  [
    "Nevermind / Sounds good restart",
    [
      ["user", "Open Ledger"],
      ["user", "Nevermind"],
      ["assistant", "Sounds good."],
    ],
  ],
] as const) {
  test(`${name} never seeds old requests across any successor boundary`, async () => {
    const h = runtimeHarness({}, { savedThread: "existing" });
    h.native.main("existing", h.directory);
    h.runtimeOptions.nativeStateDir = h.directory;
    const directory = recordingDirectory(h.directory, h.directory);
    const writer = new VoiceRecording(h.directory, directory);
    writer.openThread("existing");
    let replacement: VoiceRuntime | undefined;
    const observations: unknown[] = [];
    h.runtimeOptions.onVoice = (event) => observations.push(event);
    const item = (id: string, session: string, role: "user" | "assistant", text: string) => ({
      id,
      realtimeSessionId: session,
      type: "transcriptSegment",
      role,
      text,
    });
    const offer = async (runtime: VoiceRuntime) => {
      const before = h.native.calls.length;
      await runtime.offer("sdp");
      const calls = h.native.calls.slice(before);
      expect(calls.map((c) => c.method)).toEqual(["thread/realtime/start"]);
      const params = calls[0]!.params;
      expect(params["threadId"]).toBe("existing");
      expect(params).not.toHaveProperty("initialItems");
      expect(params["includeStartupContext"]).toBe(false);
      expect(typeof params["realtimeSessionId"]).toBe("string");
      h.native.options.onNotification("thread/realtime/started", params);
      return params["realtimeSessionId"] as string;
    };
    try {
      await h.runtime.start();
      for (const [index, [role, text]] of history.entries()) {
        const observed = item(String(index), "predecessor", role, text);
        writer.accept({
          v: EVENT_PROTOCOL_VERSION,
          type: "event",
          event: "voice.item.completed",
          data: {
            instanceId: "controller",
            generation: 1,
            sequence: index + 1,
            threadId: "existing",
            item: observed,
          },
        });
        // Also exercise the old runtime-memory restoration path before persistence.
        h.native.options.onNotification("thread/realtime/item/completed", {
          threadId: "existing",
          item: observed,
        });
      }
      const saved = readFileSync(join(directory, "existing.jsonl"));
      const first = await offer(h.runtime);
      const renewed = await offer(h.runtime);
      expect(renewed).not.toBe(first);
      await h.runtime.setVoiceAttached(false);
      await h.runtime.setVoiceAttached(true);
      const reattached = await offer(h.runtime);
      expect(reattached).not.toBe(renewed);
      await h.runtime.shutdown();
      h.native.alive = true;
      replacement = new VoiceRuntime(h.config, "test", h.events, h.runtimeOptions);
      await replacement.start();
      const restarted = await offer(replacement);
      expect(restarted).not.toBe(reattached);
      expect(readFileSync(join(directory, "existing.jsonl"))).toEqual(saved);

      // Identical text is a legitimate fresh utterance with new native identity.
      // It remains observable once; no text-hash suppression or custom dispatch.
      observations.length = 0;
      const fresh = item("fresh-command", restarted, "user", "Open Ledger");
      h.native.options.onNotification("thread/realtime/item/completed", {
        threadId: "existing",
        item: fresh,
      });
      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({ data: { item: fresh } });
      expect(
        h.native.calls.some(
          (c) => c.method === "turn/start" || c.method === "thread/realtime/appendText",
        ),
      ).toBe(false);
    } finally {
      await replacement?.shutdown();
      writer.close("stopped");
      await h.cleanup();
    }
  });
}

describe("explicit operator context remains authoritative", () => {
  for (const initialItems of [[], null, [{ role: "developer", text: "custom" }]]) {
    test(JSON.stringify(initialItems), async () => {
      const h = runtimeHarness({ voice: { extra: { initialItems } } });
      try {
        await h.runtime.start();
        await h.runtime.offer("sdp");
        expect(h.native.calls.at(-1)!.params["initialItems"]).toEqual(initialItems);
      } finally {
        await h.cleanup();
      }
    });
  }
});
