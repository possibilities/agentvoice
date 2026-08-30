import { describe, expect, test } from "bun:test";
import { llm } from "@livekit/agents";
import type { FxAdeEvent, FxAdmission, FxTurnResult } from "../src/fx-orchestrator.ts";
import {
  AgentVoiceRealtimeSession,
  createDelegateTool,
  FxDelegationController,
  openAIRealtimeChatContext,
  parseLiveKitAgentJobMetadata,
} from "../src/livekit-agent.ts";

describe("LiveKit Fx delegation controller", () => {
  test("binds job metadata to the assigned run and isolated workspace", () => {
    const serialized = JSON.stringify({
      schemaVersion: 1,
      runId: "run-1",
      workspace: "/tmp/agentvoice/workspace",
      orchestratorModel: "gpt-5.6-terra",
      reasoningEffort: "medium",
    });

    expect(
      parseLiveKitAgentJobMetadata(serialized, {
        runId: "run-1",
        workspace: "/tmp/agentvoice/workspace",
      }),
    ).toMatchObject({ runId: "run-1", workspace: "/tmp/agentvoice/workspace" });
    expect(() =>
      parseLiveKitAgentJobMetadata(serialized, {
        runId: "another-run",
        workspace: "/tmp/agentvoice/workspace",
      }),
    ).toThrow("run ID");
    expect(() =>
      parseLiveKitAgentJobMetadata(serialized, {
        runId: "run-1",
        workspace: "/tmp/another-workspace",
      }),
    ).toThrow("workspace");
  });

  test("turns an idle admission into a nonblocking update and final result", async () => {
    const order: string[] = [];
    const updates: Array<{ message: string; phase: "progress" | "result" }> = [];
    const telemetry = new FakeTelemetry(order);
    const orchestrator = new FakeOrchestrator(
      admission({ disposition: "queued", delegationTurnId: "41", activeTurnId: null }),
      turnResult("41", "Implemented the idempotent replay fix and ran five tests."),
      order,
    );
    const controller = new FxDelegationController(orchestrator, telemetry);

    const result = await controller.delegate("Fix the retry bug.", async (message, phase) => {
      order.push(`update:${phase}`);
      updates.push({ message, phase });
    });

    expect(order).toEqual([
      "admit",
      "telemetry:delegation.created",
      "update:progress",
      "wait:41",
      "telemetry:delegation.completed",
      "update:result",
    ]);
    expect(result).toBeUndefined();
    expect(updates).toHaveLength(2);
    expect(updates[0]?.phase).toBe("progress");
    expect(updates[1]?.phase).toBe("result");
    expect(updates[1]?.message).toContain("Implemented the idempotent replay fix");
    expect(updates[1]?.message).toContain("do not say the work is still running");
    expect(telemetry.events[0]).toMatchObject({
      type: "delegation.created",
      data: {
        text: "Fix the retry bug.",
        disposition: "queued",
        delegationTurnId: "41",
        activeTurnId: null,
      },
    });
  });

  test("acknowledges semantic steering immediately without duplicating the active turn wait", async () => {
    const order: string[] = [];
    const telemetry = new FakeTelemetry(order);
    const orchestrator = new FakeOrchestrator(
      admission({ disposition: "steering", delegationTurnId: "52", activeTurnId: "41" }),
      turnResult("41", "unused"),
      order,
    );
    const controller = new FxDelegationController(orchestrator, telemetry);

    const updates: Array<{ message: string; phase: "progress" | "result" }> = [];
    const result = await controller.delegate(
      "Exact replay must return the original.",
      async (message, phase) => {
        order.push(`update:${phase}`);
        updates.push({ message, phase });
      },
    );

    expect(order).toEqual([
      "admit",
      "telemetry:delegation.created",
      "update:progress",
      "telemetry:delegation.steered",
    ]);
    expect(result).toBeUndefined();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ phase: "progress" });
    expect(orchestrator.waitedTurnIds).toEqual([]);
  });

  test("adapts the completed result to an untemplated second LiveKit update", async () => {
    const order: string[] = [];
    const controller = new FxDelegationController(
      new FakeOrchestrator(
        admission({ disposition: "queued", delegationTurnId: "61", activeTurnId: "61" }),
        turnResult("61", "Completed with five passing tests."),
        order,
      ),
      new FakeTelemetry(order),
    );
    const tool = createDelegateTool(controller);
    const updates: Array<{ message: unknown; options?: { template?: string } }> = [];
    const execute = tool.execute as unknown as (
      args: { request: string },
      context: {
        ctx: {
          update(message: unknown, options?: { template?: string }): Promise<void>;
        };
      },
    ) => Promise<unknown>;

    const result = await execute(
      { request: "Finish and verify it." },
      {
        ctx: {
          async update(message, options) {
            updates.push({ message, ...(options ? { options } : {}) });
          },
        },
      },
    );

    expect(result).toBeUndefined();
    expect(updates).toHaveLength(2);
    expect(updates[0]?.options).toBeUndefined();
    expect(updates[1]).toMatchObject({
      message: expect.stringContaining("Completed with five passing tests."),
      options: { template: "{message}" },
    });
  });

  test("hands an asynchronous Fx failure back as a final result instead of dropping it", async () => {
    const order: string[] = [];
    const updates: Array<{ message: string; phase: "progress" | "result" }> = [];
    const controller = new FxDelegationController(
      new FakeOrchestrator(
        admission({ disposition: "queued", delegationTurnId: "71", activeTurnId: "71" }),
        {
          ...turnResult("71", "Tests failed."),
          outcome: "failed",
          providerDisposition: "failed",
        },
        order,
      ),
      new FakeTelemetry(order),
    );

    const result = await controller.delegate("Run the tests.", async (message, phase) => {
      order.push(`update:${phase}`);
      updates.push({ message, phase });
    });

    expect(result).toBeUndefined();
    expect(order).toEqual([
      "admit",
      "telemetry:delegation.created",
      "update:progress",
      "wait:71",
      "telemetry:delegation.failed",
      "update:result",
    ]);
    expect(updates[1]).toMatchObject({
      phase: "result",
      message: expect.stringContaining("Fx turn 71 ended failed"),
    });
  });

  test("filters config markers only at the OpenAI Realtime serialization boundary", async () => {
    const config = new llm.AgentConfigUpdate({
      instructions: "Stay concise.",
      createdAt: 2_000,
    });
    const message = llm.ChatMessage.create({
      role: "user",
      content: "Hello.",
      createdAt: 1_000,
    });
    const chatCtx = new llm.ChatContext([config, message]);
    const session = Object.create(TestableAgentVoiceRealtimeSession.prototype) as
      | TestableAgentVoiceRealtimeSession
      | undefined;
    if (!session) throw new Error("failed to construct test Realtime session");
    Object.defineProperty(session, "chatCtx", {
      configurable: true,
      get: () => llm.ChatContext.empty(),
    });

    const events = await session.serialize(chatCtx);

    expect(chatCtx.items.map((item) => item.type)).toEqual(["agent_config_update", "message"]);
    expect(
      llm
        .validateChatContextStructure(chatCtx)
        .issues.some((issue) => issue.code === "timestamp_order"),
    ).toBe(true);
    expect(
      llm
        .validateChatContextStructure(openAIRealtimeChatContext(chatCtx))
        .issues.some((issue) => issue.code === "timestamp_order"),
    ).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "conversation.item.create",
      item: { id: message.id, type: "message" },
    });
  });

  test("fails closed when Fx reports steering without an active target", async () => {
    const order: string[] = [];
    const controller = new FxDelegationController(
      new FakeOrchestrator(
        admission({ disposition: "steering", delegationTurnId: "52", activeTurnId: null }),
        turnResult("41", "unused"),
        order,
      ),
      new FakeTelemetry(order),
    );

    await expect(controller.delegate("Steer this.", async () => {})).rejects.toThrow(
      "without identifying the active turn",
    );
  });
});

