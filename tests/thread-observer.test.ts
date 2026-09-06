import { describe, expect, test } from "bun:test";
import { ThreadObserver } from "../src/core/thread-observer.ts";
import { MAX_THREADS, type ThreadInventory } from "../src/events/contract.ts";
import { deferred } from "./fixtures/runtime-harness.ts";

const tick = () => Bun.sleep(0);
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
    observer.notification("turn/completed", {
      threadId: "child",
      turn: {
        id: "turn-1",
        status: "failed",
        error: { message: "private error" },
        items: [{ text: "secret" }],
      },
    });
    expect(snapshots.at(-1)?.threads[1]).toMatchObject({
      status: "active",
      activeFlags: ["waitingOnUserInput"],
      turn: { id: "turn-1", status: "failed" },
    });
    const text = JSON.stringify(snapshots);
    for (const secret of ["conversation content", "private preview", "private error", "secret"])
      expect(text).not.toContain(secret);
    observer.notification("thread/closed", { threadId: "child" });
    expect(snapshots.at(-1)?.threads.map((thread) => thread.id)).toEqual(["main"]);
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
});
