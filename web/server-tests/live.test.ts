import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EVENT_PROTOCOL_VERSION } from "../../src/events/contract.ts";
import { projectItem } from "../../src/events/conversation.ts";
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
async function untilTrue(check: () => boolean, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await Bun.sleep(10);
  expect(check()).toBe(true);
}
const user = (id: string, text: string) => ({
  turnId: "turn",
  item: { type: "userMessage" as const, id, content: [{ type: "text" as const, text }] },
});
const delegatedVoice = (id: string, input: string, transcript = input) =>
  user(
    id,
    `<realtime_delegation><input>${input}</input><transcript_delta>user: ${transcript}</transcript_delta></realtime_delegation>`,
  );

test("retains one voice delegation while history briefly exposes its response-item view", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  const input = "Check the duplicated card.";
  const history = delegatedVoice("history-response-item", input);
  const live = delegatedVoice("native-item", input);
  try {
    h.history([history]);
    h.voice("voice.item.completed", {
      item: {
        type: "transcriptSegment",
        id: "spoken-once",
        realtimeSessionId: "rt",
        role: "user",
        text: input,
      },
    });
    await h.start();
    h.feed.conversation({
      event: "conversation.item.completed",
      revision: 1,
      data: { threadId: "main", ...live },
    });
    const view = await until(
      reader,
      (value) =>
        !value.agentHistoryLoading &&
        value.agent.filter((message) => message.presentation?.title === "Via Voice").length === 1,
    );
    const messages = view.agent.filter((message) => message.presentation?.title === "Via Voice");
    expect(messages[0]?.id).toBe(JSON.stringify(["turn", "native-item"]));
    expect(messages[0]?.presentation?.body).toBe(input);
  } finally {
    reader.close();
    await h.close();
  }
});

test("retains repeated voice submissions when the recording has both segments", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  const input = "Repeat this exactly.";
  try {
    h.history([delegatedVoice("first", input), delegatedVoice("second", input)]);
    for (const id of ["spoken-first", "spoken-second"])
      h.voice("voice.item.completed", {
        item: {
          type: "transcriptSegment",
          id,
          realtimeSessionId: "rt",
          role: "user",
          text: input,
        },
      });
    await h.start();
    const view = await until(
      reader,
      (value) =>
        !value.agentHistoryLoading &&
        value.agent.filter((message) => message.presentation?.title === "Via Voice").length === 2,
    );
    expect(
      view.agent.filter((message) => message.presentation?.title === "Via Voice"),
    ).toHaveLength(2);
  } finally {
    reader.close();
    await h.close();
  }
});

test("collapses delayed cumulative delegation snapshots to the fullest saved speech card", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  const tail =
    "dedicate smart agents at each bucket of research, then give Astra the role of planning useful future investigations";
  const extended = `${tail}. I'm joking about agents being unimaginably smart, but you get the idea`;
  const prefix =
    "Send Astra a message that this document should guide future research, capture the desktop evidence, separate the investigation into useful areas, and explain how later workers should improve the shared model. We can keep extending the document as new evidence arrives and ";
  const complete = `${prefix}${extended}. Did you get that?`;
  const delegation = (id: string, input: string, transcript: string) =>
    delegatedVoice(id, input, transcript);
  try {
    h.history([
      delegation("tail-response", tail, complete.slice(0, complete.indexOf(". I'm joking"))),
      delegation("tail-completed", tail, complete.slice(0, complete.indexOf(". I'm joking"))),
      delegation("extended-response", extended, extended),
      delegation("extended-completed", extended, extended),
      delegation(
        "final-response",
        `${extended}. Did you get that?`,
        `${extended}. Did you get that?`,
      ),
      delegation(
        "final-completed",
        `${extended}. Did you get that?`,
        `${extended}. Did you get that?`,
      ),
    ]);
    h.voice("voice.item.completed", {
      item: {
        type: "transcriptSegment",
        id: "one-long-segment",
        realtimeSessionId: "rt",
        role: "user",
        text: complete,
      },
    });
    await h.start();
    const view = await until(
      reader,
      (value) =>
        !value.agentHistoryLoading &&
        value.agent.filter((message) => message.presentation?.title === "Via Voice").length === 1,
    );
    const messages = view.agent.filter((message) => message.presentation?.title === "Via Voice");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe(JSON.stringify(["turn", "tail-completed"]));
    expect(messages[0]?.presentation?.body).toBe(
      complete.slice(0, complete.indexOf(". I'm joking")),
    );
  } finally {
    reader.close();
    await h.close();
  }
});

