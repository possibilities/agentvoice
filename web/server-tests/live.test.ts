import { expect, test } from "bun:test";
import { LiveReader } from "../server/live-reader.ts";
import { agentMessage, VoiceMessages } from "../server/messages.ts";
import type { LiveView } from "../src/types.ts";
import { fixture } from "./fixture.ts";

async function until(reader: LiveReader, check: (view: LiveView) => boolean) {
  const deadline = Date.now() + 5000;
  let view = await reader.read();
  while (!check(view) && Date.now() < deadline) {
    await Bun.sleep(260);
    view = await reader.read();
  }
  expect(check(view)).toBe(true);
  return view;
}
const user = (id: string, text: string) => ({
  turnId: "turn",
  item: { type: "userMessage" as const, id, content: [{ type: "text" as const, text }] },
});

test("running server discovery, native history + live drafts, call replacement, and observer-only teardown", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  try {
    expect((await reader.read()).phase).toBe("waiting");
    expect(h.counts()).toEqual({ starts: 0, closes: 0 });
    h.history([user("a", "First"), user("b", "Second"), user("c", "Third")]);
    await h.start();
    h.voice("voice.item.started", {
      item: {
        type: "transcriptSegment",
        id: "speech",
        realtimeSessionId: "rt",
        role: "user",
        text: "Hello",
      },
    });
    h.voice("voice.item.transcript.delta", { itemId: "speech", delta: " there" });
    h.feed.conversation({
      event: "conversation.item.started",
      revision: 1,
      data: {
        threadId: "main",
        turnId: "turn2",
        item: { type: "agentMessage", id: "draft", text: "Live" },
      },
    });
    let view = await until(reader, (value) => value.agent.length === 4 && !value.agentNotice);
    expect(view.agent.map((message) => message.content)).toEqual([
      "First",
      "Second",
      "Third",
      "Live",
    ]);
    expect(view.agent[0]?.createdAt).toBeUndefined();
    expect(view.voice[0]?.content).toBe("Hello there");
    h.voice("voice.item.completed", {
      item: {
        type: "transcriptSegment",
        id: "speech",
        realtimeSessionId: "rt",
        role: "user",
        text: "Hello, there.",
      },
    });
    h.feed.conversation({
      event: "conversation.item.completed",
      revision: 2,
      data: {
        threadId: "main",
        turnId: "turn2",
        item: { type: "agentMessage", id: "draft", text: "Canonical" },
      },
    });
    view = await until(reader, (value) => value.agent.at(-1)?.content === "Canonical");
    expect(view.agent.filter((message) => message.content === "Live")).toHaveLength(0);
    expect(view.voice).toHaveLength(1);
    expect(view.voice[0]?.content).toBe("Hello, there.");
    const privateView = JSON.stringify(view);
    for (const secret of [h.root, h.control.bearerToken, h.control.socketPath])
      expect(privateView).not.toContain(secret);
    const oldId = view.id;
    h.history([user("new", "New generation")]);
    h.replace("successor");
    view = await until(reader, (value) => value.agent[0]?.content === "New generation");
    expect(view.id).not.toBe(oldId);
    expect(view.voice).toEqual([]);
    await h.hangup();
    await until(reader, (value) => value.phase === "waiting" && value.agent.length === 0);
    await h.start();
    await until(reader, (value) => value.phase === "live");
    reader.close();
    expect(h.counts()).toEqual({ starts: 2, closes: 1 });
    expect(new Set(h.methods)).toEqual(
      new Set(["conversation.items.list", "conversation.live.get"]),
    );
  } finally {
    reader.close();
    await h.close();
  }
}, 15_000);

test("late native history cannot populate a successor and a missing server reconnects automatically", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  const delayed = Promise.withResolvers<void>();
  try {
    h.history([user("old", "Old call")]);
    h.delayHistory(delayed.promise);
    await h.start();
    await until(reader, (view) => view.phase === "live");
    h.replace("next");
    h.history([user("new", "Next call")]);
    h.delayHistory();
    delayed.resolve();
    const view = await until(reader, (value) => value.agent[0]?.content === "Next call");
    expect(JSON.stringify(view)).not.toContain("Old call");
    reader.close();
    const absent = new LiveReader(`${h.root}/absent`);
    expect((await absent.read()).phase).toBe("offline");
    absent.close();
  } finally {
    delayed.resolve();
    reader.close();
    await h.close();
  }
});

test("voice gaps and reused IDs stay fenced; unavailable native content remains visible", () => {
  const messages = new VoiceMessages();
  const frame = (generation: number, event: string, data: object) =>
    JSON.stringify({
      v: 2,
      type: "event",
      event,
      data: { ...data, threadId: "thread", instanceId: "controller", generation, sequence: 1 },
    });
  const item = {
    type: "transcriptSegment",
    id: "same",
    realtimeSessionId: "rt",
    role: "assistant",
    text: "Draft",
  };
  messages.accept(frame(1, "voice.item.started", { item }), "thread");
  messages.accept(JSON.stringify({ type: "recording.gap" }), "thread");
  messages.accept(frame(2, "voice.item.completed", { item: { ...item, text: "New" } }), "thread");
  expect(messages.messages().map((message) => message.content)).toEqual(["Draft", "New"]);
  expect(messages.notice).toContain("incomplete");
  expect(
    agentMessage({
      turnId: "t",
      item: { type: "unavailable", id: "u", nativeType: "unknown", reason: "unsupported" },
    })?.status,
  ).toBe("error");
});
