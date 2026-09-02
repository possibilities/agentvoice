import { describe, expect, test } from "bun:test";
import { adeLifecycleEvents, type FxAdeEvent } from "../src/fx-orchestrator.ts";
import { LifecycleEmitter } from "../src/orchestrator-adapter.ts";

function adeEvent(
  event: string,
  context: Partial<FxAdeEvent["context"]> = {},
  sequence = 1,
): FxAdeEvent {
  return {
    schema_version: 1,
    sequence,
    event,
    instance_id: "agentvoice-test",
    context: {
      agent_role: "main",
      workspace_root: "/tmp/workspace",
      session_id: "session-1",
      parent_session_id: null,
      subagent_id: null,
      turn_id: 4,
      agent_state: "working",
      attention_kind: null,
      ...context,
    },
    payload: { marker: event },
  };
}

describe("ADE to adapter lifecycle projection", () => {
  test("projects the four lifecycle events with their turn id", () => {
    expect(adeLifecycleEvents(adeEvent("FxStarted", { agent_state: "idle" }), "idle")).toEqual([
      {
        type: "orchestrator.started",
        turnId: "4",
        agentState: "idle",
        attentionKind: null,
        data: { marker: "FxStarted" },
      },
    ]);
    expect(adeLifecycleEvents(adeEvent("TurnStarted"), "idle").map((e) => e.type)).toEqual([
      "turn.started",
    ]);
    expect(
      adeLifecycleEvents(adeEvent("PostTurnEnd", { agent_state: "idle" }), "working").map(
        (e) => e.type,
      ),
    ).toEqual(["turn.ended"]);
    expect(
      adeLifecycleEvents(adeEvent("Stop", { agent_state: "idle", turn_id: null }), "idle"),
    ).toEqual([
      {
        type: "orchestrator.stopped",
        turnId: null,
        agentState: "idle",
        attentionKind: null,
        data: { marker: "Stop" },
      },
    ]);
  });

  test("derives attention from the blocked-state transition", () => {
    const raised = adeLifecycleEvents(
      adeEvent("PermissionRequested", { agent_state: "blocked", attention_kind: "permission" }),
      "working",
    );
    expect(raised).toEqual([
      {
        type: "attention.raised",
        turnId: "4",
        agentState: "blocked",
        attentionKind: "permission",
        data: { event: "PermissionRequested" },
      },
    ]);
    const stillBlocked = adeLifecycleEvents(
      adeEvent("Heartbeat", { agent_state: "blocked", attention_kind: "permission" }),
      "blocked",
    );
    expect(stillBlocked).toEqual([]);
    const cleared = adeLifecycleEvents(adeEvent("PostTurnEnd", { agent_state: "idle" }), "blocked");
    expect(cleared.map((e) => e.type)).toEqual(["turn.ended", "attention.cleared"]);
  });

  test("ignores subagent events", () => {
    expect(
      adeLifecycleEvents(
        adeEvent("TurnStarted", { agent_role: "subagent", subagent_id: 2 }),
        "idle",
      ),
    ).toEqual([]);
  });
});

describe("lifecycle emitter", () => {
  test("numbers events monotonically and fans them out until unsubscribed", () => {
    const emitter = new LifecycleEmitter();
    const seen: number[] = [];
    const unsubscribe = emitter.subscribe((event) => seen.push(event.sequence));
    emitter.emit({
      type: "turn.started",
      turnId: "1",
      agentState: "working",
      attentionKind: null,
      data: {},
    });
    unsubscribe();
    emitter.emit({
      type: "turn.ended",
      turnId: "1",
      agentState: "idle",
      attentionKind: null,
      data: {},
    });
    expect(seen).toEqual([1]);
    expect(emitter.snapshot().map((event) => event.sequence)).toEqual([1, 2]);
  });
});
