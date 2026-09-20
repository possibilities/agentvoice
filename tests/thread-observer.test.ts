import { describe, expect, test } from "bun:test";
import { ThreadObserver } from "../src/core/thread-observer.ts";
import { MAX_THREADS, type ThreadInventory } from "../src/events/contract.ts";
import { deferred } from "./fixtures/runtime-harness.ts";

const tick = () => Bun.sleep(0);
async function until(check: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await Bun.sleep(1);
  }
}
describe("native thread observation", () => {
  test("pages only the loaded inventory and projects state without conversation content", async () => {
    const snapshots: ThreadInventory[] = [];
    const calls: [string, unknown][] = [];
    const observer = new ThreadObserver(
      async (method, params) => {
        calls.push([method, params]);
        if (method === "thread/loaded/list")
          return (params as { cursor?: string }).cursor
            ? { data: ["child"], nextCursor: null }
            : { data: ["main"], nextCursor: "next" };
        const id = (params as { threadId: string }).threadId;
        return {
          thread: {
            id,
            parentThreadId: id === "child" ? "main" : null,
            name: "Named thread",
            status: { type: "idle" },
            turns: [{ secret: "conversation content" }],
            preview: "private preview",
          },
        };
      },
      (snapshot) => snapshots.push(structuredClone(snapshot)),
    );
    await observer.start();
    await tick();
    expect(snapshots.at(-1)).toMatchObject({
      complete: true,
      threads: [
        { id: "main", status: "idle" },
        { id: "child", parentThreadId: "main" },
      ],
    });
    expect(
      calls
        .filter(([method]) => method === "thread/read")
        .every(([, params]) => (params as { includeTurns: boolean }).includeTurns === false),
    ).toBe(true);
    observer.notification("thread/status/changed", {
      threadId: "child",
      status: { type: "active", activeFlags: ["waitingOnUserInput"] },
    });
    observer.notification("turn/started", {
      threadId: "child",
      turn: { id: "turn-1", status: "inProgress", startedAt: 100 },
    });
    expect(snapshots.at(-1)?.threads[1]?.turn).toEqual({
      id: "turn-1",
      status: "inProgress",
      startedAt: 100,
    });
    observer.notification("turn/completed", {
      threadId: "child",
      turn: {
        id: "turn-1",
        status: "failed",
        completedAt: 130,
        error: { message: "private error" },
        items: [{ text: "secret" }],
      },
    });
    expect(snapshots.at(-1)?.threads[1]).toMatchObject({
      status: "active",
      activeFlags: ["waitingOnUserInput"],
      turn: { id: "turn-1", status: "failed", startedAt: 100, completedAt: 130 },
    });
    observer.notification("turn/completed", {
      threadId: "child",
      turn: { id: "turn-2", status: "interrupted", startedAt: 200, completedAt: 240 },
    });
    expect(snapshots.at(-1)?.threads[1]?.turn).toEqual({
      id: "turn-2",
      status: "interrupted",
      startedAt: 200,
      completedAt: 240,
    });
    const text = JSON.stringify(snapshots);
    for (const secret of ["conversation content", "private preview", "private error", "secret"])
      expect(text).not.toContain(secret);
    observer.notification("thread/closed", { threadId: "child" });
    expect(snapshots.at(-1)?.threads.map((thread) => thread.id)).toEqual(["main"]);
    observer.stop();
  });

  test("reconciles bounded native turn timing and leaves unavailable timestamps absent", async () => {
    let latest!: ThreadInventory;
    const observer = new ThreadObserver(
      async (method, params) => {
        const input = params as { threadId?: string; itemsView?: string };
        if (method === "thread/loaded/list") return { data: ["complete", "partial", "legacy"] };
        if (method === "thread/read")
          return { thread: { id: input.threadId, status: { type: "idle" } } };
        expect(method).toBe("thread/turns/list");
        expect(input.itemsView).toBe("notLoaded");
        if (input.threadId === "legacy") throw new Error("unsupported");
        return {
          data: [
            input.threadId === "complete"
              ? {
                  id: "turn-complete",
                  status: "completed",
                  startedAt: 10,
                  completedAt: 20,
                  items: [{ text: "private" }],
                }
              : { id: "turn-partial", status: "interrupted", startedAt: null },
          ],
        };
      },
      (value) => {
        latest = structuredClone(value);
      },
    );
    await observer.start();
    await until(() => latest.complete);
    expect(latest.complete).toBe(true);
    expect(latest.threads.find((thread) => thread.id === "complete")?.turn).toEqual({
      id: "turn-complete",
      status: "completed",
      startedAt: 10,
      completedAt: 20,
    });
    expect(latest.threads.find((thread) => thread.id === "partial")?.turn).toEqual({
      id: "turn-partial",
      status: "interrupted",
    });
    expect(latest.threads.find((thread) => thread.id === "legacy")?.turn).toBeNull();
    expect(JSON.stringify(latest)).not.toContain("private");
    observer.stop();
  });

  test("late reads cannot rewind a newer active state or resurrect an unloaded thread", async () => {
    const read = deferred<unknown>();
    let latest!: ThreadInventory;
    const observer = new ThreadObserver(
      async (method) => (method === "thread/loaded/list" ? { data: ["main"] } : read.promise),
      (value) => {
        latest = structuredClone(value);
      },
    );
    await observer.start();
    observer.notification("thread/status/changed", {
      threadId: "main",
      status: { type: "active", activeFlags: [] },
    });
    read.resolve({ thread: { id: "main", name: "Name", status: { type: "idle" } } });
    await tick();
    expect(latest.threads[0]).toMatchObject({ name: "Name", status: "active" });
    observer.stop();

    const late = deferred<unknown>();
    const closed = new ThreadObserver(
      async (method) => (method === "thread/loaded/list" ? { data: ["main"] } : late.promise),
      (value) => {
        latest = structuredClone(value);
      },
    );
    await closed.start();
    closed.notification("thread/closed", { threadId: "main" });
    late.resolve({ thread: { id: "main", status: { type: "idle" } } });
    await tick();
    expect(latest.threads).toEqual([]);
    closed.stop();
  });

  test("a close racing the inventory page stays removed; failed observation is explicit", async () => {
    const list = deferred<unknown>();
    let latest!: ThreadInventory;
    let reads = 0;
    const observer = new ThreadObserver(
      async (method) => {
        if (method === "thread/loaded/list") return list.promise;
        reads++;
        throw new Error("no history");
      },
      (value) => {
        latest = value;
      },
    );
    const started = observer.start();
    observer.notification("thread/closed", { threadId: "old" });
    list.resolve({ data: ["old", "ephemeral"] });
    await started;
    await tick();
    expect(reads).toBe(1);
    expect(latest).toMatchObject({
      complete: false,
      threads: [{ id: "ephemeral", status: "unknown" }],
    });
    observer.stop();
  });

  test("clearing a name while metadata is pending cannot restore the old name", async () => {
    const read = deferred<unknown>();
    let latest!: ThreadInventory;
    const observer = new ThreadObserver(
      async (method) => (method === "thread/loaded/list" ? { data: ["main"] } : read.promise),
      (value) => {
        latest = structuredClone(value);
      },
    );
    await observer.start();
    observer.notification("thread/name/updated", { threadId: "main", threadName: null });
    read.resolve({ thread: { id: "main", name: "Old name", status: { type: "idle" } } });
    await tick();
    expect(latest.threads[0]?.name).toBeNull();
    observer.stop();
  });

  test("bounds inventory and drops late publication after stop", async () => {
    let latest!: ThreadInventory;
    const observer = new ThreadObserver(
      async () => {
        throw new Error("unsupported");
      },
      (value) => {
        latest = value;
      },
    );
    for (let i = 0; i <= MAX_THREADS; i++)
      observer.seed({ id: `t-${i}`, status: { type: "idle" } });
    await observer.start();
    expect(latest.threads).toHaveLength(MAX_THREADS);
    expect(latest.complete).toBe(false);
    observer.stop();
    observer.notification("thread/closed", { threadId: "t-0" });
    expect(latest.threads).toHaveLength(MAX_THREADS);
  });

  test("filters unloaded scan rows before the published bound", async () => {
    const ids = Array.from(
      { length: 300 },
      (_, index) => `thread-${index.toString().padStart(3, "0")}`,
    );
    let activeReads = 0;
    let maxActiveReads = 0;
    let latest!: ThreadInventory;
    const observer = new ThreadObserver(
      async (method, params) => {
        const input = params as { cursor?: string; threadId?: string };
        if (method === "thread/loaded/list") {
          const start = Number(input.cursor ?? 0);
          const data = ids.slice(start, start + 100);
          const next = start + data.length;
          return { data, nextCursor: next < ids.length ? String(next) : null };
        }
        const index = ids.indexOf(input.threadId!);
        activeReads++;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await Bun.sleep(0);
        activeReads--;
        return {
          thread: {
            id: input.threadId,
            parentThreadId: index === 287 ? null : "thread-287",
            name: input.threadId,
            status: { type: index < 287 ? "notLoaded" : "idle" },
          },
        };
      },
      (value) => {
        latest = structuredClone(value);
      },
    );
    await observer.start();
    await until(() => latest?.complete === true);
    expect(latest.threads).toHaveLength(13);
    expect(latest.threads.every((thread) => thread.status === "idle")).toBe(true);
    expect(maxActiveReads).toBeLessThanOrEqual(4);
    observer.stop();
  });

  test("retries a failed scan and refreshes parent metadata for a started thread", async () => {
    let attempts = 0;
    let latest!: ThreadInventory;
    const observer = new ThreadObserver(
      async (method, params) => {
        if (method === "thread/loaded/list") {
          const cursor = (params as { cursor?: string }).cursor;
          if (!cursor) attempts++;
          if (attempts === 1) return { data: [], nextCursor: "repeat" };
          return cursor
            ? {
                data: cursor === "continue" ? ["root"] : [],
                nextCursor: cursor === "continue" ? null : cursor,
              }
            : { data: [], nextCursor: "continue" };
        }
        const id = (params as { threadId: string }).threadId;
        return {
          thread: {
            id,
            parentThreadId: id === "child" ? "root" : null,
            status: { type: id === "child" ? "active" : "idle" },
          },
        };
      },
      (value) => {
        latest = structuredClone(value);
      },
      { retryMinMs: 1, retryMaxMs: 1 },
    );
    await observer.start();
    expect(latest.complete).toBe(false);
    await until(() => latest?.complete === true);
    expect(attempts).toBe(2);

    observer.notification("thread/started", {
      thread: { id: "child", parentThreadId: null, status: { type: "active" } },
    });
    await until(() => latest.threads.some((thread) => thread.parentThreadId === "root"));
    expect(latest.threads.find((thread) => thread.id === "child")).toMatchObject({
      parentThreadId: "root",
      status: "active",
    });
    observer.stop();
  });

  test("keeps genuine live overflow incomplete and clears it after capacity recovers", async () => {
    let ids = Array.from({ length: MAX_THREADS + 1 }, (_, index) => `live-${index}`);
    let latest!: ThreadInventory;
    const observer = new ThreadObserver(
      async (method, params) => {
        const input = params as { cursor?: string; threadId?: string };
        if (method === "thread/loaded/list") {
          const start = Number(input.cursor ?? 0);
          const data = ids.slice(start, start + 100);
          const next = start + data.length;
          return { data, nextCursor: next < ids.length ? String(next) : null };
        }
        return {
          thread: {
            id: input.threadId,
            status: { type: "idle" },
          },
        };
      },
      (value) => {
        latest = structuredClone(value);
      },
      { retryMinMs: 5, retryMaxMs: 5 },
    );
    await observer.start();
    await until(() => latest?.threads.length === MAX_THREADS && latest.complete === false);
    ids = ids.slice(0, MAX_THREADS);
    await until(() => latest?.complete === true);
    expect(latest.threads).toHaveLength(MAX_THREADS);
    observer.stop();
  });
});