test("retains unrelated long delegations contained in one saved speech segment", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  const first =
    "Review the deployment evidence and identify every remaining validation gap before delivery.";
  const second =
    "Send the finished report to the existing research worker and ask for a concrete roadmap.";
  try {
    h.history([delegatedVoice("first", first), delegatedVoice("second", second)]);
    h.voice("voice.item.completed", {
      item: {
        type: "transcriptSegment",
        id: "combined-segment",
        realtimeSessionId: "rt",
        role: "user",
        text: `${first} ${second}`,
      },
    });
    await h.start();
    const view = await until(
      reader,
      (value) =>
        !value.agentHistoryLoading &&
        value.agent.filter((message) => message.presentation?.title === "Via Voice").length === 2,
    );
    expect(
      view.agent.filter((message) => message.presentation?.title === "Via Voice"),
    ).toHaveLength(2);
  } finally {
    reader.close();
    await h.close();
  }
});

test("compaction live completion and saved history remain one system event after reconnect", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  const item = { type: "contextCompaction" as const, id: "compact" };
  try {
    await h.start();
    await until(reader, (view) => view.phase === "live" && !view.agentHistoryLoading);
    h.feed.conversation({
      event: "conversation.item.started",
      revision: 1,
      data: { threadId: "main", turnId: "turn", item },
    });
    const started = await until(reader, (view) => view.agent[0]?.status === "working");
    expect(started.agent[0]?.role).toBe("system");
    const id = started.agent[0]?.id;
    h.history([{ turnId: "turn", item }]);
    h.feed.conversation({
      event: "conversation.item.completed",
      revision: 2,
      data: { threadId: "main", turnId: "turn", item },
    });
    const completed = await until(reader, (view) => view.agent[0]?.status === "complete");
    expect(completed.agent).toHaveLength(1);
    expect(completed.agent[0]?.id).toBe(id);
    reader.close();
    const replay = new LiveReader(h.stateDir);
    try {
      const restored = await until(
        replay,
        (view) => view.agent.length === 1 && !view.agentHistoryLoading,
      );
      expect(restored.agent).toEqual(completed.agent);
      expect(restored.voice).toEqual([]);
    } finally {
      replay.close();
    }
  } finally {
    reader.close();
    await h.close();
  }
});

test("subagent lifecycle envelopes and saved history reconcile without duplicating cards", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  const item = {
    type: "subAgentActivity" as const,
    id: "spawn",
    kind: "started" as const,
    agentPath: "/root/check",
    agentThreadId: "child",
  };
  try {
    await h.start();
    await until(reader, (view) => view.phase === "live" && !view.agentHistoryLoading);
    h.feed.conversation({
      event: "conversation.item.started",
      revision: 1,
      data: { threadId: "main", turnId: "turn", item },
    });
    const started = await until(
      reader,
      (view) => view.agent[0]?.nativeItemType === "subAgentActivity",
    );
    expect(started.agent[0]?.role).toBe("system");
    const id = started.agent[0]?.id;
    const sentinel = user("after-event", "After lifecycle event");
    h.history([{ turnId: "turn", item }, sentinel]);
    h.feed.conversation({
      event: "conversation.item.completed",
      revision: 2,
      data: { threadId: "main", turnId: "turn", item },
    });
    h.feed.conversation({
      event: "conversation.item.completed",
      revision: 3,
      data: { threadId: "main", ...sentinel },
    });
    const completed = await until(reader, (view) => view.agent.length === 2);
    expect(
      completed.agent.filter((message) => message.nativeItemType === "subAgentActivity"),
    ).toHaveLength(1);
    expect(completed.agent[0]?.id).toBe(id);
    reader.close();
    const replay = new LiveReader(h.stateDir);
    try {
      const restored = await until(
        replay,
        (view) => view.agent.length === 2 && !view.agentHistoryLoading,
      );
      expect(restored.agent).toEqual(completed.agent);
      expect(restored.voice).toEqual([]);
    } finally {
      replay.close();
    }
  } finally {
    reader.close();
    await h.close();
  }
});

