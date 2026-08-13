import { describe, expect, test } from "bun:test";
import type { RawFrameEvent } from "../src/chats/model.ts";
import {
  applyTranscriptFrame,
  createTranscript,
  hydrateTranscript,
  type TranscriptItem,
  type TranscriptState,
} from "../src/chats/transcript.ts";

const THREAD_ID = "thread-a";
const TURN_ID = "turn-a";

function frame(method: string, params: Record<string, unknown>, emittedAtMs = 1): RawFrameEvent {
  return {
    kind: "thread",
    sequence: emittedAtMs,
    receivedAt: emittedAtMs + 10,
    direction: "fromAppServer",
    owner: "appServer",
    threadId: THREAD_ID,
    payload: { jsonrpc: "2.0", method, params, emittedAtMs },
  };
}

function apply(state: TranscriptState, ...frames: RawFrameEvent[]): TranscriptState {
  return frames.reduce(applyTranscriptFrame, state);
}

function item(state: TranscriptState, id: string): TranscriptItem {
  const value = state.turns.flatMap((turn) => turn.items).find((candidate) => candidate.id === id);
  if (!value) throw new Error(`missing transcript item ${id}`);
  return value;
}

function semantic(state: TranscriptState): unknown {
  return state.turns.map((turn) => ({
    id: turn.id,
    status: turn.status,
    items: turn.items.map((value) => ({
      id: value.id,
      type: value.type,
      family: value.family,
      status: value.status,
      text: value.text,
      summary: value.summary,
      content: value.content,
      output: value.output,
      diff: value.diff,
    })),
  }));
}

