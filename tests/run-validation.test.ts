import { describe, expect, test } from "bun:test";
import type { EventRecord, EventSource } from "../src/events.ts";
import { validateCodexRunEvents, validateLiveKitRunEvents } from "../src/run-validation.ts";

describe("validateCodexRunEvents", () => {
  test("accepts a three-turn run with mid-work, overlapping steering", () => {
    const result = validateCodexRunEvents(validTrace());

    expect(result).toMatchObject({
      rootThreadId: "root",
      rootTurnIds: ["turn-1", "turn-2", "turn-3"],
      steerInputStartedSeq: 9,
      thirdDelegationSeq: 11,
      turnTwoCompletedSeq: 13,
      outputAudioOverlap: "confirmed",
    });
  });

  test("rejects steering that arrives after turn 2 completed", () => {
    const events = validTrace();
    moveBefore(events, "orchestrator.turn.completed", 2, "input.audio.started", "steer");

    expect(() => validateCodexRunEvents(resequence(events))).toThrow(
      "steering became a later turn",
    );
  });

  test("ignores a foreign turn but rejects an extra root turn", () => {
    const withForeign = resequence([
      ...validTrace(),
      event("orchestrator.turn.started", { threadId: "foreign", turnId: "foreign-turn" }),
    ]);
    expect(validateCodexRunEvents(withForeign).rootTurnIds).toEqual(["turn-1", "turn-2", "turn-3"]);

    const withExtraRoot = resequence([
      ...validTrace(),
      event("orchestrator.turn.started", { threadId: "root", turnId: "turn-4" }),
    ]);
    expect(() => validateCodexRunEvents(withExtraRoot)).toThrow(
      "expected exactly 3 root orchestrator turn starts",
    );
  });

  test("rejects an extra delegation outside the four-turn scenario", () => {
    const events = resequence([...validTrace(), event("delegation.created")]);
    expect(() => validateCodexRunEvents(events)).toThrow("expected exactly 4 delegations");
  });

  test("rejects a trace whose observable output audio does not overlap steering", () => {
    const events = validTrace().filter(
      (item) => item.type !== "output.audio.started" && item.type !== "output.audio.finished",
    );
    const steerIndex = events.findIndex(
      (item) => item.type === "input.audio.started" && item.data["id"] === "steer",
    );
    events.splice(steerIndex, 0, event("output.audio.started"), event("output.audio.finished"));

    expect(() => validateCodexRunEvents(resequence(events))).toThrow(
      "did not overlap active output audio",
    );
  });

  test("reports overlap as unobservable when output has no end vocabulary", () => {
    const events = validTrace().filter((item) => item.type !== "output.audio.finished");
    expect(validateCodexRunEvents(resequence(events)).outputAudioOverlap).toBe("not-observable");
  });
});

describe("validateLiveKitRunEvents", () => {
  test("accepts exactly three Fx turns with a targeted in-flight steer", () => {
    expect(validateLiveKitRunEvents(validLiveKitTrace())).toMatchObject({
      orchestratorTurnIds: ["41", "42", "43"],
      delegationCount: 4,
      steeringTargetTurnId: "42",
      outputAudioOverlap: "confirmed",
    });
  });

  test("rejects cancel-and-follow-up or queued work presented as steering", () => {
    const events = validLiveKitTrace();
    const steering = events.find(
      (item) => item.type === "delegation.created" && item.data["disposition"] === "steering",
    );
    steering!.data["disposition"] = "queued";

    expect(() => validateLiveKitRunEvents(events)).toThrow(
      "delegation 3 must be semantic steering",
    );
  });

  test("rejects steering attributed to a turn other than active turn two", () => {
    const events = validLiveKitTrace();
    const steering = events.find(
      (item) => item.type === "delegation.created" && item.data["disposition"] === "steering",
    );
    steering!.data["activeTurnId"] = "later-turn";

    expect(() => validateLiveKitRunEvents(events)).toThrow("instead of active Fx turn 2");
  });

  test("rejects an extra Fx root turn", () => {
    const events = resequence([
      ...validLiveKitTrace(),
      event("orchestrator.turn.started", { turnId: "44" }),
    ]);
    expect(() => validateLiveKitRunEvents(events)).toThrow(
      "expected exactly 3 Fx orchestrator turn starts",
    );
  });
});

function validTrace(): EventRecord[] {
  return resequence([
    event("orchestrator.thread.started", { threadId: "root" }),
    event("orchestrator.turn.started", { threadId: "root", turnId: "turn-1" }),
    event("delegation.created"),
    event("orchestrator.turn.completed", { threadId: "root", turnId: "turn-1" }),
    event("delegation.created"),
    event("orchestrator.turn.started", { threadId: "root", turnId: "turn-2" }),
    event("output.audio.started"),
    event("scenario.step.started"),
    event("input.audio.started", { id: "steer" }),
    event("input.audio.finished", { id: "steer" }),
    event("delegation.created"),
    event("output.audio.finished"),
    event("orchestrator.turn.completed", { threadId: "root", turnId: "turn-2" }),
    event("orchestrator.turn.started", { threadId: "root", turnId: "turn-3" }),
    event("delegation.created"),
    event("orchestrator.turn.completed", { threadId: "root", turnId: "turn-3" }),
  ]);
}

function validLiveKitTrace(): EventRecord[] {
  return resequence([
    event("delegation.created", {
      delegationTurnId: "41",
      disposition: "queued",
      activeTurnId: null,
    }),
    event("orchestrator.turn.started", { turnId: "41" }),
    event("orchestrator.turn.completed", { turnId: "41" }),
    event("delegation.created", {
      delegationTurnId: "42",
      disposition: "queued",
      activeTurnId: null,
    }),
    event("orchestrator.turn.started", { turnId: "42" }),
    event("output.audio.started"),
    event("input.audio.started", { id: "steer" }),
    event("delegation.created", {
      delegationTurnId: "steer-1",
      disposition: "steering",
      activeTurnId: "42",
    }),
    event("delegation.steered", { delegationTurnId: "steer-1", activeTurnId: "42" }),
    event("input.audio.finished", { id: "steer" }),
    event("output.audio.stopped"),
    event("orchestrator.turn.completed", { turnId: "42" }),
    event("delegation.created", {
      delegationTurnId: "43",
      disposition: "queued",
      activeTurnId: null,
    }),
    event("orchestrator.turn.started", { turnId: "43" }),
    event("orchestrator.turn.completed", { turnId: "43" }),
  ]);
}

function event(type: string, data: Record<string, unknown> = {}): EventRecord {
  return { seq: 0, atMs: 0, source: sourceFor(type), type, data };
}

function resequence(events: readonly EventRecord[]): EventRecord[] {
  return events.map((item, index) => ({ ...item, seq: index + 1, atMs: index }));
}

function sourceFor(type: string): EventSource {
  if (type.startsWith("input.audio") || type.startsWith("output.audio")) return "media";
  if (type.startsWith("orchestrator")) return "app-server";
  if (type === "delegation.created") return "realtime";
  return "harness";
}

function moveBefore(
  events: EventRecord[],
  movingType: string,
  movingOccurrence: number,
  targetType: string,
  targetId: string,
): void {
  let seen = 0;
  const movingIndex = events.findIndex((item) => {
    if (item.type !== movingType) return false;
    seen++;
    return seen === movingOccurrence;
  });
  const [moving] = events.splice(movingIndex, 1);
  const targetIndex = events.findIndex(
    (item) => item.type === targetType && item.data["id"] === targetId,
  );
  events.splice(targetIndex, 0, moving!);
}
