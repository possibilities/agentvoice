import { describe, expect, test } from "bun:test";
import { AppServerError } from "../src/core/attach.ts";
import { readConversationItems } from "../src/core/conversation-items.ts";
import { ConversationReader } from "../src/core/conversation-reader.ts";
import {
  type ConversationNotification,
  conversationRequestSchemas,
  MAX_CONVERSATION_BYTES,
  MAX_HISTORY_BYTES,
  MAX_PROJECTED_ITEM_BYTES,
  projectItem,
  projectNotification,
  readResultSchema,
} from "../src/events/conversation.ts";
import {
  ConversationProjection,
  liveSnapshotSchema,
} from "../src/events/conversation-projection.ts";
import { LifecycleFeed } from "../src/events/feed.ts";
import { eventSocketFrameSchema } from "../src/events/schema.ts";
import { runtimeHarness } from "./fixtures/runtime-harness.ts";

const identity = {
  expectedInstanceId: "instance",
  expectedGeneration: 1,
  rootThreadId: "main",
  threadId: "child",
};
const delta = (text: string, revision: number, threadId = "child") =>
  projectNotification(
    "item/agentMessage/delta",
    {
      threadId,
      turnId: "turn",
      itemId: "message",
      delta: text,
    },
    revision,
  )!;
const itemEvent = (completed: boolean, text: string, revision: number, threadId = "child") =>
  projectNotification(
    completed ? "item/completed" : "item/started",
    {
      threadId,
      turnId: "turn",
      item: { id: "message", type: "agentMessage", text },
      ...(completed ? { completedAtMs: 20 } : { startedAtMs: 10 }),
    },
    revision,
  )!;
function metadata(id: string, parentThreadId: string | null) {
  return {
    id,
    parentThreadId,
    cwd: "/work",
    threadSource: "agentvoice-orchestrator",
    status: { type: "idle" },
    name: id,
    agentNickname: "Scout",
    agentRole: "researcher",
    ephemeral: false,
  };
}