describe("Codex transcript projection", () => {
  test("projects historical turns and equivalent live item lifecycles identically", () => {
    const user = {
      type: "userMessage",
      id: "user-a",
      clientId: null,
      content: [{ type: "text", text: "Inspect the worker cleanup", text_elements: [] }],
    };
    const reasoning = {
      type: "reasoning",
      id: "reasoning-a",
      summary: ["Tracing ownership"],
      content: ["The registry owns cleanup."],
    };
    const command = {
      type: "commandExecution",
      id: "command-a",
      command: 'rg -n "cleanup" src',
      cwd: "/tmp/project",
      status: "completed",
      aggregatedOutput: "src/workers.ts:40:cleanup\n",
      exitCode: 0,
      durationMs: 18,
    };
    const agent = {
      type: "agentMessage",
      id: "agent-a",
      text: "The cleanup is owned by the worker registry.",
      phase: "final_answer",
      memoryCitation: null,
    };
    const completedTurn = {
      id: TURN_ID,
      items: [user, reasoning, command, agent],
      itemsView: "full",
      status: "completed",
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1_000,
    };

    const historical = hydrateTranscript(THREAD_ID, {
      id: THREAD_ID,
      turns: [completedTurn],
    });
    let live = createTranscript(THREAD_ID);
    live = apply(
      live,
      frame("turn/started", {
        threadId: THREAD_ID,
        turn: { ...completedTurn, items: [], status: "inProgress", completedAt: null },
      }),
      frame("item/started", { threadId: THREAD_ID, turnId: TURN_ID, item: user }, 2),
      frame("item/completed", { threadId: THREAD_ID, turnId: TURN_ID, item: user }, 3),
      frame(
        "item/started",
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: { ...reasoning, summary: [], content: [] },
        },
        4,
      ),
      frame(
        "item/reasoning/summaryTextDelta",
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: reasoning.id,
          summaryIndex: 0,
          delta: "Tracing ownership",
        },
        5,
      ),
      frame(
        "item/reasoning/textDelta",
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: reasoning.id,
          contentIndex: 0,
          delta: "The registry owns cleanup.",
        },
        6,
      ),
      frame("item/completed", { threadId: THREAD_ID, turnId: TURN_ID, item: reasoning }, 7),
      frame(
        "item/started",
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: { ...command, status: "inProgress", aggregatedOutput: null },
        },
        8,
      ),
      frame(
        "item/commandExecution/outputDelta",
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: command.id,
          delta: command.aggregatedOutput,
        },
        9,
      ),
      frame("item/completed", { threadId: THREAD_ID, turnId: TURN_ID, item: command }, 10),
      frame(
        "item/started",
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: { ...agent, text: "" },
        },
        11,
      ),
      frame(
        "item/agentMessage/delta",
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: agent.id,
          delta: agent.text,
        },
        12,
      ),
      frame("item/completed", { threadId: THREAD_ID, turnId: TURN_ID, item: agent }, 13),
      frame("turn/completed", { threadId: THREAD_ID, turn: completedTurn }, 14),
    );

    expect(semantic(live)).toEqual(semantic(historical));
    expect(item(historical, "command-a").raw).toBe(command);
  });

  test("merges duplicate and out-of-order lifecycle notifications monotonically", () => {
    const completed = {
      type: "commandExecution",
      id: "command-a",
      command: "pwd",
      cwd: "/tmp",
      status: "completed",
      aggregatedOutput: "/tmp\n",
      exitCode: 0,
      durationMs: 4,
    };
    const started = { ...completed, status: "inProgress", aggregatedOutput: null, exitCode: null };
    const completedFrame = frame(
      "item/completed",
      { threadId: THREAD_ID, turnId: TURN_ID, item: completed, completedAtMs: 40 },
      40,
    );

    const state = apply(
      createTranscript(THREAD_ID),
      frame(
        "item/commandExecution/outputDelta",
        { threadId: THREAD_ID, turnId: TURN_ID, itemId: completed.id, delta: "/tmp\n" },
        10,
      ),
      completedFrame,
      frame(
        "item/started",
        { threadId: THREAD_ID, turnId: TURN_ID, item: started, startedAtMs: 20 },
        20,
      ),
      completedFrame,
    );

    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.items).toHaveLength(1);
    expect(item(state, completed.id)).toMatchObject({
      status: "completed",
      output: "/tmp\n",
      startedAtMs: 20,
      completedAtMs: 40,
    });
  });

  test("applies streaming text, indexed reasoning, patches, progress, and plans", () => {
    let state = createTranscript(THREAD_ID);
    state = apply(
      state,
      frame(
        "item/agentMessage/delta",
        { threadId: THREAD_ID, turnId: TURN_ID, itemId: "agent", delta: "Hello " },
        1,
      ),
      frame(
        "item/agentMessage/delta",
        { threadId: THREAD_ID, turnId: TURN_ID, itemId: "agent", delta: "world" },
        2,
      ),
      frame(
        "item/reasoning/summaryTextDelta",
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "reasoning",
          summaryIndex: 1,
          delta: "Second",
        },
        3,
      ),
      frame(
        "item/reasoning/summaryTextDelta",
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "reasoning",
          summaryIndex: 0,
          delta: "First",
        },
        4,
      ),
      frame(
        "item/reasoning/textDelta",
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "reasoning",
          contentIndex: 0,
          delta: "Detailed thought",
        },
        5,
      ),
      frame(
        "item/fileChange/patchUpdated",
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "edit",
          changes: [{ path: "src/a.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }],
        },
        6,
      ),
      frame(
        "item/mcpToolCall/progress",
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "mcp",
          message: "Fetching page",
        },
        7,
      ),
      frame(
        "item/plan/delta",
        { threadId: THREAD_ID, turnId: TURN_ID, itemId: "plan", delta: "1. Inspect" },
        8,
      ),
      frame(
        "turn/plan/updated",
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          explanation: "Working plan",
          plan: [{ step: "Inspect", status: "completed" }],
        },
        9,
      ),
    );

    expect(item(state, "agent").text).toBe("Hello world");
    expect(item(state, "reasoning")).toMatchObject({
      summary: ["First", "Second"],
      content: ["Detailed thought"],
    });
    expect(item(state, "edit").diff).toContain("+new");
    expect(item(state, "mcp").progress).toEqual(["Fetching page"]);
    expect(item(state, "plan").text).toBe("1. Inspect");
    expect(item(state, "turn-plan:turn-a").plan).toEqual([
      { step: "Inspect", status: "completed" },
    ]);
  });

  test("classifies every current App-server thread item family", () => {
    const examples: Array<[Record<string, unknown>, TranscriptItem["family"]]> = [
      [{ type: "userMessage", id: "user", content: [] }, "user"],
      [{ type: "hookPrompt", id: "hook", fragments: [] }, "hook"],
      [{ type: "agentMessage", id: "agent", text: "" }, "agent"],
      [{ type: "plan", id: "plan", text: "" }, "plan"],
      [{ type: "reasoning", id: "reason", summary: [], content: [] }, "reasoning"],
      [{ type: "commandExecution", id: "command", command: "true" }, "command"],
      [{ type: "fileChange", id: "file", changes: [] }, "fileChange"],
      [{ type: "mcpToolCall", id: "mcp", server: "wiki", tool: "search" }, "tool"],
      [{ type: "dynamicToolCall", id: "dynamic", tool: "dispatch_worker" }, "tool"],
      [{ type: "collabAgentToolCall", id: "collab", tool: "spawnAgent" }, "collab"],
      [{ type: "subAgentActivity", id: "activity", kind: "started" }, "collab"],
      [{ type: "webSearch", id: "search", query: "Codex" }, "web"],
      [{ type: "imageView", id: "image", path: "/tmp/a.png" }, "media"],
      [{ type: "imageGeneration", id: "generate", status: "completed" }, "media"],
      [{ type: "sleep", id: "sleep", durationMs: 1_000 }, "wait"],
      [{ type: "enteredReviewMode", id: "review-in", review: "Review" }, "system"],
      [{ type: "exitedReviewMode", id: "review-out", review: "Review" }, "system"],
      [{ type: "contextCompaction", id: "compact" }, "system"],
    ];
    const state = hydrateTranscript(THREAD_ID, {
      id: THREAD_ID,
      turns: [
        {
          id: TURN_ID,
          status: "completed",
          items: examples.map(([value]) => value),
        },
      ],
    });

    expect(state.turns[0]?.items.map(({ type, family }) => [type, family])).toEqual(
      examples.map(([value, family]) => [String(value["type"]), family]),
    );
  });

  test("retains an unknown future item as a raw fallback", () => {
    const raw = {
      type: "futureToolThing",
      id: "future-a",
      payload: { untouched: [1, true, null] },
    };
    const state = hydrateTranscript(THREAD_ID, {
      id: THREAD_ID,
      turns: [{ id: TURN_ID, status: "completed", items: [raw] }],
    });

    expect(item(state, raw.id)).toMatchObject({
      type: "futureToolThing",
      family: "raw",
      raw,
    });
  });

  test("bounds frame de-duplication state for long-lived threads", () => {
    let state = createTranscript(THREAD_ID);
    for (let sequence = 1; sequence <= 2_100; sequence += 1) {
      state = applyTranscriptFrame(state, {
        ...frame("ignored", {}, sequence),
        payload: {},
      });
    }

    expect(state.appliedFrameSequences.size).toBe(2_048);
    expect(state.appliedFrameSequences.has(1)).toBe(false);
    expect(state.appliedFrameSequences.has(2_100)).toBe(true);
  });
});
