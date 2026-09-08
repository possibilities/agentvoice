import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVENT_PROTOCOL_VERSION,
  type ThreadSnapshot,
  type ThreadView,
} from "../src/events/contract.ts";
import { LifecycleFeed } from "../src/events/feed.ts";
import { EventSocketServer } from "../src/events/socket.ts";
import { ControlSocket, SocketFailure } from "../src/ipc/control-client.ts";
import {
  discoverThreadMonitor,
  formatThreadMonitor,
  readThreadMonitor,
} from "../src/threads/monitor.ts";

const expected = { instanceId: "call", workspace: "/workspace", threadId: "root" };
const thread = (id: string, parentThreadId: string | null = null): ThreadView => ({
  id,
  parentThreadId,
  name: id,
  status: "idle",
  activeFlags: [],
  turn: null,
});
const snapshot = (threads: ThreadView[]): ThreadSnapshot => ({
  instanceId: "call",
  generation: 1,
  sequence: 2,
  runtime: { phase: "ready", workspace: "/workspace", mainThreadId: "root" },
  inventory: "ready",
  threads,
});
const metadata = (id: string) => ({
  instanceId: "call",
  generation: 1,
  method: "conversation.thread.get",
  rootThreadId: "root",
  threadId: id,
  data: {
    id,
    cwd: "/workspace",
    status: { type: "idle" },
    model: "gpt-6-astra",
    reasoningEffort: "low",
  },
});

describe("watchable thread inventory", () => {
  test("reads only metadata with bounded concurrency; refreshes turn state and removes closed rows", async () => {
    const initial = snapshot([
      thread("root"),
      thread("child", "root"),
      thread("closed", "root"),
      thread("four"),
      thread("five"),
    ]);
    const latest = snapshot([
      thread("root"),
      { ...thread("child", "root"), status: "active", activeFlags: ["waitingOnApproval"] },
      thread("new", "child"),
    ]);
    let states = 0,
      active = 0,
      maxActive = 0;
    const methods: string[] = [];
    const result = await readThreadMonitor(
      {
        async request(method, params) {
          methods.push(method);
          if (method === "state.get") return ++states === 1 ? initial : latest;
          expect(method).toBe("conversation.thread.get");
          const p = params as Record<string, unknown>;
          expect(p["expectedInstanceId"]).toBe("call");
          expect(p["expectedGeneration"]).toBe(1);
          expect(p["rootThreadId"]).toBe("root");
          active++;
          maxActive = Math.max(maxActive, active);
          await Bun.sleep(1);
          active--;
          return metadata(String(p["threadId"]));
        },
      },
      expected,
    );
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(result.threads.map((row) => row.id)).toEqual(["root", "child", "new"]);
    expect(result.threads[1]).toMatchObject({
      model: "gpt-6-astra",
      effort: "low",
      activeFlags: ["waitingOnApproval"],
    });
    expect(result.missingSettings).toBe(1);
    expect(new Set(methods)).toEqual(new Set(["state.get", "conversation.thread.get"]));
  });

  test("unavailable or mismatched metadata never supplies guessed settings", async () => {
    const initial = snapshot([thread("root"), thread("child", "root"), thread("other")]);
    const result = await readThreadMonitor(
      {
        async request(method, params) {
          if (method === "state.get") return initial;
          const id = (params as { threadId: string }).threadId;
          if (id === "root") throw new SocketFailure("unavailable", "unavailable");
          if (id === "child") return { ...metadata(id), generation: 2 };
          return { ...metadata(id), data: { ...metadata(id).data, id: "foreign" } };
        },
      },
      expected,
    );
    expect(result.missingSettings).toBe(3);
    expect(result.threads.every((row) => row.model === undefined)).toBe(true);
  });

  test("rejects changed call/generation instead of combining runtimes", async () => {
    let states = 0;
    const initial = snapshot([thread("root")]);
    await expect(
      readThreadMonitor(
        {
          async request(method) {
            if (method === "state.get") return { ...initial, generation: ++states };
            return metadata("root");
          },
        },
        expected,
      ),
    ).rejects.toThrow("runtime changed");
    await expect(
      readThreadMonitor(
        {
          async request() {
            return initial;
          },
        },
        { ...expected, instanceId: "foreign" },
      ),
    ).rejects.toThrow("call changed");
  });

  test("read budget leaves unqueried rows visible and settings unknown", async () => {
    const calls: string[] = [];
    const result = await readThreadMonitor(
      {
        async request(method) {
          calls.push(method);
          return snapshot([thread("root")]);
        },
      },
      expected,
      0,
    );
    expect(calls).toEqual(["state.get", "state.get"]);
    expect(result.missingSettings).toBe(1);
  });

  test("renders parent before children, preserves missing/cyclic ancestry and neutralizes controls", () => {
    const rows = [
      thread("child", "root"),
      thread("orphan", "missing"),
      thread("cycle-a", "cycle-b"),
      thread("root"),
      thread("cycle-b", "cycle-a"),
    ];
    rows[0]!.name = "worker\n\u001b[2J";
    rows[0]!.status = "active";
    rows[0]!.activeFlags = ["waitingOnUserInput"];
    rows[3]!.turn = { id: "turn", status: "completed" };
    const output = formatThreadMonitor({
      phase: "ready",
      inventory: "incomplete",
      threads: rows,
      missingSettings: 5,
    });
    expect(output).toContain("inventory: incomplete");
    expect(output).toContain("waiting input");
    expect(output).toContain("idle: completed");
    expect(output).toContain("parent missing not loaded");
    expect(output).toContain("unresolved ancestry");
    expect(output).not.toContain("\u001b");
    expect(output.indexOf("root ")).toBeLessThan(output.indexOf("  worker"));
    for (const row of rows)
      expect(output.split("\n").filter((line) => line.includes(`  ${row.id}`))).toHaveLength(1);
  });

  test("reads the actual private event socket without subscription, history, or control mutation", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "av-thread-monitor-")));
    const path = join(dir, "events.sock");
    const feed = new LifecycleFeed("call");
    feed.runtime(1, { phase: "ready", workspace: "/workspace", mainThreadId: "root" });
    feed.update({ complete: true, threads: [thread("root"), thread("child", "root")] });
    const reads: string[] = [];
    const server = new EventSocketServer(path, feed, async (method, params) => {
      reads.push(method);
      return metadata((params as { threadId: string }).threadId);
    });
    let client: ControlSocket | undefined;
    try {
      await server.start();
      client = await ControlSocket.connect(path, EVENT_PROTOCOL_VERSION);
      const result = await readThreadMonitor(client, expected);
      expect(result.threads).toHaveLength(2);
      expect(result.missingSettings).toBe(0);
      expect(reads).toEqual(["conversation.thread.get", "conversation.thread.get"]);
    } finally {
      client?.close();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("offline default monitoring creates no workspace or call", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "av-thread-offline-")));
    try {
      const result = await discoverThreadMonitor(dir);
      expect(result.phase).toBe("offline");
      expect(formatThreadMonitor(result)).toContain("No active call.");
      expect(await Array.fromAsync(new Bun.Glob("**/*").scan(dir))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
