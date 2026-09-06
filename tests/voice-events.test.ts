import { describe, expect, test } from "bun:test";
import {
  MAX_VOICE_EVENT_BYTES,
  nativeVoiceNotification,
  type VoiceNotification,
} from "../src/events/voice.ts";
import { runtimeHarness } from "./fixtures/runtime-harness.ts";

describe("transient native voice items", () => {
  test("preserves typed native items and interleaved deltas without identity inference or history reads", async () => {
    const observed: VoiceNotification[] = [];
    const h = runtimeHarness({}, { onVoice: (value) => observed.push(value) });
    try {
      await h.runtime.start();
      const first = h.runtime.currentReady!.threadId;
      const notify = (method: string, params: Record<string, unknown>) =>
        h.native.options.onNotification(method, params);
      const items = [
        {
          id: "session-start",
          realtimeSessionId: "native-session",
          type: "realtimeSessionStarted",
        },
        {
          id: "user-item",
          realtimeSessionId: "native-session",
          type: "transcriptSegment",
          role: "user",
          text: "Hello 雪",
        },
        {
          id: "assistant-item",
          realtimeSessionId: "native-session",
          type: "transcriptSegment",
          role: "assistant",
          text: "Hello back",
        },
        ...[
          { type: "wholeItem" },
          { type: "inlineMarkdown" },
          { type: "inlineVisualization", index: 2 },
        ].map((presentation, index) => ({
          id: `promotion-${index}`,
          realtimeSessionId: "older-session",
          type: "bemItemPromoted",
          turnId: "turn",
          itemId: "work-item",
          presentation,
        })),
        {
          id: "session-close",
          realtimeSessionId: "native-session",
          type: "realtimeSessionClosed",
          outcome: "ended",
        },
        {
          id: "session-failure",
          realtimeSessionId: "native-session",
          type: "realtimeSessionClosed",
          outcome: "failed",
        },
      ];
      for (const item of items) {
        notify("thread/realtime/item/started", { threadId: first, item });
        notify("thread/realtime/item/completed", { threadId: first, item });
      }
      const deltas = [
        { threadId: first, itemId: "user-item", delta: "Hi " },
        { threadId: first, itemId: "assistant-item", delta: "Hello" },
        { threadId: first, itemId: "user-item", delta: "雪" },
      ];
      for (const data of deltas) notify("thread/realtime/item/transcript/delta", data);
      expect(observed.slice(-3)).toEqual(
        deltas.map((data) => ({ event: "voice.item.transcript.delta", data })),
      );
      expect(observed[0]).toMatchObject({
        event: "voice.item.started",
        data: { threadId: first, item: items[0] },
      });
      expect(observed[11]).toMatchObject({
        data: { item: { realtimeSessionId: "older-session" } },
      });
      expect(h.native.options.optOutNotificationMethods).not.toContain(
        "thread/realtime/item/transcript/delta",
      );
      const count = observed.length;
      notify("thread/realtime/transcript/delta", { threadId: first, delta: "duplicate flat text" });
      notify("thread/realtime/transcript/done", { threadId: first, text: "duplicate flat text" });
      notify("thread/realtime/item/completed", {
        threadId: first,
        item: { ...items[1], audio: "never forward" },
      });
      expect(observed).toHaveLength(count);
      await h.runtime.fresh();
      notify("thread/realtime/item/completed", { threadId: first, item: items[3] });
      expect(observed.at(-1)).toMatchObject({
        data: { threadId: first, item: { realtimeSessionId: "older-session" } },
      });
      expect(h.native.calls.filter((call) => call.method === "thread/read")).toEqual([]);
      await h.runtime.shutdown();
      notify("thread/realtime/item/completed", { threadId: first, item: items[1] });
      expect(observed).toHaveLength(count + 1);
    } finally {
      await h.cleanup();
    }
  });

  test("byte limit drops whole events without truncation, including escaped and multibyte text", () => {
    const method = "thread/realtime/item/transcript/delta";
    const data = { threadId: "thread", itemId: "item", delta: "" };
    const empty = nativeVoiceNotification(method, data)!;
    const room = MAX_VOICE_EVENT_BYTES - Buffer.byteLength(JSON.stringify(empty));
    const exact = nativeVoiceNotification(method, { ...data, delta: "x".repeat(room) });
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(MAX_VOICE_EVENT_BYTES);
    expect(
      nativeVoiceNotification(method, { ...data, delta: "x".repeat(room + 1) }),
    ).toBeUndefined();
    expect(nativeVoiceNotification(method, { ...data, delta: "雪".repeat(room) })).toBeUndefined();
    expect(nativeVoiceNotification(method, { ...data, delta: "\n".repeat(room) })).toBeUndefined();
    expect(
      nativeVoiceNotification(method, { ...data, realtimeSessionId: "invented" }),
    ).toBeUndefined();
    expect(
      nativeVoiceNotification("thread/realtime/item/completed", {
        threadId: "thread",
        item: { id: "item", realtimeSessionId: "native", type: "futureType" },
      }),
    ).toBeUndefined();
  });
});