test("observed lifecycle cards survive later history replacement and live projection eviction", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  const before = user("before-lifecycle", "Before lifecycle event");
  const lifecycle = {
    type: "subAgentActivity" as const,
    id: "completion",
    kind: "completed" as const,
    agentPath: "/root/check",
    agentThreadId: "child",
  };
  try {
    h.history([before]);
    await h.start();
    await until(reader, (view) => view.agent.length === 1 && !view.agentHistoryLoading);
    h.feed.conversation({
      event: "conversation.item.completed",
      revision: 1,
      data: { threadId: "main", turnId: "lifecycle-turn", item: lifecycle },
    });
    const observed = await until(
      reader,
      (view) => view.agent[1]?.nativeItemType === "subAgentActivity",
    );
    const lifecycleId = observed.agent[1]!.id;

    const later = Array.from({ length: 130 }, (_, index) =>
      user(`later-${index}`, `Later message ${index}`),
    );
    // Native paginated history may omit these ephemeral lifecycle observations.
    h.history([before, ...later]);
    for (const [index, entry] of later.entries())
      h.feed.conversation({
        event: "conversation.item.completed",
        revision: index + 2,
        data: { threadId: "main", ...entry },
      });

    const replaced = await until(
      reader,
      (view) => view.agent.length === later.length + 2 && !view.agentHistoryLoading,
    );
    expect(replaced.agent[0]?.content).toBe("Before lifecycle event");
    expect(replaced.agent[1]?.id).toBe(lifecycleId);
    expect(replaced.agent[1]?.presentation?.details).toContainEqual({
      label: "Agent thread",
      content: "child",
    });
    expect(replaced.agent[2]?.content).toBe("Later message 0");
    expect(
      replaced.agent.filter((message) => message.nativeItemType === "subAgentActivity"),
    ).toHaveLength(1);

    h.stopEvents();
    await until(reader, (view) => view.phase === "unavailable");
    await h.startEvents();
    const reconnected = await until(
      reader,
      (view) => view.phase === "live" && view.agent.length === later.length + 2,
    );
    expect(reconnected.agent.map((message) => message.id)).toEqual(
      replaced.agent.map((message) => message.id),
    );
  } finally {
    reader.close();
    await h.close();
  }
});

test("compaction history cannot move an observed completion back into its initiating turn", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  const before = user("before-lifecycle", "Before child completion");
  const later = user("later-turn", "A later turn finished while the child kept working");
  const lifecycle = {
    type: "subAgentActivity" as const,
    id: "delayed-completion",
    kind: "completed" as const,
    agentPath: "/root/delayed_worker",
    agentThreadId: "child",
  };
  const compaction = { type: "contextCompaction" as const, id: "compact" };
  try {
    h.history([before, later]);
    await h.start();
    await until(reader, (view) => view.agent.length === 2 && !view.agentHistoryLoading);

    // Codex attributes the completion to the older initiating turn, but the
    // live observation appears after the later turn and is shown there first.
    h.feed.conversation({
      event: "conversation.item.completed",
      revision: 1,
      data: { threadId: "main", turnId: "initiating-turn", item: lifecycle },
    });
    const observed = await until(
      reader,
      (view) => view.agent.at(-1)?.nativeItemType === "subAgentActivity",
    );
    const lifecycleId = observed.agent.at(-1)!.id;

    // After compaction, canonical history places the lifecycle item inside its
    // initiating turn, before the later conversation that preceded observation.
    h.history([
      before,
      { turnId: "initiating-turn", item: lifecycle },
      later,
      { turnId: "compaction-turn", item: compaction },
    ]);
    h.feed.conversation({
      event: "conversation.item.completed",
      revision: 2,
      data: { threadId: "main", turnId: "compaction-turn", item: compaction },
    });

    const refreshed = await until(
      reader,
      (view) => view.agent.at(-1)?.nativeItemType === "contextCompaction",
    );
    expect(refreshed.agent.map((message) => message.id)).toEqual([
      JSON.stringify(["turn", "before-lifecycle"]),
      JSON.stringify(["turn", "later-turn"]),
      lifecycleId,
      JSON.stringify(["compaction-turn", "compact"]),
    ]);
  } finally {
    reader.close();
    await h.close();
  }
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
    await untilTrue(
      () => h.methods.filter((method) => method === "conversation.items.list").length === 1,
    );
    delayed.reject(new Error("History unavailable"));
    const ready = await until(reader, (view) => !view.agentHistoryLoading);
    expect(ready.agentNotice).toContain("unavailable");
    expect(h.methods.filter((method) => method === "conversation.items.list")).toHaveLength(1);
  } finally {
    reader.close();
    await h.close();
  }
});