describe("conversation content contract", () => {
  test("projects native items and deltas with exact identity, explicit unsupported content, and private capability scrubbing", () => {
    expect(
      projectItem(
        {
          id: "tool",
          type: "mcpToolCall",
          server: "test",
          tool: "lookup",
          status: "completed",
          arguments: { nested: { token: "private-token" } },
          result: { content: [{ type: "text", text: "private-token" }] },
          hidden: "never forwarded",
        },
        ["private-token"],
      ),
    ).toEqual({
      id: "tool",
      type: "mcpToolCall",
      server: "test",
      tool: "lookup",
      status: "completed",
      arguments: { nested: { token: "[redacted]" } },
      result: { content: [{ type: "text", text: "[redacted]" }] },
    });
    expect(
      projectItem({
        type: "userMessage",
        id: "user",
        content: [{ type: "audio", url: "private-audio" }],
      }),
    ).toMatchObject({ type: "unavailable", reason: "media", id: "user" });
    const privateImageUrl = `data:image/png;base64,${"a".repeat(MAX_CONVERSATION_BYTES)}`;
    const privateImagePath = "/Users/operator/private/clipboard.png";
    const projectedUser = projectItem({
      type: "userMessage",
      id: "user-images",
      clientId: "client-image-message",
      content: [
        { type: "image", url: privateImageUrl, detail: "high" },
        { type: "localImage", path: privateImagePath, detail: null },
        { type: "text", text: "Describe both", text_elements: [] },
      ],
    });
    expect(projectedUser).toEqual({
      type: "userMessage",
      id: "user-images",
      clientId: "client-image-message",
      content: [
        { type: "image", url: "[image omitted]", detail: "high" },
        { type: "localImage", path: "[image omitted]", detail: null },
        { type: "text", text: "Describe both", text_elements: [] },
      ],
    });
    expect(JSON.stringify(projectedUser)).not.toContain(privateImageUrl);
    expect(JSON.stringify(projectedUser)).not.toContain(privateImagePath);
    expect(Buffer.byteLength(JSON.stringify(projectedUser))).toBeLessThanOrEqual(
      MAX_PROJECTED_ITEM_BYTES,
    );
    const projectedUserEvent = projectNotification(
      "item/completed",
      {
        threadId: "child",
        turnId: "turn",
        item: {
          type: "userMessage",
          id: "user-images",
          clientId: "client-image-message",
          content: [
            { type: "image", url: privateImageUrl, detail: "high" },
            { type: "text", text: "Describe both", text_elements: [] },
          ],
        },
        completedAtMs: 20,
      },
      2,
    )!;
    expect(projectedUserEvent.event).toBe("conversation.item.completed");
    expect(projectedUserEvent.data).toMatchObject({
      item: { type: "userMessage", clientId: "client-image-message" },
    });
    expect(JSON.stringify(projectedUserEvent)).not.toContain(privateImageUrl);
    expect(Buffer.byteLength(JSON.stringify(projectedUserEvent))).toBeLessThanOrEqual(
      MAX_CONVERSATION_BYTES,
    );
    const oversizedImageMessage = projectItem({
      type: "userMessage",
      id: "oversized-user-images",
      content: [
        { type: "localImage", path: privateImagePath },
        { type: "text", text: "雪".repeat(MAX_CONVERSATION_BYTES) },
      ],
    });
    expect(oversizedImageMessage).toMatchObject({ type: "unavailable", reason: "oversized" });
    expect(JSON.stringify(oversizedImageMessage)).not.toContain(privateImagePath);
    expect(projectItem({ type: "futureNativeItem", id: "future", secret: "not a schema" })).toEqual(
      { type: "unavailable", id: "future", nativeType: "futureNativeItem", reason: "unsupported" },
    );
    expect(
      projectItem({ type: "agentMessage", id: "huge", text: "雪".repeat(MAX_CONVERSATION_BYTES) }),
    ).toMatchObject({ type: "unavailable", reason: "oversized" });
    const failedRaw = {
      type: "mcpToolCall",
      id: "failed-tool",
      server: "inventory",
      tool: "refresh",
      status: "failed",
      arguments: { query: "x".repeat(MAX_CONVERSATION_BYTES) },
      result: { content: [{ type: "text", text: "result ".repeat(20_000) }] },
      error: {
        type: "rate_limit",
        message: "The inventory API refused the refresh.",
        details: "Retry after the service window.",
      },
    };
    const failed = projectItem(failedRaw);
    expect(failed).toMatchObject({
      type: "unavailable",
      nativeType: "mcpToolCall",
      reason: "oversized",
      omission: {
        name: "refresh",
        detail: "inventory.refresh",
        status: "failed",
        failure: {
          type: "rate_limit",
          message: "The inventory API refused the refresh.",
          details: "Retry after the service window.",
        },
        excerpt: { label: "Result excerpt" },
      },
    });
    expect(Buffer.byteLength(JSON.stringify(failed))).toBeLessThanOrEqual(MAX_PROJECTED_ITEM_BYTES);
    const completedEvent = projectNotification(
      "item/completed",
      { threadId: "child", turnId: "turn", item: failedRaw, completedAtMs: 20 },
      2,
    );
    expect(completedEvent?.event).not.toBe("conversation.gap");
    expect(Buffer.byteLength(JSON.stringify(completedEvent))).toBeLessThanOrEqual(
      MAX_CONVERSATION_BYTES,
    );
    const mediaFailure = projectItem({
      type: "mcpToolCall",
      id: "failed-media",
      server: "vision",
      tool: "inspect",
      status: "failed",
      arguments: {},
      result: {
        content: [{ type: "image", data: `data:image/png;base64,${"a".repeat(80_000)}` }],
      },
      error: { message: "The image could not be decoded." },
    });
    expect(mediaFailure).toMatchObject({
      reason: "media",
      omission: {
        name: "inspect",
        status: "failed",
        failure: { type: "MCP tool failure", message: "The image could not be decoded." },
      },
    });
    expect(
      mediaFailure.type === "unavailable" ? mediaFailure.omission?.excerpt : undefined,
    ).toBeUndefined();
    const collaborationFailure = projectItem({
      type: "collabAgentToolCall",
      id: "failed-agent",
      tool: "spawnAgent",
      status: "failed",
      senderThreadId: "root",
      receiverThreadIds: ["child"],
      agentsStates: {
        child: {
          status: "errored",
          message: `Worker could not read the repository. ${"diagnostic ".repeat(8_000)}`,
        },
      },
    });
    expect(collaborationFailure).toMatchObject({
      type: "unavailable",
      nativeType: "collabAgentToolCall",
      reason: "oversized",
      omission: {
        name: "spawnAgent",
        detail: "spawnAgent",
        status: "failed",
        failure: {
          type: "Agent collaboration failure",
          message: expect.stringContaining("Worker could not read the repository."),
          details: expect.stringContaining('"status": "errored"'),
        },
        excerpt: { label: "Agent state excerpt" },
      },
    });
    expect(Buffer.byteLength(JSON.stringify(collaborationFailure))).toBeLessThanOrEqual(
      MAX_PROJECTED_ITEM_BYTES,
    );
    expect(
      projectNotification("item/agentMessage/delta", { delta: "missing identity" }, 1),
    ).toMatchObject({ event: "conversation.gap", data: { reason: "unsupported", threadId: null } });
    expect(
      projectNotification("thread/realtime/outputAudio/delta", { audio: "never" }, 1),
    ).toBeUndefined();
    const projected = projectNotification(
      "turn/completed",
      {
        threadId: "child",
        turn: { id: "turn", status: "completed", items: [{ secret: "not duplicated" }] },
      },
      1,
    )!;
    expect(projected.data).toEqual({
      threadId: "child",
      turn: { id: "turn", status: "completed" },
    });
  });

  test("production observation opts into native work streams and forwards main and child items without starting more work", async () => {
    const observed: ConversationNotification[] = [];
    const h = runtimeHarness({}, { onConversation: (event) => observed.push(event) });
    try {
      await h.runtime.start();
      expect(h.native.options.optOutNotificationMethods).not.toContain("item/agentMessage/delta");
      expect(h.native.options.optOutNotificationMethods).not.toContain(
        "item/commandExecution/outputDelta",
      );
      expect(h.native.options.optOutNotificationMethods).toContain(
        "thread/realtime/outputAudio/delta",
      );
      for (const threadId of [h.runtime.currentReady!.threadId, "native-child"]) {
        h.native.options.onNotification("item/agentMessage/delta", {
          threadId,
          turnId: "turn",
          itemId: "message",
          delta: "native text",
        });
      }
      expect(observed.map((event) => event.data["threadId"])).toEqual([
        h.runtime.currentReady!.threadId,
        "native-child",
      ]);
      expect(observed.map((event) => event.revision)).toEqual([1, 2]);
      expect(h.native.calls.some((call) => call.method === "turn/start")).toBe(false);
      await h.runtime.shutdown();
      h.native.options.onNotification("item/agentMessage/delta", {
        threadId: "stale",
        turnId: "turn",
        itemId: "message",
        delta: "late",
      });
      expect(observed).toHaveLength(2);
    } finally {
      await h.cleanup();
    }
  });

  test("live snapshots form an exact cut, canonical completions replace deltas, and gaps invalidate partial items", () => {
    const feed = new LifecycleFeed("instance");
    const frames: unknown[] = [];
    feed.listen((frame) => frames.push(frame));
    feed.conversation(itemEvent(false, "", 1));
    feed.conversation(delta("Hello ", 2));
    const first = feed.live("child");
    expect(liveSnapshotSchema.safeParse(first).success).toBe(false); // Envelope carries controller identity too.
    expect(first.items[0]).toMatchObject({
      item: { text: "Hello " },
      complete: true,
      completed: false,
    });
    feed.conversation(delta("雪", 3));
    expect(first.items[0]?.item).toMatchObject({ text: "Hello " });
    const replay = feed.replay(first.throughSequence, 50);
    expect(replay.events.map((frame) => frame.data["delta"])).toEqual(["雪"]);
    feed.conversation(delta("after lost delta", 5));
    expect(feed.live("child").items[0]?.complete).toBe(false);
    expect(feed.replay(3, 50).events.map((frame) => frame.event)).toEqual([
      "conversation.gap",
      "conversation.item.agent_message.delta",
    ]);
    feed.conversation(itemEvent(true, "Canonical replacement", 6));
    expect(feed.live("child").items[0]).toMatchObject({
      item: { text: "Canonical replacement" },
      complete: true,
      completed: true,
    });
    expect(JSON.stringify(feed.snapshot())).not.toContain("Canonical replacement");
    for (const frame of frames) expect(eventSocketFrameSchema.safeParse(frame).success).toBe(true);
    feed.runtime(2, { phase: "starting", workspace: "/work", mainThreadId: "main" });
    expect(feed.live("child").items).toEqual([]);
    expect(() => feed.replay(0, 20)).toThrow("resync_required");
  });

  test("replay eviction reports resync, pages stop at a real cursor, and materialized item memory is bounded", () => {
    const feed = new LifecycleFeed("instance");
    feed.conversation(itemEvent(false, "", 1));
    for (let revision = 2; revision <= 520; revision++) feed.conversation(delta("x", revision));
    expect(() => feed.replay(0, 20)).toThrow("resync_required");
    const page = feed.replay(500, 2);
    expect(page.events).toHaveLength(2);
    expect(page.throughSequence).toBe(502);
    expect(page.hasMore).toBe(true);
    expect(feed.replay(502, 100).hasMore).toBe(false);
    expect(() => feed.replay(521, 2)).toThrow("invalid_params");
    const projection = new ConversationProjection();
    projection.apply(itemEvent(false, "", 1));
    projection.apply(delta("雪".repeat(15000), 2));
    projection.apply(delta("雪".repeat(15000), 3));
    expect(projection.snapshot("child", 2, 2).items[0]).toMatchObject({
      item: { type: "unavailable" },
      complete: false,
    });
  });
});