class TestableAgentVoiceRealtimeSession extends AgentVoiceRealtimeSession {
  serialize(chatCtx: llm.ChatContext) {
    return this.createChatCtxUpdateEvents(chatCtx);
  }
}

class FakeOrchestrator {
  readonly waitedTurnIds: string[] = [];

  constructor(
    private readonly admissionResult: FxAdmission,
    private readonly result: FxTurnResult,
    private readonly order: string[],
  ) {}

  async admit(): Promise<FxAdmission> {
    this.order.push("admit");
    return this.admissionResult;
  }

  async waitForTurn(turnId: string): Promise<FxTurnResult> {
    this.order.push(`wait:${turnId}`);
    this.waitedTurnIds.push(turnId);
    return this.result;
  }
}

class FakeTelemetry {
  readonly events: Array<{
    source: "livekit" | "fx";
    type: string;
    data: Record<string, unknown>;
  }> = [];

  constructor(private readonly order: string[]) {}

  async emit(
    source: "livekit" | "fx",
    type: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    this.order.push(`telemetry:${type}`);
    this.events.push({ source, type, data });
  }
}

function admission(
  values: Pick<FxAdmission, "disposition" | "delegationTurnId" | "activeTurnId">,
): FxAdmission {
  return {
    ...values,
    snapshot: {
      active_turn_id: values.activeTurnId,
      queue_paused: false,
      queue: [],
    },
  };
}

function turnResult(turnId: string, assistantText: string): FxTurnResult {
  return {
    turnId,
    outcome: "completed",
    providerDisposition: "completed",
    assistantText,
    completedEvent: adeEvent(turnId),
  };
}

function adeEvent(turnId: string): FxAdeEvent {
  return {
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
  };
}
