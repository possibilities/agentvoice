import { describe, expect, test } from "bun:test";
import {
  archiveWorkerThread,
  deleteWorkerThread,
  dispatchTools,
  finalAgentMessage,
  type WorkerEffects,
  WorkerManager,
  WorkerTurnStartError,
} from "../src/server/workers.ts";

interface Recorded {
  briefs: string[];
  threadsStarted: number;
  interrupted: Array<{ threadId: string; turnId: string }>;
  archived: string[];
  deleted: string[];
  cleanupRetries: Array<{ run: () => void; delayMs: number }>;
  reports: string[];
}

function manager(
  overrides: Partial<WorkerEffects> = {},
  pushReports = true,
): {
  workers: WorkerManager;
  recorded: Recorded;
} {
  const recorded: Recorded = {
    briefs: [],
    threadsStarted: 0,
    interrupted: [],
    archived: [],
    deleted: [],
    cleanupRetries: [],
    reports: [],
  };
  let clock = 1_000;
  const workers = new WorkerManager(
    {
      async startWorkerThread() {
        recorded.threadsStarted++;
        return { threadId: `th_${recorded.threadsStarted}` };
      },
      async startWorkerTurn(threadId, brief) {
        recorded.briefs.push(brief);
        return { turnId: `tu_${threadId.slice(3)}` };
      },
      async interruptWorker(threadId, turnId) {
        recorded.interrupted.push({ threadId, turnId });
      },
      async archiveWorker(threadId) {
        recorded.archived.push(threadId);
      },
      async deleteWorker(threadId) {
        recorded.deleted.push(threadId);
      },
      scheduleCleanupRetry(run, delayMs) {
        recorded.cleanupRetries.push({ run, delayMs });
      },
      reportToOrchestrator(text) {
        recorded.reports.push(text);
      },
      now: () => (clock += 500),
      ...overrides,
    },
    pushReports,
  );
  return { workers, recorded };
}

function text(response: Record<string, unknown>): string {
  const items = response["contentItems"] as Array<{ text: string }>;
  return items.map((item) => item.text).join("\n");
}

describe("worker thread retirement", () => {
  test("archive succeeds and delete tolerates absent or unmaterialized threads", async () => {
    const calls: string[] = [];
    await archiveWorkerThread(async (method) => {
      calls.push(method);
      return {};
    }, "th_1");
    await deleteWorkerThread(async (method) => {
      calls.push(method);
      throw new Error("thread not found: th_1");
    }, "th_1");
    await deleteWorkerThread(async (method) => {
      calls.push(method);
      throw new Error("no rollout found for thread id th_2");
    }, "th_2");
    expect(calls).toEqual(["thread/archive", "thread/delete", "thread/delete"]);
  });

  test("an already-archived rollout is preserved", async () => {
    const calls: string[] = [];
    await archiveWorkerThread(async (method) => {
      calls.push(method);
      if (method === "thread/archive") throw new Error("no rollout found for thread id th_1");
      return { thread: { status: { type: "notLoaded" } } };
    }, "th_1");
    expect(calls).toEqual(["thread/archive", "thread/read"]);
  });

  test("a live pre-rollout root falls back from archive to deletion", async () => {
    const calls: string[] = [];
    await archiveWorkerThread(async (method) => {
      calls.push(method);
      if (method === "thread/archive") throw new Error("no rollout found for thread id th_1");
      if (method === "thread/read") return { thread: { status: { type: "idle" } } };
      return {};
    }, "th_1");
    expect(calls).toEqual(["thread/archive", "thread/read", "thread/delete"]);
  });

  test("an unloaded pre-rollout root from an earlier app-server is deleted", async () => {
    const calls: string[] = [];
    await archiveWorkerThread(async (method) => {
      calls.push(method);
      if (method === "thread/archive") throw new Error("no rollout found for thread id th_1");
      if (method === "thread/read") throw new Error("thread not loaded: th_1");
      return {};
    }, "th_1");
    expect(calls).toEqual(["thread/archive", "thread/read", "thread/delete"]);
  });

  test("unexpected archive and read states stay failures for the retry loop", async () => {
    const archiveFailure = new Error("archive store unavailable");
    expect(
      archiveWorkerThread(async () => {
        throw archiveFailure;
      }, "th_1"),
    ).rejects.toBe(archiveFailure);

    const noRollout = new Error("no rollout found for thread id th_1");
    expect(
      archiveWorkerThread(async (method) => {
        if (method === "thread/archive") throw noRollout;
        return { thread: { status: { type: "active" } } };
      }, "th_1"),
    ).rejects.toBe(noRollout);
  });
});

