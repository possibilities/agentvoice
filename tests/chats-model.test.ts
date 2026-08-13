import { describe, expect, test } from "bun:test";
import {
  ChatsModel,
  displayRole,
  displayStatus,
  MAX_EVENTS_PER_THREAD,
  MAX_VOICE_EVENTS_PER_SESSION,
  MAX_VOICE_SESSIONS,
  threadCard,
  VOICE_STREAM_ID,
} from "../src/chats/model.ts";

function envelope(
  direction: "toAppServer" | "fromAppServer",
  owner: "agentvoice" | "client" | "appServer",
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return { direction, owner, payload };
}

describe("chats thread model", () => {
  test("builds identifying cards and orders by recency", () => {
    const model = new ChatsModel();
    const cards = model.replaceThreads([
      {
        id: "older",
        name: null,
        preview: "Older conversation text that must not become a title",
        status: { type: "idle" },
        threadSource: "agentvoice-worker",
        modelProvider: "openai",
        cwd: "/tmp/a",
        parentThreadId: "root",
        createdAt: 1,
        updatedAt: 2,
      },
      {
        id: "newer",
        name: "Named thread",
        preview: "preview",
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
        threadSource: "agentvoice-orchestrator",
        modelProvider: "openai",
        cwd: "/tmp/b",
        parentThreadId: null,
        createdAt: 3,
        updatedAt: 4,
      },
    ]);

    expect(cards.map((card) => card.id)).toEqual(["newer", "older"]);
    expect(cards[0]).toMatchObject({
      name: "Named thread",
      role: "orchestrator",
      status: "active / waitingOnApproval",
    });
    expect(cards[1]).toMatchObject({ name: "worker older", role: "worker" });
    expect(cards[1]?.name).not.toContain("conversation text");
  });

  test("falls back safely for partial future thread shapes", () => {
    expect(threadCard({ id: "thread-id" })).toMatchObject({
      name: "thread thread-i",
      status: "unknown",
      role: "thread",
    });
    expect(threadCard({ nope: true })).toBeNull();
    expect(displayRole({ agentRole: "reviewer" })).toBe("reviewer");
    expect(displayRole({ source: { subAgent: { other: "guardian" } } })).toBe("guardian");
    expect(displayRole({ source: { subagent: { other: "guardian" } } })).toBe("guardian");
    expect(displayRole({ source: { subAgent: { threadSpawn: { agentRole: "explorer" } } } })).toBe(
      "explorer",
    );
    expect(displayStatus("idle")).toBe("idle");
  });

  test("forgets raw events when a thread is no longer loaded", () => {
    const model = new ChatsModel();
    model.replaceThreads([{ id: "thread-a" }]);
    model.recordEnvelope(
      envelope("fromAppServer", "appServer", {
        method: "turn/started",
        params: { threadId: "thread-a" },
      }),
    );
    model.replaceThreads([]);
    expect(model.events.has("thread-a")).toBe(false);
  });

  test("overlays AgentVoice-owned roles without changing raw App-server metadata", () => {
    const model = new ChatsModel();
    model.replaceThreads([
      {
        id: "root-thread",
        name: null,
        threadSource: null,
        source: "appServer",
      },
    ]);
    expect(model.threads.get("root-thread")?.role).toBe("thread");

    model.replaceAgentVoiceThreadIdentities([
      { threadId: "root-thread", role: "orchestrator" },
      { threadId: "ignored", role: "guardian" },
    ]);

    expect(model.threads.get("root-thread")).toMatchObject({
      name: "orchestrator root-thr",
      role: "orchestrator",
    });
    expect(model.threads.get("root-thread")?.raw["threadSource"]).toBeNull();
  });
});