test("a new reader retries earlier history during an active root turn without another browser poll", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir, 50, 50);
  try {
    h.history(Array.from({ length: 5 }, (_, index) => user(`active-${index}`, `Earlier ${index}`)));
    h.feed.update({
      complete: true,
      threads: [
        {
          id: "main",
          parentThreadId: null,
          name: null,
          status: "active",
          activeFlags: [],
          turn: { id: "working", status: "inProgress" },
        },
      ],
    });
    h.failHistory("busy");
    await h.start();

    const initial = await reader.read();
    expect(initial.phase).toBe("live");
    expect(initial.agentControls?.available).toBe(true);
    expect(initial.agentHistoryLoading).toBe(true);

    // The retry timer and page chain run independently of the HTTP polling loop.
    await untilTrue(
      () => h.methods.filter((method) => method === "conversation.items.list").length === 4,
    );
    const recovered = await reader.read();
    expect(recovered.agent.map((message) => message.content)).toEqual([
      "Earlier 0",
      "Earlier 1",
      "Earlier 2",
      "Earlier 3",
      "Earlier 4",
    ]);
    expect(recovered.agentHistoryLoading).toBe(false);
    expect(recovered.agentNotice).toBeUndefined();
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

test("server and workspace-session lifecycle matrix preserves only authoritative retained state", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  try {
    expect((await reader.read()).phase).toBe("empty");
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
    const oldScope = view.persistenceScope;
    h.history([user("new", "New generation")]);
    h.replace("successor");
    view = await until(reader, (value) => value.agent[0]?.content === "New generation");
    expect(view.id).not.toBe(oldId);
    expect(view.persistenceScope).not.toBe(oldScope);
    expect(view.voice).toEqual([]);
    const attachedId = view.id;
    const successorScope = view.persistenceScope;
    await h.hangup();
    view = await until(reader, (value) => value.phase === "detached");
    expect(view.id).toBe(attachedId);
    expect(view.persistenceScope).toBe(successorScope);
    expect(view.agent.map((message) => message.content)).toEqual(["New generation"]);
    // This projection intentionally has no root turn state; reachability alone cannot invent it.
    expect(view.agentControls?.available).toBe(false);
    h.feed.conversation({
      event: "conversation.item.started",
      revision: 3,
      data: {
        threadId: "successor",
        turnId: "detached-turn",
        item: { type: "agentMessage", id: "detached-work", text: "Native work continued" },
      },
    });
    view = await until(reader, (value) =>
      value.agent.some((message) => message.content === "Native work continued"),
    );
    const detachedId = view.id;
    await h.start();
    view = await until(reader, (value) => value.phase === "live");
    expect(view.id).toBe(detachedId);
    expect(view.persistenceScope).toBe(successorScope);
    expect(view.agent.some((message) => message.content === "Native work continued")).toBe(true);
    const reattachedId = view.id;
    h.failNextDetach();
    h.hideCallIdentity();
    await h.hangup();
    view = await until(reader, (value) => value.phase === "unavailable");
    expect(view.id).toBe(reattachedId);
    expect(view.persistenceScope).toBe(successorScope);
    expect(view.agent.some((message) => message.content === "Native work continued")).toBe(true);
    expect(view.agentControls?.available).toBe(false);
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

test("history reader keeps oversized tool identity and true failure state", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  try {
    const tool = (id: string, status: "completed" | "failed") => ({
      turnId: "turn",
      item: projectItem({
        type: "mcpToolCall",
        id,
        server: "inventory",
        tool: "refresh",
        status,
        arguments: {},
        result: { content: [{ type: "text", text: "result ".repeat(20_000) }] },
        ...(status === "failed"
          ? { error: { type: "service_error", message: "Inventory is temporarily offline." } }
          : {}),
      }),
    });
    h.history([tool("completed", "completed"), tool("failed", "failed")]);
    await h.start();
    const view = await until(reader, (candidate) => !candidate.agentHistoryLoading);
    expect(view.agent).toHaveLength(2);
    expect(view.agent[0]).toMatchObject({
      status: "complete",
      toolActivity: { name: "refresh", state: "complete" },
    });
    expect(view.agent[1]).toMatchObject({
      status: "error",
      toolActivity: { name: "refresh", state: "error" },
    });
    expect(view.agent[1]?.toolActivity?.sections).toContainEqual({
      label: "Error",
      content: "Inventory is temporarily offline.",
    });
    expect(JSON.stringify(view)).not.toContain("Content unavailable (oversized)");
  } finally {
    reader.close();
    await h.close();
  }
});

test("event transport reconnect preserves one verified view while fencing actions", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  const delayed = Promise.withResolvers<void>();
  try {
    h.history([user("kept", "Verified cached history")]);
    await h.start();
    const live = await until(
      reader,
      (view) => view.agent[0]?.content === "Verified cached history",
    );
    const { id, persistenceScope } = live;
    expect(persistenceScope).toMatch(/^[a-f0-9]{64}$/);

    const liveReads = h.methods.filter((method) => method === "conversation.live.get").length;
    h.delayLive(delayed.promise);
    await Bun.sleep(260);
    const pending = reader.read();
    await untilTrue(
      () => h.methods.filter((method) => method === "conversation.live.get").length > liveReads,
    );
    h.stopEvents();
    h.delayLive();
    delayed.resolve();
    const unavailable = await pending;
    expect(unavailable.phase).toBe("unavailable");
    expect(unavailable.id).toBe(id);
    expect(unavailable.persistenceScope).toBe(persistenceScope);
    expect(unavailable.agent.map((message) => message.content)).toEqual([
      "Verified cached history",
    ]);
    expect(unavailable.agentControls?.available).toBe(false);
    await expect(
      reader.agentCommand({
        action: "send",
        viewId: id,
        requestId: randomUUID(),
        text: "must stay local",
      }),
    ).rejects.toThrow("call changed");

    await h.startEvents();
    const recovered = await until(reader, (view) => view.phase === "live");
    expect(recovered.id).toBe(id);
    expect(recovered.persistenceScope).toBe(persistenceScope);
    expect(recovered.agent.map((message) => message.content)).toEqual(["Verified cached history"]);

    const diagnosticsPath = join(h.stateDir, "web", "reader-diagnostics.jsonl");
    const diagnostics = readFileSync(diagnosticsPath, "utf8");
    expect(lstatSync(diagnosticsPath).mode & 0o077).toBe(0);
    expect(diagnostics).toContain('"stage":"events.closed"');
    expect(diagnostics).toContain('"error":"disconnected"');
    for (const secret of [
      h.root,
      h.control.bearerToken,
      h.control.socketPath,
      "Verified cached history",
    ])
      expect(diagnostics).not.toContain(secret);
  } finally {
    delayed.resolve();
    reader.close();
    await h.close();
  }
});

test("observer closure during an in-flight read retains the verified session", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  const delayed = Promise.withResolvers<void>();
  try {
    h.history([user("kept", "Verified through observer closure")]);
    await h.start();
    const initial = await until(
      reader,
      (view) => view.agent[0]?.content === "Verified through observer closure",
    );
    const liveReads = h.methods.filter((method) => method === "conversation.live.get").length;
    h.delayLive(delayed.promise);
    await Bun.sleep(260);
    const pending = reader.read();
    await untilTrue(
      () => h.methods.filter((method) => method === "conversation.live.get").length > liveReads,
    );
    await h.stopFrontend();
    h.delayLive();
    delayed.resolve();
    const unavailable = await pending;
    expect(["offline", "unavailable"]).toContain(unavailable.phase);
    expect(unavailable.id).toBe(initial.id);
    expect(unavailable.persistenceScope).toBe(initial.persistenceScope);
    expect(unavailable.agent.map((message) => message.content)).toEqual([
      "Verified through observer closure",
    ]);
    expect(unavailable.agentControls?.available).toBe(false);
  } finally {
    delayed.resolve();
    reader.close();
    await h.close();
  }
});