describe("the dispatch tool specs", () => {
  test("declare the three tools as functions with input schemas", () => {
    for (const pushReports of [true, false]) {
      const tools = dispatchTools(pushReports);
      expect(tools.map((tool) => tool["name"])).toEqual([
        "dispatch_worker",
        "check_workers",
        "cancel_worker",
      ]);
      for (const tool of tools) {
        expect(tool["type"]).toBe("function");
        expect(tool["inputSchema"]).toBeDefined();
        expect(String(tool["description"]).length).toBeGreaterThan(0);
      }
    }
  });

  test("the description promises only the behavior the mode delivers", () => {
    const describeDispatch = (pushReports: boolean) =>
      String(dispatchTools(pushReports)[0]?.["description"]);
    expect(describeDispatch(true)).toContain("report arrives");
    expect(describeDispatch(true)).not.toContain("call check_workers");
    expect(describeDispatch(false)).toContain("check_workers");
    expect(describeDispatch(false)).toContain("nothing is pushed");
  });
});

describe("dispatching", () => {
  test("starts a worker and hands back a speakable handle", async () => {
    const { workers, recorded } = manager();
    const response = await workers.handleToolCall("dispatch_worker", {
      title: "lint sweep",
      brief: "Run the linter across src/ and fix what it flags.",
    });
    expect(response["success"]).toBe(true);
    expect(text(response)).toContain('w1 "lint sweep" is running');
    expect(recorded.briefs).toEqual(["Run the linter across src/ and fix what it flags."]);
    expect(workers.ownsThread("th_1")).toBe(true);
  });

  test("refuses a dispatch without a title or brief", async () => {
    const { workers, recorded } = manager();
    const response = await workers.handleToolCall("dispatch_worker", { title: "x" });
    expect(response["success"]).toBe(false);
    expect(recorded.briefs).toEqual([]);
  });

  test("a failed start is a refusal the model can read, not a hang", async () => {
    const { workers } = manager({
      startWorkerThread: async () => {
        throw new Error("app-server is not running");
      },
    });
    const response = await workers.handleToolCall("dispatch_worker", {
      title: "doomed",
      brief: "anything",
    });
    expect(response["success"]).toBe(false);
    expect(text(response)).toContain("app-server is not running");
  });

  test("owns the thread before turn/start can emit completion", async () => {
    let owner: WorkerManager;
    const setup = manager({
      async startWorkerTurn(threadId) {
        expect(owner.ownsThread(threadId)).toBe(true);
        owner.handleTurnCompleted(threadId, {
          status: "completed",
          items: [{ type: "agentMessage", text: "instant result" }],
        });
        return { turnId: "tu_fast" };
      },
    });
    owner = setup.workers;
    const response = await owner.handleToolCall("dispatch_worker", {
      title: "fast",
      brief: "finish immediately",
    });
    expect(response["success"]).toBe(true);
    expect(text(response)).toContain("finished before dispatch returned");
    expect(text(await owner.handleToolCall("check_workers", {}))).toContain("instant result");
    expect(setup.recorded.archived).toEqual(["th_1"]);
  });

  test("deletes a thread whose initial turn fails to start", async () => {
    const { workers, recorded } = manager({
      startWorkerTurn: async () => {
        throw new WorkerTurnStartError("turn rejected", false);
      },
    });
    const response = await workers.handleToolCall("dispatch_worker", {
      title: "partial",
      brief: "never lands",
    });
    expect(response["success"]).toBe(false);
    expect(text(response)).toContain("dispatch failed for w1");
    expect(workers.ownsThread("th_1")).toBe(true);
    expect(recorded.deleted).toEqual(["th_1"]);
    expect(recorded.archived).toEqual([]);
  });

  test("archives an ambiguous turn/start failure instead of erasing possible history", async () => {
    const { workers, recorded } = manager({
      startWorkerTurn: async () => {
        throw new WorkerTurnStartError("turn/start timed out", true);
      },
    });
    const response = await workers.handleToolCall("dispatch_worker", {
      title: "ambiguous",
      brief: "may have landed",
    });
    expect(response["success"]).toBe(false);
    expect(recorded.archived).toEqual(["th_1"]);
    expect(recorded.deleted).toEqual([]);
  });

  test("an app-server reset racing turn/start failure keeps the worker lost", async () => {
    let owner: WorkerManager;
    const setup = manager({
      async startWorkerTurn() {
        owner.reset();
        throw new WorkerTurnStartError("app-server exited before responding", true);
      },
    });
    owner = setup.workers;
    const response = await owner.handleToolCall("dispatch_worker", {
      title: "restart race",
      brief: "may disappear",
    });
    expect(response["success"]).toBe(true);
    expect(owner.snapshots()[0]?.status).toBe("lost");
    expect(setup.recorded.archived).toEqual(["th_1"]);
    expect(setup.recorded.deleted).toEqual([]);
  });

  test("unknown tools are refused by name", async () => {
    const { workers } = manager();
    const response = await workers.handleToolCall("summon_demon", {});
    expect(response["success"]).toBe(false);
    expect(text(response)).toContain("summon_demon");
  });
});