describe("chats raw event model", () => {
  test("keeps Voice Sessions distinct and preserves raw event payload identity", () => {
    const model = new ChatsModel();
    model.replaceThreads([{ id: "thread-a", updatedAt: 10 }]);
    const payload = {
      type: "response.done",
      response: { id: "response-1", futureField: [1, true, null] },
    };

    model.recordVoiceObservation(
      {
        kind: "lifecycle",
        voiceSessionId: "voice-a",
        threadId: "thread-a",
        state: "starting",
        observedAt: 120,
      },
      121,
    );
    const event = model.recordVoiceObservation(
      {
        kind: "event",
        voiceSessionId: "voice-a",
        threadId: "thread-a",
        sequence: 1,
        observedAt: 122,
        payload,
      },
      123,
    );

    expect(model.sortedStreams.map((stream) => [stream.kind, stream.id])).toEqual([
      ["voice", VOICE_STREAM_ID],
      ["thread", "thread-a"],
    ]);
    expect(event).toMatchObject({
      kind: "voice",
      receivedAt: 123,
      voiceSessionId: "voice-a",
      threadId: "thread-a",
      observedAt: 122,
    });
    expect(event?.observation.kind).toBe("event");
    if (event?.observation.kind === "event") expect(event.observation.payload).toBe(payload);
    expect(model.voiceSessionList).toMatchObject([
      {
        id: "voice-a",
        threadId: "thread-a",
        state: "starting",
        firstObservedAt: 120,
        lastObservedAt: 122,
      },
    ]);
    expect(model.voiceSessionList[0]?.observations).toHaveLength(2);
    expect(model.events.has(VOICE_STREAM_ID)).toBe(false);
    expect(model.threads.has(VOICE_STREAM_ID)).toBe(false);
    expect(model.events.has("thread-a")).toBe(false);
  });

  test("bounds raw rows per voice session and retains only the latest sessions", () => {
    const model = new ChatsModel();
    model.recordVoiceObservation({
      kind: "lifecycle",
      voiceSessionId: "voice-bounded",
      threadId: "thread-a",
      state: "active",
      observedAt: 1,
    });
    for (let index = 0; index < MAX_VOICE_EVENTS_PER_SESSION + 3; index++) {
      model.recordVoiceObservation({
        kind: "event",
        voiceSessionId: "voice-bounded",
        threadId: "thread-a",
        sequence: index + 1,
        observedAt: index + 2,
        payload: { type: "voice.test", index },
      });
    }

    const bounded = model.voiceSessions.get("voice-bounded");
    expect(bounded?.observations.filter((row) => row.observation.kind === "event")).toHaveLength(
      MAX_VOICE_EVENTS_PER_SESSION,
    );
    expect(bounded?.observations.some((row) => row.observation.kind === "lifecycle")).toBe(true);
    expect(bounded?.droppedEvents).toBe(3);

    for (let index = 0; index < MAX_VOICE_SESSIONS + 2; index++) {
      model.recordVoiceObservation({
        kind: "lifecycle",
        voiceSessionId: `voice-${index}`,
        threadId: `thread-${index}`,
        state: "starting",
        observedAt: 1_000 + index,
      });
    }
    expect(model.voiceSessionList.map((session) => session.id)).toEqual(
      Array.from({ length: MAX_VOICE_SESSIONS }, (_, index) => `voice-${index + 2}`),
    );
    expect(model.events.size).toBe(0);
  });

  test("keeps lifecycle and gap rows chronological without thread correlation", () => {
    const model = new ChatsModel();
    model.replaceThreads([{ id: "thread-a" }]);
    const rows = [
      {
        kind: "lifecycle" as const,
        voiceSessionId: "voice-a",
        threadId: "thread-a",
        state: "active" as const,
        observedAt: 10,
      },
      {
        kind: "gap" as const,
        voiceSessionId: "voice-a",
        threadId: "thread-a",
        fromSequence: 2,
        toSequence: 4,
        dropped: 3,
        observedAt: 11,
      },
      {
        kind: "lifecycle" as const,
        voiceSessionId: "voice-a",
        threadId: "thread-a",
        state: "ended" as const,
        reason: "upstream-closed" as const,
        observedAt: 12,
      },
    ];
    rows.forEach((row) => {
      model.recordVoiceObservation(row);
    });

    expect(model.voiceSessionList[0]?.observations.map((row) => row.observation.kind)).toEqual([
      "lifecycle",
      "gap",
      "lifecycle",
    ]);
    expect(model.voiceSessionList[0]).toMatchObject({
      state: "ended",
      reason: "upstream-closed",
      droppedEvents: 0,
    });
    expect(model.events.get("thread-a")).toBeUndefined();
    expect(model.recordVoiceObservation({ ...rows[0], state: "bogus" })).toBeNull();
  });

  test("correlates response-only frames with the originating thread request", () => {
    const model = new ChatsModel();
    const request = model.recordEnvelope(
      envelope("toAppServer", "agentvoice", {
        jsonrpc: "2.0",
        id: 42,
        method: "turn/start",
        params: { threadId: "thread-a", input: [] },
      }),
      100,
    );
    const response = model.recordEnvelope(
      envelope("fromAppServer", "agentvoice", {
        jsonrpc: "2.0",
        id: 42,
        result: { turn: { id: "turn-a" } },
      }),
      101,
    );

    expect(request?.threadId).toBe("thread-a");
    expect(response?.threadId).toBe("thread-a");
    expect(model.events.get("thread-a")?.map((event) => event.payload)).toHaveLength(2);
  });

  test("keeps AgentVoice and viewer request-id namespaces independent", () => {
    const model = new ChatsModel();
    model.recordEnvelope(
      envelope("toAppServer", "agentvoice", {
        id: 7,
        method: "thread/read",
        params: { threadId: "agentvoice-thread" },
      }),
    );
    model.recordEnvelope(
      envelope("toAppServer", "client", {
        id: 7,
        method: "thread/read",
        params: { threadId: "viewer-thread" },
      }),
    );
    expect(
      model.recordEnvelope(envelope("fromAppServer", "agentvoice", { id: 7, result: {} }))
        ?.threadId,
    ).toBe("agentvoice-thread");
    expect(
      model.recordEnvelope(envelope("fromAppServer", "client", { id: 7, result: {} }))?.threadId,
    ).toBe("viewer-thread");
  });

  test("finds thread ids in notifications and nested thread results", () => {
    const model = new ChatsModel();
    expect(
      model.recordEnvelope(
        envelope("fromAppServer", "appServer", {
          method: "turn/started",
          params: { threadId: "thread-a", turn: { id: "turn-a" } },
        }),
      )?.threadId,
    ).toBe("thread-a");
    expect(
      model.recordEnvelope(
        envelope("fromAppServer", "client", {
          id: 8,
          result: { thread: { id: "thread-b" } },
        }),
      )?.threadId,
    ).toBe("thread-b");
  });

  test("expires request correlation and applies live status and name metadata", () => {
    const model = new ChatsModel();
    model.replaceThreads([{ id: "thread-a", name: "Old", status: { type: "idle" } }]);
    model.recordEnvelope(
      envelope("toAppServer", "agentvoice", {
        id: 42,
        method: "turn/start",
        params: { threadId: "thread-a" },
      }),
      100,
    );
    expect(
      model.recordEnvelope(envelope("fromAppServer", "agentvoice", { id: 42, result: {} }), 60_101),
    ).toBeNull();

    model.recordEnvelope(
      envelope("fromAppServer", "appServer", {
        method: "thread/status/changed",
        params: { threadId: "thread-a", status: { type: "active", activeFlags: ["waiting"] } },
      }),
    );
    model.recordEnvelope(
      envelope("fromAppServer", "appServer", {
        method: "thread/name/updated",
        params: { threadId: "thread-a", threadName: "New" },
      }),
    );
    expect(model.threads.get("thread-a")).toMatchObject({
      name: "New",
      status: "active / waiting",
    });
  });

  test("retains ownership metadata and bounds each thread independently", () => {
    const model = new ChatsModel();
    for (let index = 0; index < MAX_EVENTS_PER_THREAD + 7; index++) {
      model.recordEnvelope(
        envelope("fromAppServer", index % 2 === 0 ? "agentvoice" : "appServer", {
          method: "item/agentMessage/delta",
          params: { threadId: "thread-a", delta: String(index) },
        }),
      );
    }
    expect(model.events.get("thread-a")).toHaveLength(MAX_EVENTS_PER_THREAD);
    expect(model.droppedEvents.get("thread-a")).toBe(7);
    expect(model.events.get("thread-a")?.at(-1)?.owner).toBe("agentvoice");
  });

  test("does not assign global frames to an arbitrary thread", () => {
    const model = new ChatsModel();
    expect(
      model.recordEnvelope(
        envelope("fromAppServer", "appServer", {
          method: "account/rateLimits/updated",
          params: { rateLimits: {} },
        }),
      ),
    ).toBeNull();
    expect(model.events.size).toBe(0);
  });
});