test("a confirmed replacement wins over an event closure during an in-flight read", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  const delayed = Promise.withResolvers<void>();
  try {
    h.history([user("old", "Predecessor must not leak")]);
    await h.start();
    const initial = await until(
      reader,
      (view) => view.agent[0]?.content === "Predecessor must not leak",
    );
    const liveReads = h.methods.filter((method) => method === "conversation.live.get").length;
    h.delayLive(delayed.promise);
    await Bun.sleep(260);
    const pending = reader.read();
    await untilTrue(
      () => h.methods.filter((method) => method === "conversation.live.get").length > liveReads,
    );
    h.replace("successor");
    // Let the observer accept the replacement before the independent event transport closes.
    await Bun.sleep(20);
    h.stopEvents();
    h.delayLive();
    delayed.resolve();
    const fenced = await pending;
    expect(fenced.id).not.toBe(initial.id);
    expect(JSON.stringify(fenced)).not.toContain("Predecessor must not leak");
    expect(fenced.agentControls?.available ?? false).toBe(false);
  } finally {
    delayed.resolve();
    reader.close();
    await h.close();
  }
});

test("a timed-out history socket cannot kill live observation and retries independently", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir, 50, 50);
  const delayed = Promise.withResolvers<void>();
  try {
    h.history([user("published", "Published before timeout")]);
    await h.start();
    const initial = await until(
      reader,
      (view) => view.agent[0]?.content === "Published before timeout",
    );
    h.history([user("replacement", "Recovered history")]);
    h.delayHistory(delayed.promise);
    h.feed.conversation({
      event: "conversation.turn.completed",
      revision: 1,
      data: { threadId: "main", turnId: "turn", status: "completed" },
    });
    await Bun.sleep(260);
    await reader.read();
    await Bun.sleep(5_100);
    h.feed.conversation({
      event: "conversation.item.started",
      revision: 2,
      data: {
        threadId: "main",
        turnId: "live-turn",
        item: { type: "agentMessage", id: "still-live", text: "Live after history timeout" },
      },
    });
    const during = await until(reader, (view) =>
      view.agent.some((message) => message.content === "Live after history timeout"),
    );
    expect(during.phase).toBe("live");
    expect(during.id).toBe(initial.id);
    expect(during.agent.some((message) => message.content === "Published before timeout")).toBe(
      true,
    );
    expect(during.agentNotice).toContain("Retrying in the background");

    h.delayHistory();
    delayed.resolve();
    const recovered = await until(reader, (view) =>
      view.agent.some((message) => message.content === "Recovered history"),
    );
    expect(recovered.id).toBe(initial.id);
    expect(recovered.agent.some((message) => message.content === "Published before timeout")).toBe(
      false,
    );
  } finally {
    delayed.resolve();
    reader.close();
    await h.close();
  }
}, 10_000);