describe("checking", () => {
  test("says plainly when nothing was dispatched", async () => {
    const { workers } = manager();
    expect(text(await workers.handleToolCall("check_workers", {}))).toContain("no workers");
  });

  test("lists every worker with status and report", async () => {
    const { workers } = manager();
    await workers.handleToolCall("dispatch_worker", { title: "one", brief: "b1" });
    await workers.handleToolCall("dispatch_worker", { title: "two", brief: "b2" });
    workers.handleTurnCompleted("th_1", {
      status: "completed",
      items: [{ type: "agentMessage", text: "all done" }],
    });
    const listing = text(await workers.handleToolCall("check_workers", {}));
    expect(listing).toContain('w1 "one" — completed');
    expect(listing).toContain("all done");
    expect(listing).toContain('w2 "two" — running');
  });
});

describe("cancelling", () => {
  test("interrupts a running worker", async () => {
    const { workers, recorded } = manager();
    await workers.handleToolCall("dispatch_worker", { title: "one", brief: "b1" });
    const response = await workers.handleToolCall("cancel_worker", { worker: "w1" });
    expect(response["success"]).toBe(true);
    expect(recorded.interrupted).toEqual([{ threadId: "th_1", turnId: "tu_1" }]);
    expect(workers.snapshots()[0]?.status).toBe("cancelled");
    expect(workers.hasUnfinishedWork()).toBe(true);
    workers.handleTurnCompleted("th_1", {
      status: "interrupted",
      items: [{ type: "agentMessage", text: "stopped safely" }],
    });
    expect(workers.snapshots()[0]?.status).toBe("cancelled");
    expect(workers.snapshots()[0]?.report).toBe("stopped safely");
    expect(recorded.archived).toEqual(["th_1"]);
  });

  test("a terminal notification racing the interrupt response stays cancelled", async () => {
    let owner: WorkerManager;
    const setup = manager({
      async interruptWorker(threadId) {
        owner.handleTurnCompleted(threadId, {
          status: "interrupted",
          items: [{ type: "agentMessage", text: "cancel race output" }],
        });
      },
    });
    owner = setup.workers;
    await owner.handleToolCall("dispatch_worker", { title: "one", brief: "b1" });
    const response = await owner.handleToolCall("cancel_worker", { worker: "w1" });
    expect(response["success"]).toBe(true);
    expect(owner.snapshots()[0]).toMatchObject({
      status: "cancelled",
      report: "cancel race output",
    });
    expect(owner.hasUnfinishedWork()).toBe(false);
    expect(setup.recorded.archived).toEqual(["th_1"]);
  });

  test("a terminal notification racing a rejected interrupt keeps its actual outcome", async () => {
    let owner: WorkerManager;
    const updates: string[] = [];
    const setup = manager({
      async interruptWorker(threadId) {
        owner.handleTurnCompleted(threadId, {
          status: "completed",
          items: [{ type: "agentMessage", text: "completed naturally" }],
        });
        throw new Error("already finished");
      },
      onWorkerUpdate(worker) {
        updates.push(worker.status);
      },
    });
    owner = setup.workers;
    await owner.handleToolCall("dispatch_worker", { title: "one", brief: "b1" });
    const response = await owner.handleToolCall("cancel_worker", { worker: "w1" });
    expect(response["success"]).toBe(true);
    expect(owner.snapshots()[0]).toMatchObject({
      status: "completed",
      report: "completed naturally",
    });
    expect(updates).toEqual(["running", "completed"]);
    expect(setup.recorded.reports[0]).toContain('status="completed"');
  });

  test("refuses a duplicate cancellation while the first request is in flight", async () => {
    let releaseInterrupt: (() => void) | undefined;
    const { workers, recorded } = manager({
      interruptWorker: () =>
        new Promise<void>((resolve) => {
          releaseInterrupt = resolve;
        }),
    });
    await workers.handleToolCall("dispatch_worker", { title: "one", brief: "b1" });
    const first = workers.handleToolCall("cancel_worker", { worker: "w1" });
    await Promise.resolve();
    const duplicate = await workers.handleToolCall("cancel_worker", { worker: "w1" });
    expect(duplicate["success"]).toBe(false);
    expect(text(duplicate)).toContain("already has a cancellation request in flight");
    expect(recorded.interrupted).toEqual([]);
    releaseInterrupt?.();
    expect((await first)["success"]).toBe(true);
  });

  test("refuses unknown handles and finished workers", async () => {
    const { workers } = manager();
    expect((await workers.handleToolCall("cancel_worker", { worker: "w9" }))["success"]).toBe(
      false,
    );
    await workers.handleToolCall("dispatch_worker", { title: "one", brief: "b1" });
    workers.handleTurnCompleted("th_1", { status: "completed", items: [] });
    expect((await workers.handleToolCall("cancel_worker", { worker: "w1" }))["success"]).toBe(
      false,
    );
  });
});

