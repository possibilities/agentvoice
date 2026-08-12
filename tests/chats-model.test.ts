import { describe, expect, test } from "bun:test";
import {
  ChatsModel,
  displayRole,
  displayStatus,
  MAX_EVENTS_PER_THREAD,
  threadCard,
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
        preview: "Older task",
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
      status: "active · waitingOnApproval",
    });
    expect(cards[1]).toMatchObject({ name: "Older task", role: "worker" });
  });

  test("falls back safely for partial future thread shapes", () => {
    expect(threadCard({ id: "thread-id" })).toMatchObject({
      name: "thread thread-i",
      status: "unknown",
      role: "thread",
    });
    expect(threadCard({ nope: true })).toBeNull();
    expect(displayRole({ agentRole: "reviewer" })).toBe("reviewer");
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
});

describe("chats raw event model", () => {
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
      status: "active · waiting",
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