test("a timed-out live read retains verified rows and reconnects the same incarnation", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  const delayed = Promise.withResolvers<void>();
  try {
    h.history([user("verified", "Visible through live timeout")]);
    await h.start();
    const initial = await until(
      reader,
      (view) => view.agent[0]?.content === "Visible through live timeout",
    );
    h.delayLive(delayed.promise);
    await Bun.sleep(260);
    const unavailable = await reader.read();
    expect(unavailable.phase).toBe("unavailable");
    expect(unavailable.id).toBe(initial.id);
    expect(unavailable.agent.map((message) => message.content)).toEqual([
      "Visible through live timeout",
    ]);
    expect(unavailable.agentControls?.available).toBe(false);
    const diagnostics = readFileSync(join(h.stateDir, "web", "reader-diagnostics.jsonl"), "utf8");
    expect(diagnostics).toContain('"stage":"conversation.live"');
    expect(diagnostics).toContain('"error":"timeout"');

    h.delayLive();
    delayed.resolve();
    const recovered = await until(reader, (view) => view.phase === "live");
    expect(recovered.id).toBe(initial.id);
    expect(recovered.agent.map((message) => message.content)).toEqual([
      "Visible through live timeout",
    ]);
  } finally {
    delayed.resolve();
    reader.close();
    await h.close();
  }
}, 10_000);

