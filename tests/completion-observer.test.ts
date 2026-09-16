import { expect, test } from "bun:test";
import type { CompletionObservation } from "../src/completions/contract.ts";
import { CompletionObserver } from "../src/completions/observer.ts";

const metadata = (threadId: string, parent = "root", cwd = "/work") => ({
  id: threadId,
  parentThreadId: parent,
  cwd,
  name: "test child",
  status: { type: "idle" },
});

async function createObserver(request?: (method: string, params: unknown) => Promise<unknown>) {
  const events: CompletionObservation[] = [];
  const instance = new CompletionObserver(
    "root",
    "/work",
    request ?? (async () => ({ data: [], nextCursor: null })),
    (event) => events.push(event),
  );
  await instance.start();
  return { observer: instance, events };
}

function turn(
  observer: CompletionObserver,
  method: string,
  threadId: string,
  turnId: string,
  status: string,
) {
  observer.notification(method, {
    threadId,
    turn: { id: turnId, status, items: [{ text: "PRIVATE_RESULT" }] },
  });
}

test("child inventory clears loaded turns on unload and system error", async () => {
  for (const status of ["notLoaded", "systemError"]) {
    const { observer } = await createObserver();
    try {
      observer.notification("thread/started", { thread: metadata("child") });
      turn(observer, "turn/started", "child", "work", "inProgress");
      expect(observer.snapshot().threads).toHaveLength(1);
      observer.notification("thread/status/changed", {
        threadId: "child",
        status: { type: status },
      });
      expect(observer.snapshot().threads).toHaveLength(0);
      turn(observer, "turn/started", "child", "work", "inProgress");
      expect(observer.snapshot().threads).toHaveLength(0);
      if (status === "systemError") expect(observer.snapshot().complete).toBe(false);
    } finally {
      observer.stop();
    }
  }
});

test("observation filters unrelated threads and grandchildren, deduplicates turns, and strips results", async () => {
  const { observer, events } = await createObserver();
  try {
    for (const raw of [
      metadata("child"),
      metadata("foreign", "elsewhere"),
      metadata("grandchild", "child"),
      metadata("other-workspace", "root", "/elsewhere"),
    ]) {
      observer.notification("thread/started", { thread: raw });
      turn(observer, "turn/started", raw.id, "t", "inProgress");
      turn(observer, "turn/completed", raw.id, "t", "completed");
      turn(observer, "turn/completed", raw.id, "t", "completed");
    }
    turn(observer, "turn/completed", "root", "root-turn", "completed");
    expect(events.filter((event) => event.kind === "completed")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_RESULT");
    expect(observer.snapshot().threads).toEqual([]);
    turn(observer, "turn/started", "child", "next", "inProgress");
    observer.notification("thread/status/changed", {
      threadId: "child",
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    });
    turn(observer, "turn/completed", "child", "t", "completed");
    expect(observer.snapshot().threads[0]).toMatchObject({
      turnId: "next",
      waitingOn: ["waitingOnApproval"],
    });
  } finally {
    observer.stop();
  }
});

test("completion before metadata and a newer child turn preserve both identities", async () => {
  const read = Promise.withResolvers<unknown>();
  const { observer, events } = await createObserver(async (method) =>
    method === "thread/loaded/list" ? { data: [], nextCursor: null } : read.promise,
  );
  try {
    turn(observer, "turn/completed", "child", "old", "failed");
    turn(observer, "turn/started", "child", "new", "inProgress");
    expect(events.some((event) => event.kind === "completed")).toBe(false);
    read.resolve({ thread: metadata("child") });
    await Bun.sleep(5);
    expect(events.find((event) => event.kind === "completed")).toMatchObject({
      completion: { threadId: "child", turnId: "old", status: "failed" },
    });
    expect(observer.snapshot().threads[0]?.turnId).toBe("new");
    expect(observer.snapshot().complete).toBe(true);
  } finally {
    read.resolve(null);
    observer.stop();
  }
});

test("terminal observations preserve every native terminal status", async () => {
  for (const status of ["completed", "failed", "interrupted"] as const) {
    const { observer, events } = await createObserver();
    try {
      const child = `child-${status}`;
      observer.notification("thread/started", { thread: metadata(child) });
      turn(observer, "turn/completed", child, `turn-${status}`, status);
      expect(events.find((event) => event.kind === "completed")).toMatchObject({
        completion: { threadId: child, turnId: `turn-${status}`, status },
      });
    } finally {
      observer.stop();
    }
  }
});

test("terminal turns prioritize ancestry verification during the startup inventory scan", async () => {
  const scan = Promise.withResolvers<unknown>();
  const calls: string[] = [];
  let scanResolved = false;
  const events: CompletionObservation[] = [];
  const observer = new CompletionObserver(
    "root",
    "/work",
    async (method) => {
      calls.push(method);
      if (method === "thread/loaded/list") return scan.promise;
      expect(scanResolved).toBe(false);
      return { thread: metadata("child") };
    },
    (event) => events.push(event),
  );
  const startup = observer.start();
  try {
    await Bun.sleep(0);
    turn(observer, "turn/completed", "child", "done", "completed");
    await Bun.sleep(5);
    expect(calls).toEqual(["thread/loaded/list", "thread/read"]);
    expect(events.find((event) => event.kind === "completed")).toMatchObject({
      completion: { threadId: "child", turnId: "done", status: "completed" },
    });
  } finally {
    scanResolved = true;
    scan.resolve({ data: [], nextCursor: null });
    await startup;
    observer.stop();
  }
});
