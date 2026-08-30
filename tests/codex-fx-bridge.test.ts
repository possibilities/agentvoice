import { describe, expect, test } from "bun:test";
import { CodexFxBridge } from "../src/codex-fx-bridge.ts";
import { EventJournal } from "../src/events.ts";
import type { FxAdmission, FxTurnResult } from "../src/fx-orchestrator.ts";

describe("Codex-Fx delegation bridge", () => {
  test("forwards one client handoff to Fx and appends progress plus result speech", async () => {
    const journal = new EventJournal();
    const appServer = new FakeAppServer();
    const orchestrator = new FakeOrchestrator(
      admission("41", "queued", null),
      turnResult("41", "Fixed the replay behavior and ran five tests."),
    );
    const bridge = new CodexFxBridge({
      appServer,
      threadId: "voice-thread",
      orchestrator,
      journal,
    });

    expect(
      bridge.handleNotification("thread/realtime/itemAdded", {
        threadId: "voice-thread",
        item: {
          type: "handoff_request",
          handoff_id: "handoff-1",
          item_id: "item-1",
          input_transcript: "Fix the replay bug.",
          active_transcript: [],
        },
      }),
    ).toBe(true);
    await bridge.drain();

    expect(orchestrator.requests).toEqual(["Fix the replay bug."]);
    expect(orchestrator.waited).toEqual(["41"]);
    expect(appServer.requests).toHaveLength(2);
    expect(appServer.requests[0]).toMatchObject({
      method: "thread/realtime/appendSpeech",
      params: { threadId: "voice-thread" },
    });
    expect(appServer.requests[1]?.params).toMatchObject({
      text: expect.stringContaining("Fixed the replay behavior"),
    });
    expect(journal.count("delegation.admitted")).toBe(1);
    expect(journal.count("delegation.completed")).toBe(1);
    expect(
      journal.snapshot().find((event) => event.type === "delegation.admitted")?.data,
    ).toMatchObject({ handoffId: "handoff-1", itemId: "item-1" });
    bridge.close();
    journal.close();
  });

  test("deduplicates handoffs and preserves semantic steering", async () => {
    const journal = new EventJournal();
    const appServer = new FakeAppServer();
    const orchestrator = new FakeOrchestrator(admission("52", "steering", "41"), null);
    const bridge = new CodexFxBridge({
      appServer,
      threadId: "voice-thread",
      orchestrator,
      journal,
    });
    const params = {
      threadId: "voice-thread",
      item: {
        type: "handoff_request",
        handoff_id: "handoff-steer",
        item_id: "item-steer",
        input_transcript: "Keep exact replay idempotent.",
      },
    };

    bridge.handleNotification("thread/realtime/itemAdded", params);
    bridge.handleNotification("thread/realtime/itemAdded", params);
    await bridge.drain();

    expect(orchestrator.requests).toEqual(["Keep exact replay idempotent."]);
    expect(orchestrator.waited).toEqual([]);
    expect(appServer.requests).toHaveLength(1);
    expect(journal.count("delegation.steered")).toBe(1);
    expect(journal.count("delegation.duplicate")).toBe(1);
    bridge.close();
    journal.close();
  });

  test("speaks admitted steering before a simultaneously completed turn result", async () => {
    const journal = new EventJournal();
    const appServer = new FakeAppServer();
    const orchestrator = new SteeringCompletionRaceOrchestrator();
    const bridge = new CodexFxBridge({
      appServer,
      threadId: "voice-thread",
      orchestrator,
      journal,
    });

    bridge.handleNotification("thread/realtime/itemAdded", handoff("work", "Implement it."));
    await orchestrator.turnWaitStarted;
    bridge.handleNotification(
      "thread/realtime/itemAdded",
      handoff("steer", "Preserve exact replay."),
    );
    await bridge.drain();

    expect(
      journal
        .snapshot()
        .filter((event) => event.type === "handoff.append.started")
        .map((event) => [event.data["handoffId"], event.data["phase"]]),
    ).toEqual([
      ["handoff-work", "progress"],
      ["handoff-steer", "progress"],
      ["handoff-work", "result"],
    ]);
    bridge.close();
    journal.close();
  });
});

class SteeringCompletionRaceOrchestrator {
  readonly turnWaitStarted: Promise<void>;
  private resolveTurnWaitStarted!: () => void;
  private resolveTurn!: (result: FxTurnResult) => void;
  private admissionCount = 0;

  constructor() {
    this.turnWaitStarted = new Promise((resolve) => {
      this.resolveTurnWaitStarted = resolve;
    });
  }

  async admit(): Promise<FxAdmission> {
    this.admissionCount++;
    if (this.admissionCount === 1) return admission("2", "queued", null);
    this.resolveTurn(turnResult("2", "Implemented exact replay and passed the tests."));
    return admission("steer-2", "steering", "2");
  }

  waitForTurn(): Promise<FxTurnResult> {
    this.resolveTurnWaitStarted();
    return new Promise((resolve) => {
      this.resolveTurn = resolve;
    });
  }
}

class FakeAppServer {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];

  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params: params as Record<string, unknown> });
    return {} as T;
  }
}

class FakeOrchestrator {
  readonly requests: string[] = [];
  readonly waited: string[] = [];

  constructor(
    private readonly nextAdmission: FxAdmission,
    private readonly result: FxTurnResult | null,
  ) {}

  async admit(text: string): Promise<FxAdmission> {
    this.requests.push(text);
    return this.nextAdmission;
  }

  async waitForTurn(turnId: string): Promise<FxTurnResult> {
    this.waited.push(turnId);
    if (!this.result) throw new Error("unexpected turn wait");
    return this.result;
  }
}

function handoff(id: string, transcript: string): Record<string, unknown> {
  return {
    threadId: "voice-thread",
    item: {
      type: "handoff_request",
      handoff_id: `handoff-${id}`,
      item_id: `item-${id}`,
      input_transcript: transcript,
    },
  };
}

function admission(
  turnId: string,
  disposition: "queued" | "steering",
  activeTurnId: string | null,
): FxAdmission {
  return {
    delegationTurnId: turnId,
    disposition,
    activeTurnId,
    snapshot: { active_turn_id: activeTurnId, queue_paused: false, queue: [] },
  };
}

function turnResult(turnId: string, assistantText: string): FxTurnResult {
  return {
    turnId,
    outcome: "completed",
    providerDisposition: "completed",
    assistantText,
    completedEvent: {
      schema_version: 1,
      sequence: 1,
      event: "PostTurnEnd",
      instance_id: "instance-1",
      context: {
        agent_role: "main",
        workspace_root: "/workspace",
        session_id: "session-1",
        parent_session_id: null,
        subagent_id: null,
        turn_id: Number(turnId),
        agent_state: "idle",
        attention_kind: null,
      },
      payload: { outcome: "completed", provider_disposition: "completed" },
    },
  };
}