describe("worker reports", () => {
  test("a completed turn becomes a tagged report to the orchestrator", async () => {
    const lifecycleGates: boolean[] = [];
    let owner: WorkerManager;
    const setup = manager({
      onWorkSettled() {
        lifecycleGates.push(owner.hasUnfinishedWork());
      },
    });
    owner = setup.workers;
    const { workers, recorded } = setup;
    await workers.handleToolCall("dispatch_worker", { title: "lint sweep", brief: "b" });
    workers.handleTurnCompleted("th_1", {
      status: "completed",
      items: [
        { type: "commandExecution", text: "noise" },
        { type: "agentMessage", text: "fixed 3 files; lint is clean" },
      ],
    });
    expect(recorded.reports).toHaveLength(1);
    const report = recorded.reports[0] ?? "";
    expect(report).toContain('<worker_report worker="w1" title="lint sweep" status="completed">');
    expect(report).toContain("fixed 3 files; lint is clean");
    expect(report).toContain("</worker_report>");
    expect(report).toContain("not the user speaking");
    // Terminal publication must not open an account-rotation window before
    // archival has at least been marked in flight.
    expect(lifecycleGates[0]).toBe(true);
  });

  test("failed and interrupted statuses carry through", async () => {
    const { workers, recorded } = manager();
    await workers.handleToolCall("dispatch_worker", { title: "one", brief: "b1" });
    await workers.handleToolCall("dispatch_worker", { title: "two", brief: "b2" });
    workers.handleTurnCompleted("th_1", { status: "failed", items: [] });
    workers.handleTurnCompleted("th_2", { status: "interrupted", items: [] });
    expect(recorded.reports[0]).toContain('status="failed"');
    expect(recorded.reports[0]).toContain("no final message");
    expect(recorded.reports[1]).toContain('status="interrupted"');
  });

  test("a very long final message is trimmed, not relayed whole", async () => {
    const { workers, recorded } = manager();
    await workers.handleToolCall("dispatch_worker", { title: "one", brief: "b1" });
    workers.handleTurnCompleted("th_1", {
      status: "completed",
      items: [{ type: "agentMessage", text: "x".repeat(10_000) }],
    });
    const report = recorded.reports[0] ?? "";
    expect(report.length).toBeLessThan(6_000);
    expect(report).toContain("…report truncated…");
  });

  test("turns on unknown threads and repeat completions are ignored", async () => {
    const { workers, recorded } = manager();
    await workers.handleToolCall("dispatch_worker", { title: "one", brief: "b1" });
    workers.handleTurnCompleted("th_other", { status: "completed", items: [] });
    workers.handleTurnCompleted("th_1", { status: "completed", items: [] });
    workers.handleTurnCompleted("th_1", { status: "completed", items: [] });
    expect(recorded.reports).toHaveLength(1);
    expect(recorded.archived).toEqual(["th_1"]);
  });

  test("retries archival without changing the terminal outcome", async () => {
    let attempts = 0;
    const { workers, recorded } = manager({
      async archiveWorker(threadId) {
        recorded.archived.push(threadId);
        attempts++;
        if (attempts === 1) throw new Error("transient archive failure");
      },
    });
    await workers.handleToolCall("dispatch_worker", { title: "one", brief: "b1" });
    workers.handleTurnCompleted("th_1", {
      status: "completed",
      items: [{ type: "agentMessage", text: "durable result" }],
    });
    await Promise.resolve();
    expect(workers.snapshots()[0]).toMatchObject({
      status: "completed",
      report: "durable result",
    });
    expect(workers.hasUnfinishedWork()).toBe(true);
    expect(recorded.cleanupRetries[0]?.delayMs).toBe(250);
    recorded.cleanupRetries[0]?.run();
    await Promise.resolve();
    expect(recorded.archived).toEqual(["th_1", "th_1"]);
    expect(workers.hasUnfinishedWork()).toBe(false);
    expect(workers.snapshots()[0]?.status).toBe("completed");
  });
});

