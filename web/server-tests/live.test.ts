import { expect, test } from "bun:test";
import { LiveReader } from "../server/live-reader.ts";
import { agentMessage, VoiceMessages } from "../server/messages.ts";
import type { LiveView } from "../src/types.ts";
import { fixture } from "./fixture.ts";

async function until(reader: LiveReader, check: (view: LiveView) => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
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

test("initial history pages stay private while live Agent and Voice items keep updating", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  const delayed = Promise.withResolvers<void>();
  try {
    h.history(Array.from({ length: 5 }, (_, i) => user(`old-${i}`, `History ${i}`)));
    h.delayHistory(delayed.promise);
    await h.start();
    h.feed.conversation({
      event: "conversation.item.started",
      revision: 1,
      data: {
        threadId: "main",
        turnId: "live-turn",
        item: { type: "agentMessage", id: "live", text: "Live Agent" },
      },
    });
    const first = await until(reader, (view) => view.phase === "live");
    expect(first.agent.map((message) => message.content)).toEqual(["Live Agent"]);
    expect(first.agentHistoryLoading).toBe(true);
    expect(first.agentNotice).toBe("Loading earlier messages…");
    h.voice("voice.item.completed", {
      item: {
        type: "transcriptSegment",
        id: "speech",
        realtimeSessionId: "rt",
        role: "user",
        text: "Voice during history loading",
      },
    });
    const during = await until(reader, (value) => value.voice.length === 1);
    expect(during.voice[0]?.content).toBe("Voice during history loading");
    expect(during.agent.map((message) => message.content)).toEqual(["Live Agent"]);
    expect(during.agentHistoryLoading).toBe(true);
    h.delayHistory();
    delayed.resolve();
    const view = await until(reader, (value) => {
      if (!value.agentHistoryLoading) return true;
      expect(value.agent.map((message) => message.content)).toEqual(["Live Agent"]);
      return false;
    });
    expect(view.agent.map((message) => message.content)).toEqual([
      "History 0",
      "History 1",
      "History 2",
      "History 3",
      "History 4",
      "Live Agent",
    ]);
    expect(view.voice[0]?.content).toBe("Voice during history loading");
    expect(view.agentNotice).toBeUndefined();
    expect(h.methods.filter((method) => method === "conversation.items.list")).toHaveLength(3);
  } finally {
    delayed.resolve();
    reader.close();
    await h.close();
  }
});

test("initial history pages finish without waiting for further browser polls", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  try {
    h.history(Array.from({ length: 9 }, (_, i) => user(`row-${i}`, `History ${i}`)));
    await h.start();
    await reader.read();
    for (
      let n = 0;
      n < 100 && h.methods.filter((method) => method === "conversation.items.list").length < 5;
      n++
    )
      await Bun.sleep(5);
    expect(h.methods.filter((method) => method === "conversation.items.list")).toHaveLength(5);
    const ready = await until(reader, (view) => !view.agentHistoryLoading);
    expect(ready.agent).toHaveLength(9);
    expect(ready.agentNotice).toBeUndefined();
  } finally {
    reader.close();
    await h.close();
  }
});

test("a slow first history reply cannot hold the centered loader forever", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir, 50);
  const delayed = Promise.withResolvers<void>();
  try {
    h.delayHistory(delayed.promise);
    await h.start();
    expect((await reader.read()).agentHistoryLoading).toBe(true);
    const ready = await until(reader, (view) => !view.agentHistoryLoading);
    expect(ready.agentNotice).toContain("Showing recent messages");
    delayed.resolve();
    await Bun.sleep(30);
    expect((await reader.read()).agentHistoryLoading).toBe(false);
  } finally {
    delayed.resolve();
    reader.close();
    await h.close();
  }
});

test("failed initial history releases readiness with a notice and no immediate retry loop", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  const delayed = Promise.withResolvers<void>();
  try {
    h.delayHistory(delayed.promise);
    await h.start();
    await reader.read();
    delayed.reject(new Error("History unavailable"));
    const ready = await until(reader, (view) => !view.agentHistoryLoading);
    expect(ready.agentNotice).toContain("unavailable");
    expect(h.methods.filter((method) => method === "conversation.items.list")).toHaveLength(1);
  } finally {
    reader.close();
    await h.close();
  }
});