test("capacity pressure before the first verified live read keeps input fenced", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  try {
    h.failLive("busy");
    await h.start();
    const unavailable = await reader.read();
    expect(unavailable.phase).toBe("unavailable");
    expect(unavailable.agentControls?.available).toBe(false);
    expect(unavailable.agentControls?.inputUnavailableReason).toContain(
      "transcript reader reconnects",
    );
    expect(unavailable.agentNotice).not.toBe(
      "Agent transcript is catching up. Input remains available.",
    );
  } finally {
    reader.close();
    await h.close();
  }
});

test("native observation capacity pressure keeps verified input available while catching up", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  try {
    h.history([user("verified", "Visible through capacity pressure")]);
    h.feed.update({
      complete: true,
      threads: [
        {
          id: "main",
          parentThreadId: null,
          name: null,
          status: "idle",
          activeFlags: [],
          turn: null,
        },
      ],
    });
    await h.start();
    const initial = await until(
      reader,
      (view) =>
        view.agent[0]?.content === "Visible through capacity pressure" &&
        view.agentControls?.available === true,
    );

    h.failLive("busy");
    await Bun.sleep(260);
    const busy = await reader.read();
    expect(busy.phase).toBe("live");
    expect(busy.id).toBe(initial.id);
    expect(busy.agentControls?.available).toBe(true);
    expect(busy.agentControls?.inputUnavailableReason).toBeUndefined();
    expect(busy.agentNotice).toBe("Agent transcript is catching up. Input remains available.");

    h.failLive("unavailable");
    await Bun.sleep(260);
    const unavailable = await reader.read();
    expect(unavailable.phase).toBe("unavailable");
    expect(unavailable.agentControls?.available).toBe(false);
    expect(unavailable.agentControls?.inputUnavailableReason).toContain(
      "transcript reader reconnects",
    );
  } finally {
    reader.close();
    await h.close();
  }
});

test("replacement during reader recovery cannot inherit cache, actions, or incarnation", async () => {
  const h = await fixture();
  const reader = new LiveReader(h.stateDir);
  try {
    h.history([user("old", "Old verified call")]);
    await h.start();
    const old = await until(reader, (view) => view.agent[0]?.content === "Old verified call");
    h.stopEvents();
    await until(reader, (view) => view.phase === "unavailable");
    await Bun.sleep(260);
    await reader.read();

    h.replace();
    h.history([user("new", "Successor only")]);
    const fenced = await until(reader, (view) => view.id !== old.id);
    expect(fenced.id).not.toBe(old.id);
    expect(fenced.persistenceScope).toBe(old.persistenceScope);
    expect(JSON.stringify(fenced.agent)).not.toContain("Old verified call");
    expect(fenced.agentControls?.available).toBe(false);

    await h.startEvents();
    const successor = await until(reader, (view) => view.agent[0]?.content === "Successor only");
    expect(successor.id).toBe(fenced.id);
    expect(successor.persistenceScope).toBe(fenced.persistenceScope);
    expect(JSON.stringify(successor)).not.toContain("Old verified call");
  } finally {
    reader.close();
    await h.close();
  }
});

