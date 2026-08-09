import { describe, expect, test } from "bun:test";
import {
  DISPATCH_TOOLS,
  finalAgentMessage,
  type WorkerEffects,
  WorkerManager,
} from "../src/server/workers.ts";

interface Recorded {
  briefs: string[];
  interrupted: Array<{ threadId: string; turnId: string }>;
  reports: string[];
}

function manager(overrides: Partial<WorkerEffects> = {}): {
  workers: WorkerManager;
  recorded: Recorded;
} {
  const recorded: Recorded = { briefs: [], interrupted: [], reports: [] };
  let clock = 1_000;
  const workers = new WorkerManager({
    async startWorker(brief) {
      recorded.briefs.push(brief);
      return { threadId: `th_${recorded.briefs.length}`, turnId: `tu_${recorded.briefs.length}` };
    },
    async interruptWorker(threadId, turnId) {
      recorded.interrupted.push({ threadId, turnId });
    },
    reportToOrchestrator(text) {
      recorded.reports.push(text);
    },
    now: () => (clock += 500),
    ...overrides,
  });
  return { workers, recorded };
}

function text(response: Record<string, unknown>): string {
  const items = response["contentItems"] as Array<{ text: string }>;
  return items.map((item) => item.text).join("\n");
}

describe("the dispatch tool specs", () => {
  test("declare the three tools as functions with input schemas", () => {
    expect(DISPATCH_TOOLS.map((tool) => tool["name"])).toEqual([
      "dispatch_worker",
      "check_workers",
      "cancel_worker",
    ]);
    for (const tool of DISPATCH_TOOLS) {
      expect(tool["type"]).toBe("function");
      expect(tool["inputSchema"]).toBeDefined();
      expect(String(tool["description"]).length).toBeGreaterThan(0);
    }
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
      startWorker: async () => {
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
    const { workers, recorded } = manager();
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
  });
});

describe("losing the app-server child", () => {
  test("running workers become lost; finished ones keep their outcome", async () => {
    const { workers } = manager();
    await workers.handleToolCall("dispatch_worker", { title: "one", brief: "b1" });
    await workers.handleToolCall("dispatch_worker", { title: "two", brief: "b2" });
    workers.handleTurnCompleted("th_1", { status: "completed", items: [] });
    workers.reset();
    const listing = text(await workers.handleToolCall("check_workers", {}));
    expect(listing).toContain('w1 "one" — completed');
    expect(listing).toContain('w2 "two" — lost');
    expect(listing).toContain("lost with an app-server restart");
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