test("overall readiness waits for the initial Voice file across bounded read passes", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  try {
    for (let index = 0; index < 40; index++)
      h.voice("voice.item.completed", {
        item: {
          type: "transcriptSegment",
          id: `voice-${index}`,
          realtimeSessionId: "rt",
          role: "user",
          text: "Speech ".repeat(9000),
        },
      });
    await h.start();
    const first = await reader.read();
    expect(first.voiceHistoryLoading).toBe(true);
    expect(first.voice.length).toBeLessThan(40);
    const ready = await until(
      reader,
      (view) => view.phase === "live" && !view.voiceHistoryLoading && !view.agentHistoryLoading,
    );
    expect(ready.voice).toHaveLength(40);
  } finally {
    reader.close();
    await h.close();
  }
});

test("history refresh retains the published batch until all replacement pages arrive", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  try {
    h.history([user("old", "Published history")]);
    await h.start();
    await until(reader, (view) => view.agent[0]?.content === "Published history");
    h.history(Array.from({ length: 5 }, (_, i) => user(`new-${i}`, `Replacement ${i}`)));
    h.feed.conversation({
      event: "conversation.turn.completed",
      revision: 1,
      data: { threadId: "main", turnId: "turn", status: "completed" },
    });
    const view = await until(reader, (value) => {
      expect(value.agentHistoryLoading).toBe(false);
      if (value.agent.length === 5) return true;
      expect(value.agent.map((message) => message.content)).toEqual(["Published history"]);
      return false;
    });
    expect(view.agent.map((message) => message.content)).toEqual(
      Array.from({ length: 5 }, (_, i) => `Replacement ${i}`),
    );
  } finally {
    reader.close();
    await h.close();
  }
});

test("a viewer-bounded history pass publishes once without requesting the remaining pages", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  try {
    h.history(Array.from({ length: 36 }, (_, i) => user(`large-${i}`, "x".repeat(250_000))));
    await h.start();
    const view = await until(
      reader,
      (value) => {
        if (value.agentNotice?.includes("viewer limit reached")) return true;
        expect(value.agent).toEqual([]);
        expect(value.agentHistoryLoading).toBe(true);
        return false;
      },
      10_000,
    );
    expect(view.agent).toHaveLength(34);
    expect(view.agent[0]?.id).toBe(JSON.stringify(["turn", "large-2"]));
    expect(view.agent.at(-1)?.id).toBe(JSON.stringify(["turn", "large-35"]));
    expect(view.agentHistoryLoading).toBe(false);
    await Bun.sleep(260);
    await reader.read();
    expect(h.methods.filter((method) => method === "conversation.items.list")).toHaveLength(17);
  } finally {
    reader.close();
    await h.close();
  }
}, 15_000);

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
    expect(h.counts()).toEqual({ starts: 1, closes: 0 });
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

test("read-only web discovery can observe a version-5 controller without changing CLI defaults", async () => {
  const { discoverControllerStatus, publishControlDescriptor } = await import(
    "../../src/control/discovery.ts"
  );
  const { JsonSocketServer } = await import("../../src/ipc/json-socket.ts");
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  await h.control.close();
  const instanceId = h.feed.snapshot().instanceId;
  const legacy = new JsonSocketServer(h.control.socketPath, {
    version: 5,
    handle(request, peer) {
      expect(request.method).toBe("agentvoice.status");
      peer.send({
        v: 5,
        type: "response",
        id: request.id,
        ok: true,
        result: {
          protocolVersion: 5,
          instanceId,
          generation: 1,
          workspace: h.root,
          threadId: "main",
          runtime: { phase: "ready" },
          recentOperations: [],
        },
      });
    },
  });
  await legacy.start();
  const remove = publishControlDescriptor(h.stateDir, {
    version: 1,
    instanceId,
    controllerPid: process.pid,
    socketPath: legacy.path,
    url: h.control.httpUrl,
    token: h.control.bearerToken,
  });
  try {
    await expect(discoverControllerStatus(h.stateDir, h.root, "main")).rejects.toThrow("no live");
    await h.start();
    h.history([user("legacy", "Existing call")]);
    await until(
      reader,
      (view) => view.phase === "live" && view.agent[0]?.content === "Existing call",
    );
    reader.close();
    expect(h.counts()).toEqual({ starts: 1, closes: 0 });
  } finally {
    reader.close();
    remove();
    legacy.close();
    await h.close();
  }
});