describe("pull-only mode (dispatch-reports off)", () => {
  test("completion is recorded and relayed, but never pushed as a turn", async () => {
    const updates: string[] = [];
    const { workers, recorded } = manager(
      { onWorkerUpdate: (worker) => updates.push(worker.status) },
      false,
    );
    const ack = await workers.handleToolCall("dispatch_worker", { title: "one", brief: "b1" });
    expect(text(ack)).toContain("check_workers");
    expect(text(ack)).not.toContain("report will arrive");
    workers.handleTurnCompleted("th_1", {
      status: "completed",
      items: [{ type: "agentMessage", text: "quietly done" }],
    });
    expect(recorded.reports).toEqual([]);
    expect(updates).toEqual(["running", "completed"]);
    expect(text(await workers.handleToolCall("check_workers", {}))).toContain("quietly done");
  });
});

describe("worker updates for the client feed", () => {
  test("every transition emits a snapshot, and snapshots() replays them", async () => {
    const updates: Array<{ id: string; status: string }> = [];
    const { workers } = manager({
      onWorkerUpdate: (worker) => updates.push({ id: worker.id, status: worker.status }),
    });
    await workers.handleToolCall("dispatch_worker", { title: "one", brief: "b1" });
    await workers.handleToolCall("dispatch_worker", { title: "two", brief: "b2" });
    workers.handleTurnCompleted("th_1", {
      status: "completed",
      items: [{ type: "agentMessage", text: "done" }],
    });
    await workers.handleToolCall("cancel_worker", { worker: "w2" });
    expect(updates).toEqual([
      { id: "w1", status: "running" },
      { id: "w2", status: "running" },
      { id: "w1", status: "completed" },
      { id: "w2", status: "cancelled" },
    ]);
    const snapshots = workers.snapshots();
    expect(snapshots.map((worker) => worker.status)).toEqual(["completed", "cancelled"]);
    expect(snapshots[0]?.report).toBe("done");
    expect(snapshots[0]).not.toHaveProperty("brief");
  });
});

describe("losing the app-server child", () => {
  test("running workers become lost; finished ones keep their outcome", async () => {
    const { workers, recorded } = manager();
    await workers.handleToolCall("dispatch_worker", { title: "one", brief: "b1" });
    await workers.handleToolCall("dispatch_worker", { title: "two", brief: "b2" });
    workers.handleTurnCompleted("th_1", { status: "completed", items: [] });
    workers.reset();
    const listing = text(await workers.handleToolCall("check_workers", {}));
    expect(listing).toContain('w1 "one" — completed');
    expect(listing).toContain('w2 "two" — lost');
    expect(listing).toContain("lost with an app-server restart");
    expect(recorded.archived).toEqual(["th_1", "th_2"]);
  });
});

describe("finalAgentMessage", () => {
  test("takes the last agent message and tolerates junk shapes", () => {
    expect(finalAgentMessage({ items: "nope" })).toBeNull();
    expect(finalAgentMessage({})).toBeNull();
    expect(
      finalAgentMessage({
        items: [
          { type: "agentMessage", text: "first" },
          { type: "reasoning" },
          { type: "agentMessage", text: "last" },
          { type: "commandExecution" },
        ],
      }),
    ).toBe("last");
  });
});
