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
    parentThreadId: id === "root" ? null : "root",
    cwd: "/workspace",
    status: { type: "idle" },
    model: "gpt-6-astra",
    reasoningEffort: "low",
    collaborationIdentity:
      id === "root"
        ? { state: "missing" as const, reason: "not_reported" as const }
        : {
            state: "verified" as const,
            path: `/root/${id.replaceAll("-", "_")}`,
          },
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
    expect(result.missingSettings).toBe(0);
    expect(result.historyCoverage).toBe("unavailable");
    expect(new Set(methods)).toEqual(
      new Set(["state.get", "conversation.thread.get", "conversation.threads.list"]),
    );
  });

  test("enriches multiple workers that appear during observation before publishing them", async () => {
    const initial = snapshot([thread("root")]);
    const latest = snapshot([
      thread("root"),
      { ...thread("fresh-a"), status: "active" },
      { ...thread("fresh-b"), status: "active" },
    ]);
    const attempts = new Map<string, number>();
    let stateReads = 0;
    const result = await readThreadMonitor(
      {
        async request(method, params) {
          if (method === "state.get") return ++stateReads === 1 ? initial : latest;
          const input = params as Record<string, unknown>;
          if (method === "conversation.threads.list")
            return {
              instanceId: "call",
              generation: 1,
              method,
              rootThreadId: "root",
              revisionBefore: 1,
              revisionAfter: 1,
              changedDuringRead: false,
              data: [],
              nextCursor: null,
            };
          expect(method).toBe("conversation.thread.get");
          const id = String(input["threadId"]);
          const attempt = (attempts.get(id) ?? 0) + 1;
          attempts.set(id, attempt);
          if (id !== "root" && attempt === 1)
            return {
              ...metadata(id),
              data: {
                ...metadata(id).data,
                model: null,
                reasoningEffort: null,
                collaborationIdentity: { state: "missing", reason: "not_reported" },
              },
            };
          return metadata(id);
        },
      },
      expected,
    );

    expect(attempts.get("fresh-a")).toBe(2);
    expect(attempts.get("fresh-b")).toBe(2);
    expect(result.missingSettings).toBe(0);
    for (const [id, path] of [
      ["fresh-a", "/root/fresh_a"],
      ["fresh-b", "/root/fresh_b"],
    ] as const)
      expect(result.threads.find((row) => row.id === id)).toMatchObject({
        parentThreadId: "root",
        model: "gpt-6-astra",
        effort: "low",
        collaborationIdentity: {
          state: "verified",
          path,
          sources: ["live_inventory"],
        },
      });
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

  test("rehydrates persisted and archived descendants with exact parentage and preserves conflicts", async () => {
    const live = snapshot([thread("root"), thread("child"), thread("conflict", "root")]);
    const detail = (id: string, parentThreadId: string, path: string) => ({
      id,
      parentThreadId,
      cwd: "/workspace",
      status: { type: "notLoaded" },
      collaborationIdentity: { state: "verified" as const, path },
    });
    const result = await readThreadMonitor(
      {
        async request(method, params) {
          if (method === "state.get") return live;
          const input = params as Record<string, unknown>;
          if (method === "conversation.thread.get") return metadata(String(input["threadId"]));
          expect(method).toBe("conversation.threads.list");
          const archived = input["archived"] === true;
          const cursor = input["cursor"];
          const data = archived
            ? [detail("archived", "child", "/root/child/archived")]
            : cursor
              ? [detail("conflict", "other", "/root/other_conflict")]
              : [detail("child", "root", "/root/child")];
          return {
            instanceId: "call",
            generation: 1,
            method,
            rootThreadId: "root",
            revisionBefore: 4,
            revisionAfter: 4,
            changedDuringRead: false,
            data,
            nextCursor: !archived && !cursor ? "next" : null,
          };
        },
      },
      expected,
    );
    expect(result.nativeSessionId).toBe("root");
    expect(result.historyCoverage).toBe("complete");
    expect(result.threads.map((row) => row.id).sort()).toEqual([
      "archived",
      "child",
      "conflict",
      "root",
    ]);
    expect(result.threads.find((row) => row.id === "archived")).toMatchObject({
      status: "notLoaded",
      parentage: {
        state: "verified",
        parentThreadId: "child",
        sources: ["native_history"],
      },
      collaborationIdentity: {
        state: "verified",
        path: "/root/child/archived",
        sources: ["native_history"],
      },
    });
    expect(result.threads.find((row) => row.id === "child")?.parentage).toEqual({
      state: "verified",
      parentThreadId: "root",
      sources: ["live_inventory", "native_history"],
    });
    expect(result.threads.find((row) => row.id === "conflict")).toMatchObject({
      parentThreadId: null,
      parentage: {
        state: "conflict",
        parentThreadIds: ["other", "root"],
        sources: ["live_inventory", "native_history"],
      },
      collaborationIdentity: {
        state: "conflict",
        paths: ["/root/conflict", "/root/other_conflict"],
        sources: ["live_inventory", "native_history"],
      },
    });
  });

  test("hydrates authoritative timing for persisted descendants without reading turn items", async () => {
    const live = snapshot([
      {
        ...thread("root"),
        status: "active",
        turn: { id: "root-turn", status: "inProgress", startedAt: 1_700_000_000 },
      },
    ]);
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const result = await readThreadMonitor(
      {
        async request(method, params) {
          const input = params as Record<string, unknown>;
          calls.push({ method, params: input });
          if (method === "state.get") return live;
          if (method === "conversation.thread.get") return metadata(String(input["threadId"]));
          if (method === "conversation.turns.list")
            return {
              instanceId: "call",
              generation: 1,
              method,
              rootThreadId: "root",
              threadId: "historical",
              revisionBefore: 7,
              revisionAfter: 7,
              changedDuringRead: false,
              data: [
                {
                  id: "historical-turn",
                  status: "completed",
                  startedAt: 1_699_999_900,
                  completedAt: 1_699_999_950,
                },
              ],
              nextCursor: null,
            };
          expect(method).toBe("conversation.threads.list");
          return {
            instanceId: "call",
            generation: 1,
            method,
            rootThreadId: "root",
            revisionBefore: 7,
            revisionAfter: 7,
            changedDuringRead: false,
            data:
              input["archived"] === true
                ? []
                : [
                    {
                      id: "historical",
                      parentThreadId: "root",
                      cwd: "/workspace",
                      status: { type: "notLoaded" },
                      collaborationIdentity: {
                        state: "verified",
                        path: "/root/historical",
                      },
                    },
                  ],
            nextCursor: null,
          };
        },
      },
      expected,
    );
    expect(result.threads.find((row) => row.id === "root")?.turn).toEqual({
      id: "root-turn",
      status: "inProgress",
      startedAt: 1_700_000_000,
    });
    expect(result.threads.find((row) => row.id === "historical")?.turn).toEqual({
      id: "historical-turn",
      status: "completed",
      startedAt: 1_699_999_900,
      completedAt: 1_699_999_950,
    });
    expect(calls.find((call) => call.method === "conversation.turns.list")?.params).toMatchObject({
      threadId: "historical",
      limit: 1,
      sortDirection: "desc",
    });
    expect(JSON.stringify(calls)).not.toContain("items");
  });

  test("enriches only exact nonconflicting live turns from independent history evidence", async () => {
    const live = snapshot([
      thread("root"),
      {
        ...thread("same", "root"),
        turn: { id: "same-turn", status: "failed" },
      },
      {
        ...thread("conflict", "root"),
        turn: { id: "conflict-turn", status: "failed", startedAt: 30 },
      },
      {
        ...thread("different", "root"),
        status: "active",
        turn: { id: "new-turn", status: "inProgress", startedAt: 50 },
      },
    ]);
    const historyTurn = (id: string) => {
      if (id === "same")
        return { id: "same-turn", status: "completed", startedAt: 10, completedAt: 20 };
      if (id === "conflict")
        return { id: "conflict-turn", status: "completed", startedAt: 31, completedAt: 40 };
      return { id: "old-turn", status: "completed", startedAt: 1, completedAt: 2 };
    };
    const result = await readThreadMonitor(
      {
        async request(method, params) {
          const input = params as Record<string, unknown>;
          if (method === "state.get") return live;
          if (method === "conversation.thread.get") return metadata(String(input["threadId"]));
          if (method === "conversation.turns.list")
            return {
              instanceId: "call",
              generation: 1,
              method,
              rootThreadId: "root",
              threadId: input["threadId"],
              revisionBefore: 9,
              revisionAfter: 9,
              changedDuringRead: false,
              data: [historyTurn(String(input["threadId"]))],
              nextCursor: null,
            };
          expect(method).toBe("conversation.threads.list");
          return {
            instanceId: "call",
            generation: 1,
            method,
            rootThreadId: "root",
            revisionBefore: 9,
            revisionAfter: 9,
            changedDuringRead: false,
            data:
              input["archived"] === true
                ? []
                : ["same", "conflict", "different"].map((id) => ({
                    id,
                    parentThreadId: "root",
                    cwd: "/workspace",
                    status: { type: "notLoaded" },
                    collaborationIdentity: {
                      state: "verified",
                      path: `/root/${id}`,
                    },
                  })),
            nextCursor: null,
          };
        },
      },
      expected,
    );
    expect(result.threads.find((row) => row.id === "same")?.turn).toEqual({
      id: "same-turn",
      status: "failed",
      startedAt: 10,
      completedAt: 20,
    });
    expect(result.threads.find((row) => row.id === "conflict")?.turn).toEqual({
      id: "conflict-turn",
      status: "failed",
      startedAt: 30,
    });
    expect(result.threads.find((row) => row.id === "different")?.turn).toEqual({
      id: "new-turn",
      status: "inProgress",
      startedAt: 50,
    });
  });

  test("marks native history partial when descendant pages cross a native revision", async () => {
    const live = snapshot([thread("root"), thread("child", "root")]);
    let page = 0;
    const result = await readThreadMonitor(
      {
        async request(method, params) {
          if (method === "state.get") return live;
          const input = params as Record<string, unknown>;
          if (method === "conversation.thread.get") return metadata(String(input["threadId"]));
          page++;
          return {
            instanceId: "call",
            generation: 1,
            method,
            rootThreadId: "root",
            revisionBefore: page,
            revisionAfter: page,
            changedDuringRead: false,
            data: [],
            nextCursor: null,
          };
        },
      },
      expected,
    );
    expect(result.historyCoverage).toBe("partial");
    expect(result.threads.find((row) => row.id === "child")?.parentage).toEqual({
      state: "verified",
      parentThreadId: "root",
      sources: ["live_inventory"],
    });
  });

  test("partial history retains overlapping evidence for current live parentage", async () => {
    const liveRows = [
      thread("root"),
      ...Array.from({ length: 12 }, (_, index) => ({
        ...thread(`live-${index}`),
        status: "active" as const,
      })),
    ];
    const historical = [
      {
        id: "live-0",
        parentThreadId: "root",
        cwd: "/workspace",
        status: { type: "notLoaded" as const },
        collaborationIdentity: { state: "verified" as const, path: "/root/live_0" },
      },
      ...Array.from({ length: 255 }, (_, index) => ({
        id: `history-${index.toString().padStart(3, "0")}`,
        parentThreadId: "root",
        cwd: "/workspace",
        status: { type: "notLoaded" as const },
        collaborationIdentity: {
          state: "verified" as const,
          path: `/root/history_${index.toString().padStart(3, "0")}`,
        },
      })),
    ];
    const result = await readThreadMonitor(
      {
        async request(method, params) {
          if (method === "state.get") return snapshot(liveRows);
          const input = params as Record<string, unknown>;
          if (method === "conversation.thread.get") {
            const id = String(input["threadId"]);
            return {
              ...metadata(id),
              data: { ...metadata(id).data, parentThreadId: id === "root" ? null : undefined },
            };
          }
          const start = Number(input["cursor"] ?? 0);
          const limit = Number(input["limit"]);
          const data = historical.slice(start, start + limit);
          const next = start + data.length;
          return {
            instanceId: "call",
            generation: 1,
            method,
            rootThreadId: "root",
            revisionBefore: 1,
            revisionAfter: 1,
            changedDuringRead: false,
            data,
            nextCursor: next >= historical.length ? "more-history" : String(next),
          };
        },
      },
      expected,
    );
    expect(result.historyCoverage).toBe("partial");
    expect(result.threads).toHaveLength(256);
    expect(result.threads.find((row) => row.id === "live-0")).toMatchObject({
      parentThreadId: "root",
      parentage: {
        state: "verified",
        parentThreadId: "root",
        sources: ["native_history"],
      },
      collaborationIdentity: {
        state: "verified",
        path: "/root/live_0",
        sources: ["live_inventory", "native_history"],
      },
    });
    expect(result.threads.filter((row) => row.status !== "notLoaded")).toHaveLength(13);
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

  test("reads the actual private event socket without subscription or control mutation", async () => {
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
      expect(reads).toEqual([
        "conversation.thread.get",
        "conversation.thread.get",
        "conversation.threads.list",
        "conversation.threads.list",
      ]);
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
