import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { startControlServer } from "../src/control/index.ts";
import { CONTROL_PROTOCOL_VERSION } from "../src/control/types.ts";
import type { ThreadSnapshot, ThreadView } from "../src/events/contract.ts";
import { projectNotification } from "../src/events/conversation.ts";
import { LifecycleFeed } from "../src/events/feed.ts";
import { eventSocketFrameSchema } from "../src/events/schema.ts";
import { EventSocketServer, eventMatches, eventSocketPath } from "../src/events/socket.ts";
import { runEventSocketCommand } from "../src/main.ts";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}
async function client(path: string) {
  const frames: Array<{
    id?: string;
    type?: string;
    event?: string;
    ok?: boolean;
    data?: { sequence: number };
    result: ThreadSnapshot;
    error: { code: string };
  }> = [];
  let partial = "";
  let closed = false;
  let next = 0;
  const socket = createConnection(path);
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("close", () => {
    closed = true;
  });
  socket.on("data", (chunk) => {
    partial += chunk;
    for (;;) {
      const index = partial.indexOf("\n");
      if (index < 0) break;
      const frame = JSON.parse(partial.slice(0, index));
      expect(eventSocketFrameSchema.safeParse(frame).success).toBe(true);
      frames.push(frame);
      partial = partial.slice(index + 1);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return {
    socket,
    frames,
    closed: () => closed,
    async request(method: string, params: unknown = {}) {
      const id = String(++next);
      socket.write(`${JSON.stringify({ v: 2, type: "request", id, method, params })}\n`);
      await until(() => frames.some((frame) => frame["id"] === id));
      return frames.find((frame) => frame["id"] === id)!;
    },
  };
}
const thread = (id: string, status: ThreadView["status"] = "idle"): ThreadView => ({
  id,
  name: null,
  parentThreadId: null,
  status,
  activeFlags: [],
  turn: null,
});
async function harness(read?: ConstructorParameters<typeof EventSocketServer>[2]) {
  const root = mkdtempSync("/tmp/av-events-");
  const feed = new LifecycleFeed("test");
  const server = new EventSocketServer(eventSocketPath(root, "test"), feed, read);
  await server.start();
  const clients: Socket[] = [];
  return {
    root,
    feed,
    server,
    async connect() {
      const connected = await client(server.path);
      clients.push(connected.socket);
      return connected;
    },
    close() {
      for (const peer of clients) peer.destroy();
      server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("lifecycle event socket", () => {
  test("conversation discovery, reads and replay use correlated typed frames without leaking into voice subscriptions", async () => {
    const calls: unknown[] = [];
    const h = await harness(async (method, params) => {
      calls.push({ method, params });
      return h.feed.live("main");
    });
    try {
      const peer = await h.connect();
      const voice = await h.connect();
      expect((await peer.request("conversation.capabilities")).result).toMatchObject({
        nativeSchemaVersion: "0.153.4",
        history: "native-paginated",
      });
      await peer.request("event.subscribe", { events: ["conversation.*"] });
      await voice.request("event.subscribe", { events: ["voice.*"] });
      h.feed.conversation(
        projectNotification(
          "item/started",
          {
            threadId: "main",
            turnId: "turn",
            startedAtMs: 1,
            item: { id: "item", type: "agentMessage", text: "Live work" },
          },
          1,
        )!,
      );
      const identity = {
        expectedInstanceId: "test",
        expectedGeneration: 1,
        rootThreadId: "main",
        threadId: "main",
      };
      expect((await peer.request("conversation.live.get", identity)).result).toMatchObject({
        threadId: "main",
        items: [{ item: { text: "Live work" } }],
      });
      const replayIdentity = {
        expectedInstanceId: "test",
        expectedGeneration: 1,
        afterSequence: 0,
      };
      expect((await peer.request("conversation.replay", replayIdentity)).result).toMatchObject({
        events: [{ event: "conversation.item.started" }],
        hasMore: false,
      });
      expect(
        (await peer.request("conversation.replay", { ...replayIdentity, expectedGeneration: 9 }))
          .error.code,
      ).toBe("stale_generation");
      expect(
        (await peer.request("conversation.items.list", { ...identity, path: "/arbitrary" })).error
          .code,
      ).toBe("invalid_params");
      expect(calls).toHaveLength(1);
      expect(voice.frames.filter((frame) => frame.type === "event")).toEqual([]);
      expect((await peer.request("conversation.turn.start", identity)).error.code).toBe(
        "unknown_method",
      );
    } finally {
      h.close();
    }
  });
  test("wildcards deliver ordered voice events that snapshots never replay or supersede", async () => {
    const h = await harness();
    try {
      const all = await h.connect();
      const voice = await h.connect();
      await all.request("event.subscribe");
      await voice.request("event.subscribe", { events: ["voice.*"] });
      const data = {
        threadId: "old-fresh-thread",
        itemId: "native-item",
        delta: "private live speech",
      };
      h.feed.voice({ event: "voice.item.transcript.delta", data });
      h.feed.update({ complete: true, threads: [thread("main")] });
      h.feed.voice({
        event: "voice.item.completed",
        data: {
          threadId: data.threadId,
          item: {
            id: data.itemId,
            realtimeSessionId: "native-old-session",
            type: "transcriptSegment",
            role: "user",
            text: data.delta,
          },
        },
      });
      const snapshot = (await all.request("state.get")).result;
      expect(JSON.stringify(snapshot)).not.toContain(data.delta);
      const events = all.frames.filter((frame) => frame.type === "event");
      expect(events.map((frame) => frame.event)).toEqual([
        "voice.item.transcript.delta",
        "threads.changed",
        "voice.item.completed",
      ]);
      expect(events.map((frame) => frame.data?.sequence)).toEqual([1, 2, 3]);
      expect(events[0] as unknown).toEqual({
        v: 2,
        type: "event",
        event: "voice.item.transcript.delta",
        data: { ...data, instanceId: "test", generation: 1, sequence: 1 },
      });
      expect(snapshot.sequence).toBe(3);
      await voice.request("state.get");
      expect(
        voice.frames.filter((frame) => frame.type === "event").map((frame) => frame.event),
      ).toEqual(["voice.item.transcript.delta", "voice.item.completed"]);
      const later = await h.connect();
      await later.request("event.subscribe", { events: ["voice.*"] });
      await later.request("state.get");
      expect(later.frames.filter((frame) => frame.type === "event")).toEqual([]);
      h.feed.runtime(2, { phase: "quiescing", workspace: "/work", mainThreadId: "main" });
      h.feed.voice({ event: "voice.item.transcript.delta", data });
      h.feed.runtime(2, { phase: "starting", workspace: "/work", mainThreadId: "main" });
      h.feed.voice({
        event: "voice.item.transcript.delta",
        data: { ...data, delta: "new generation" },
      });
      await later.request("state.get");
      expect(later.frames.filter((frame) => frame.type === "event")).toMatchObject([
        {
          event: "voice.item.transcript.delta",
          data: { generation: 2, sequence: 6, delta: "new generation" },
        },
      ]);
    } finally {
      h.close();
    }
  });
  test("exact and trailing-star matching follows agentsource's literal prefix rules", () => {
    expect(eventMatches(["*"], "thread.state.changed")).toBe(true);
    expect(eventMatches(["thread.*"], "thread.state.changed")).toBe(true);
    expect(eventMatches(["thread.*"], "threads.changed")).toBe(false);
    expect(eventMatches(["thread*"], "threads.changed")).toBe(true);
    expect(eventMatches(["thread.state.changed"], "thread.state.changed.extra")).toBe(false);
  });

  test("subscriptions are per connection, replace filters, and snapshots reconcile by sequence", async () => {
    const h = await harness();
    try {
      const all = await h.connect();
      const only = await h.connect();
      const reader = await h.connect();
      expect(await all.request("event.subscribe")).toMatchObject({
        ok: true,
        result: { events: ["*"] },
      });
      expect(
        await only.request("event.subscribe", { events: ["thread.*", "thread.*"] }),
      ).toMatchObject({ result: { events: ["thread.*"] } });
      h.feed.update({ complete: true, threads: [thread("a")] });
      h.feed.update({ complete: true, threads: [thread("a", "active")] });
      const response = await all.request("state.get");
      const snapshot = response["result"] as ThreadSnapshot;
      expect(snapshot.threads[0]?.status).toBe("active");
      const before = all.frames.filter((frame) => frame["type"] === "event");
      expect(before.map((frame) => frame["event"])).toEqual([
        "threads.changed",
        "thread.state.changed",
      ]);
      expect(before.every((frame) => frame["data"]!.sequence <= snapshot.sequence)).toBe(true);
      await until(() => only.frames.some((frame) => frame["type"] === "event"));
      expect(
        only.frames.filter((frame) => frame["type"] === "event").map((frame) => frame["event"]),
      ).toEqual(["thread.state.changed"]);
      expect(reader.frames).toEqual([]);
      expect((await reader.request("state.get"))["result"]).toEqual(snapshot);
      await only.request("event.subscribe", { events: ["runtime.*"] });
      h.feed.runtime(2, { phase: "quiescing", workspace: "/work", mainThreadId: "a" });
      await until(() =>
        all.frames.some((frame) => (frame["data"]?.sequence ?? -1) > snapshot.sequence),
      );
      expect(h.feed.snapshot()).toMatchObject({
        generation: 2,
        inventory: "unavailable",
        threads: [],
      });
      await until(() => only.frames.some((frame) => frame["event"] === "runtime.state.changed"));
      expect((await all.request("agentvoice.restart"))["error"].code).toBe("unknown_method");
      expect((await all.request("event.subscribe", { events: ["thr*ead"] }))["error"].code).toBe(
        "invalid_params",
      );
      expect((await all.request("state.get", { threadId: "foreign" }))["error"].code).toBe(
        "invalid_params",
      );
      expect(statSync(h.server.path).mode & 0o777).toBe(0o600);
    } finally {
      h.close();
    }
  });

  test("slow subscribers disconnect without preventing other clients from taking a snapshot", async () => {
    const h = await harness();
    try {
      const slow = await h.connect();
      await slow.request("event.subscribe");
      slow.socket.pause();
      for (let i = 0; i < 120; i++)
        h.feed.update({
          complete: i % 2 === 0,
          threads: Array.from({ length: 256 }, (_, index) => ({
            ...thread(`t-${index}`),
            name: "x".repeat(256),
          })),
        });
      slow.socket.resume();
      await until(slow.closed);
      const live = await h.connect();
      expect((await live.request("state.get"))["result"].threads).toHaveLength(256);
    } finally {
      h.close();
    }
  });

  test("rejects oversized trailing partial frames and never unlinks another listener or file", async () => {
    const h = await harness();
    try {
      const other = new EventSocketServer(h.server.path, new LifecycleFeed("other"));
      await expect(other.start()).rejects.toThrow("another AgentVoice controller");
      other.close();
      const live = await h.connect();
      expect((await live.request("state.get"))["ok"]).toBe(true);
      const oversized = await h.connect();
      oversized.socket.write(`{}\n${" ".repeat((1 << 20) + 1)}`);
      await until(oversized.closed);
      const path = join(h.root, "control", "unrelated");
      writeFileSync(path, "keep");
      const file = new EventSocketServer(path, h.feed);
      await expect(file.start()).rejects.toThrow("unsafe Unix socket");
      file.close();
      expect(readFileSync(path, "utf8")).toBe("keep");
    } finally {
      h.close();
    }
  });

  test("event-socket discovery selects the live owner without exporting its control token", async () => {
    const root = realpathSync(mkdtempSync("/tmp/av-discover-"));
    const stateDir = join(root, "agentvoice");
    const feed = new LifecycleFeed("discovery");
    const events = new EventSocketServer(eventSocketPath(stateDir, "discovery"), feed);
    await events.start();
    const control = await startControlServer({
      stateDir,
      instanceId: "discovery",
      backend: {
        status: () => ({
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          instanceId: "discovery",
          workspace: root,
          threadId: "main",
          generation: 1,
          runtime: { phase: "failed" },
          recentOperations: [],
        }),
        redial: async () => {
          throw new Error("must not mutate");
        },
        restart: async () => {
          throw new Error("must not mutate");
        },
      },
    });
    try {
      let output = "";
      expect(
        await runEventSocketCommand(["--workspace", root], {
          env: { XDG_STATE_HOME: root },
          write: (text) => {
            output += text;
          },
        }),
      ).toBe(0);
      expect(output).toBe(`${events.path}\n`);
      expect(output).not.toContain(control.bearerToken);
      await expect(
        runEventSocketCommand(["--workspace", root, "--thread", "wrong"], {
          env: { XDG_STATE_HOME: root },
        }),
      ).rejects.toThrow("no live");
    } finally {
      await control.close();
      events.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
