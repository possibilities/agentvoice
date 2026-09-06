import { expect, test } from "bun:test";
import { VoiceMessageStream } from "../scripts/voice-message-stream.ts";

test("streams before completion, reconciles missing deltas, and avoids duplicate text", () => {
  let output = "";
  const stream = new VoiceMessageStream((text) => {
    output += text;
  });
  const item = (event: string, text: string) =>
    stream.accept({
      event: `voice.item.${event}`,
      data: {
        threadId: "thread",
        item: {
          id: "item",
          realtimeSessionId: "session",
          type: "transcriptSegment",
          role: "assistant",
          text,
        },
      },
    });
  item("started", "");
  stream.accept({
    event: "voice.item.transcript.delta",
    data: { threadId: "thread", itemId: "item", delta: "Hello café" },
  });
  expect(output).toBe("assistant: Hello café");
  item("completed", "Hello café 👋");
  expect(output).toBe("assistant: Hello café 👋\n");
});

test("handles unknown starts, interleaving, corrections, and generation boundaries", () => {
  let output = "";
  const stream = new VoiceMessageStream((text) => {
    output += text;
  });
  const item = (id: string, role: string, event: string, text: string, generation = 1) =>
    stream.accept({
      event: `voice.item.${event}`,
      data: {
        instanceId: "controller",
        generation,
        sequence: 1,
        threadId: "thread",
        item: { id, realtimeSessionId: "session", type: "transcriptSegment", role, text },
      },
    });
  const delta = (id: string, text: string, generation = 1) =>
    stream.accept({
      event: "voice.item.transcript.delta",
      data: { instanceId: "controller", generation, threadId: "thread", itemId: id, delta: text },
    });
  delta("unknown", "unattributed");
  expect(output).toBe("");
  item("a", "assistant", "started", "Hi");
  item("u", "user", "started", "Hey");
  delta("a", " there");
  item("u", "user", "completed", "Hey!");
  item("a", "assistant", "completed", "Hello there");
  delta("a", "must not leak", 2);
  item("unknown", "user", "completed", "Joined mid-speech", 2);
  stream.finish();
  expect(output).toBe(
    "assistant: Hi\nuser: Hey\nassistant:  there\nuser: !\nassistant (final): Hello there\nuser: Joined mid-speech\n",
  );
});