describe("scoped native conversation reads", () => {
  test("item pages split full native turns without losing entries, and edits invalidate an in-turn cursor", async () => {
    let text = "old";
    const call = async (_method: string, input: unknown) => {
      const params = input as Record<string, unknown>;
      expect(params["itemsView"]).toBe("full");
      expect(params["limit"]).toBe(1);
      return {
        data: [
          {
            id: params["cursor"] ? "turn-2" : "turn-1",
            itemsView: "full",
            items: [
              { id: "one", type: "agentMessage", text },
              { id: "two", type: "plan", text: "plan" },
            ],
          },
        ],
        nextCursor: params["cursor"] ? null : "next-turn",
      };
    };
    const params = { threadId: "child", limit: 1, sortDirection: "asc" as const };
    const first = await readConversationItems(call, params, []);
    expect(first.data.map((entry) => entry.item.id)).toEqual(["one"]);
    const second = await readConversationItems(call, { ...params, cursor: first.nextCursor! }, []);
    expect(second.data.map((entry) => entry.item.id)).toEqual(["two"]);
    const third = await readConversationItems(call, { ...params, cursor: second.nextCursor! }, []);
    expect(third.data[0]?.turnId).toBe("turn-2");
    const filtered = await readConversationItems(call, { ...params, turnId: "turn-2" }, []);
    expect(filtered.data).toEqual([]);
    expect(filtered.nextCursor).not.toBeNull();
    text = "edited";
    await expect(
      readConversationItems(call, { ...params, cursor: first.nextCursor! }, []),
    ).rejects.toThrow("cursor_expired");
  });
  test("history pages stop at the public byte budget while preserving oversized tool summaries", async () => {
    const items = Array.from({ length: 30 }, (_, index) => ({
      id: `large-${index}`,
      type: "commandExecution",
      command: `run ${index}`,
      commandActions: [],
      cwd: "/work",
      status: index === 0 ? "failed" : "completed",
      exitCode: index === 0 ? 23 : 0,
      aggregatedOutput: `${index}: ${"output ".repeat(20_000)}`,
    }));
    const call = async () => ({
      data: [{ id: "turn", itemsView: "full", items }],
      nextCursor: null,
    });
    const params = { threadId: "child", limit: 50, sortDirection: "asc" as const };
    const first = await readConversationItems(call, params, []);
    expect(first.data.length).toBeGreaterThan(0);
    expect(first.data.length).toBeLessThan(items.length);
    expect(Buffer.byteLength(JSON.stringify(first.data))).toBeLessThan(MAX_HISTORY_BYTES);
    expect(first.data[0]).toMatchObject({
      item: {
        type: "unavailable",
        nativeType: "commandExecution",
        omission: {
          name: "Command",
          status: "failed",
          exitCode: 23,
          failure: { type: "Command failure", message: "Command exited with code 23." },
        },
      },
    });
    const all = [...first.data];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await readConversationItems(call, { ...params, cursor }, []);
      expect(Buffer.byteLength(JSON.stringify(page.data))).toBeLessThan(MAX_HISTORY_BYTES);
      all.push(...page.data);
      cursor = page.nextCursor;
    }
    expect(all.map((entry) => entry.item.id)).toEqual(items.map((item) => item.id));
  });
  test("walks ancestry, forwards bounded native pagination, binds cursors, and reports concurrent changes without pretending atomicity", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    let revision = 5;
    const reader = new ConversationReader(
      async (method, input) => {
        const params = input as Record<string, unknown>;
        calls.push({ method, params });
        if (method === "thread/read")
          return {
            thread: metadata(
              String(params["threadId"]),
              params["threadId"] === "main"
                ? null
                : params["threadId"] === "child"
                  ? "middle"
                  : "main",
            ),
          };
        revision++;
        if (method === "thread/turns/list")
          return {
            data: [
              {
                id: "turn",
                status: "completed",
                itemsView: "full",
                items: [{ id: "message", type: "agentMessage", text: "canonical native history" }],
              },
            ],
            nextCursor: params["cursor"] ? null : "native-cursor",
          };
        return { data: [], nextCursor: null };
      },
      "/work",
      () => revision,
    );
    const params = conversationRequestSchemas["conversation.items.list"].parse(identity);
    const first = await reader.read("conversation.items.list", params);
    expect(first).toMatchObject({
      method: "conversation.items.list",
      revisionBefore: 5,
      revisionAfter: 6,
      changedDuringRead: true,
      data: [{ turnId: "turn", item: { text: "canonical native history" } }],
    });
    expect(first.nextCursor).not.toBe("native-cursor");
    expect(readResultSchema.safeParse(first).success).toBe(true);
    const cursor = first.nextCursor!;
    await expect(
      reader.read("conversation.items.list", { ...params, threadId: "middle", cursor }),
    ).rejects.toThrow("cursor_expired");
    await expect(
      reader.read("conversation.items.list", { ...params, turnId: "other", cursor }),
    ).rejects.toThrow("cursor_expired");
    const second = await reader.read("conversation.items.list", { ...params, limit: 1, cursor });
    expect(second.nextCursor).toBeNull();
    expect(calls.at(-1)).toEqual({
      method: "thread/turns/list",
      params: {
        threadId: "child",
        cursor: "native-cursor",
        sortDirection: "asc",
        limit: 1,
        itemsView: "full",
      },
    });
    expect(
      calls
        .filter((call) => call.method === "thread/read")
        .every((call) => call.params["includeTurns"] === false),
    ).toBe(true);
    expect(calls.every((call) => ["thread/read", "thread/turns/list"].includes(call.method))).toBe(
      true,
    );
  });

  test("foreign roots, missing parents and cycles cannot expose history; native failures never leak raw errors", async () => {
    for (const mode of ["foreign-root", "missing-parent", "cycle", "wrong-id"]) {
      let history = 0;
      const reader = new ConversationReader(
        async (method, input) => {
          const id = (input as { threadId: string }).threadId;
          if (method !== "thread/read") {
            history++;
            return { data: [] };
          }
          const row = metadata(id, id === "main" ? null : mode === "cycle" ? "child" : null);
          if (mode === "foreign-root") row.cwd = "/elsewhere";
          if (mode === "wrong-id") row.id = "wrong";
          return { thread: row };
        },
        "/work",
        () => 0,
      );
      await expect(
        reader.read(
          "conversation.items.list",
          conversationRequestSchemas["conversation.items.list"].parse(identity),
        ),
      ).rejects.toThrow("forbidden_thread");
      expect(history).toBe(0);
    }
    const reader = new ConversationReader(
      async () => {
        throw new AppServerError("private-provider-error", -32601);
      },
      "/work",
      () => 0,
    );
    await expect(reader.read("conversation.thread.get", identity)).rejects.toThrow(
      /^unsupported$/u,
    );
  });

  test("descendant list verifies rows, includes unloaded children, and rejects a server ignoring the ancestry filter", async () => {
    let foreign = false;
    let malformed = false;
    const calls: string[] = [];
    const reader = new ConversationReader(
      async (method, input) => {
        calls.push(method);
        const params = input as Record<string, unknown>;
        if (method === "thread/list") {
          expect(params["ancestorThreadId"]).toBe("main");
          expect(params["archived"]).toBe(true);
          return { data: [{ id: foreign ? "foreign" : "child" }], nextCursor: null };
        }
        const id = String(params["threadId"]);
        const row = metadata(id, id === "child" ? "main" : null);
        if (id === "child")
          Object.assign(row, {
            source: {
              subAgent: {
                thread_spawn: {
                  parent_thread_id: "main",
                  depth: 1,
                  agent_path: malformed
                    ? "/root/Friendly Name"
                    : "/root/agenthud_live_update_cleanup",
                },
              },
            },
          });
        row.status.type = "notLoaded";
        return { thread: row };
      },
      "/work",
      () => 0,
    );
    const params = conversationRequestSchemas["conversation.threads.list"].parse({
      expectedInstanceId: "instance",
      expectedGeneration: 1,
      rootThreadId: "main",
      archived: true,
    });
    expect((await reader.read("conversation.threads.list", params)).data).toMatchObject([
      {
        id: "child",
        parentThreadId: "main",
        agentNickname: "Scout",
        status: { type: "notLoaded" },
        collaborationIdentity: {
          state: "verified",
          path: "/root/agenthud_live_update_cleanup",
        },
      },
    ]);
    malformed = true;
    expect((await reader.read("conversation.threads.list", params)).data).toMatchObject([
      {
        id: "child",
        collaborationIdentity: { state: "missing", reason: "malformed" },
      },
    ]);
    foreign = true;
    await expect(reader.read("conversation.threads.list", params)).rejects.toThrow(
      "forbidden_thread",
    );
    expect(calls.every((method) => method === "thread/list" || method === "thread/read")).toBe(
      true,
    );
  });

  test("read concurrency is bounded and abandoned native errors do not reserve slots forever", async () => {
    const blocked = Promise.withResolvers<unknown>();
    const reader = new ConversationReader(
      () => blocked.promise,
      "/work",
      () => 0,
    );
    const pending = Array.from({ length: 4 }, () =>
      reader.read("conversation.thread.get", identity),
    );
    await expect(reader.read("conversation.thread.get", identity)).rejects.toThrow("busy");
    const settled = Promise.allSettled(pending);
    blocked.reject(new Error("private detail"));
    for (const result of await settled) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason.message).toBe("unavailable");
    }
    await expect(reader.read("conversation.thread.get", identity)).rejects.toThrow(
      /^unavailable$/u,
    );
  });
});