test("voice gaps and reused IDs stay fenced; unavailable native content remains visible", () => {
  const messages = new VoiceMessages();
  const frame = (generation: number, event: string, data: object) =>
    JSON.stringify({
      v: EVENT_PROTOCOL_VERSION,
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
  ).toBe("complete");
});

test("empty voice starts remain empty across recording boundaries", () => {
  const frame = (event: string) =>
    JSON.stringify({
      v: EVENT_PROTOCOL_VERSION,
      type: "event",
      event,
      data: {
        threadId: "thread",
        instanceId: "controller",
        generation: 1,
        sequence: 1,
        item: {
          type: "transcriptSegment",
          id: "empty",
          realtimeSessionId: "rt",
          role: "user",
          text: "",
        },
      },
    });

  for (const boundary of [
    { type: "recording.gap", reason: "previous_recording_interrupted" },
    { type: "recording.gap", reason: "runtime_replaced" },
    { type: "recording.gap", reason: "runtime_replacement_interrupted" },
    { type: "recording.ended", reason: "stopped" },
  ]) {
    const messages = new VoiceMessages();
    messages.accept(frame("voice.item.started"), "thread");
    messages.accept(JSON.stringify(boundary), "thread");
    expect(messages.messages()).toEqual([]);
    expect(messages.notice).toBeUndefined();
  }
});

test("empty pending voice stays hidden until transcript text arrives", () => {
  const messages = new VoiceMessages();
  const data = {
    threadId: "thread",
    instanceId: "controller",
    generation: 1,
    sequence: 1,
  };
  messages.accept(
    JSON.stringify({
      v: EVENT_PROTOCOL_VERSION,
      type: "event",
      event: "voice.item.started",
      data: {
        ...data,
        item: {
          type: "transcriptSegment",
          id: "pending",
          realtimeSessionId: "rt",
          role: "user",
          text: "",
        },
      },
    }),
    "thread",
  );
  expect(messages.messages()).toEqual([]);
  messages.accept(
    JSON.stringify({
      v: EVENT_PROTOCOL_VERSION,
      type: "event",
      event: "voice.item.transcript.delta",
      data: { ...data, sequence: 2, itemId: "pending", delta: "Now audible" },
    }),
    "thread",
  );
  expect(messages.messages()).toMatchObject([{ content: "Now audible", status: "streaming" }]);
});

test("recording gaps before speech do not leave a stale notice on later complete speech", () => {
  for (const boundary of [
    { type: "recording.gap", reason: "unfinished_record_recovered" },
    { type: "recording.gap", reason: "recording_failed" },
    { type: "recording.gap", reason: "unrecognized_future_reason" },
    { type: "recording.ended", reason: "error" },
  ]) {
    const messages = new VoiceMessages();
    messages.accept(JSON.stringify(boundary), "thread");
    expect(messages.messages()).toEqual([]);
    expect(messages.notice).toBeUndefined();
    messages.accept(
      JSON.stringify({
        v: EVENT_PROTOCOL_VERSION,
        type: "event",
        event: "voice.item.completed",
        data: {
          threadId: "thread",
          instanceId: "controller",
          generation: 1,
          sequence: 1,
          item: {
            type: "transcriptSegment",
            id: "later",
            realtimeSessionId: "rt",
            role: "user",
            text: "Complete speech after the empty gap",
          },
        },
      }),
      "thread",
    );
    expect(messages.messages()).toMatchObject([
      { content: "Complete speech after the empty gap", status: "complete" },
    ]);
    expect(messages.notice).toBeUndefined();
    messages.accept(
      JSON.stringify({ type: "recording.gap", reason: "recording_failed" }),
      "thread",
    );
    expect(messages.notice).toBe("Some voice text is incomplete.");
  }
});

test("recording boundaries preserve non-empty unfinished speech as incomplete", () => {
  const frame = JSON.stringify({
    v: EVENT_PROTOCOL_VERSION,
    type: "event",
    event: "voice.item.started",
    data: {
      threadId: "thread",
      instanceId: "controller",
      generation: 1,
      sequence: 1,
      item: {
        type: "transcriptSegment",
        id: "draft",
        realtimeSessionId: "rt",
        role: "user",
        text: "Partially heard",
      },
    },
  });

  for (const boundary of ["recording.gap", "recording.ended"]) {
    const messages = new VoiceMessages();
    messages.accept(frame, "thread");
    messages.accept(JSON.stringify({ type: boundary }), "thread");
    expect(messages.messages()).toMatchObject([{ content: "Partially heard", status: "error" }]);
    expect(messages.notice).toBe("Some voice text is incomplete.");
  }
});

for (const version of [5, 6, 7, 8] as const)
  test(`read-only web discovery can observe a version-${version} controller without changing CLI defaults`, async () => {
    const { discoverControllerStatus, publishControlDescriptor } = await import(
      "../../src/control/discovery.ts"
    );
    const { JsonSocketServer } = await import("../../src/ipc/json-socket.ts");
    const h = await fixture();
    const reader = new LiveReader(h.stateDir);
    await h.control.close();
    const instanceId = h.feed.snapshot().instanceId;
    const legacy = new JsonSocketServer(h.control.socketPath, {
      version,
      handle(request, peer) {
        expect(request.method).toBe("agentvoice.status");
        peer.send({
          v: version,
          type: "response",
          id: request.id,
          ok: true,
          result: {
            protocolVersion: version,
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
