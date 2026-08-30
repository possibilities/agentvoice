import { describe, expect, test } from "bun:test";
import type { EventRecord, EventSource } from "../src/events.ts";
import {
  validateCodexFxRunEvents,
  validateCodexRunEvents,
  validateLiveKitRunEvents,
} from "../src/run-validation.ts";

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

describe("validateCodexFxRunEvents", () => {
  test("accepts native voice with four Fx admissions, three turns, and no Codex work", () => {
    expect(validateCodexFxRunEvents(validCodexFxTrace(), "voice-thread")).toMatchObject({
      voiceThreadId: "voice-thread",
      codexWorkTurnCount: 0,
      orchestratorTurnIds: ["41", "42", "43"],
      delegationCount: 4,
      steeringTargetTurnId: "42",
      outputAudioOverlap: "confirmed",
    });
  });

  test("requires every native delegation to have a distinct Fx admission", () => {
    const events = validCodexFxTrace().filter(
      (item) => item.type !== "delegation.admitted" || item.data["delegationTurnId"] !== "43",
    );

    expect(() => validateCodexFxRunEvents(resequence(events), "voice-thread")).toThrow(
      "expected exactly 4 Codex-Fx admissions; observed 3",
    );
  });

  test("rejects any hidden Codex coding turn, including one on another thread", () => {
    const events = resequence([
      ...validCodexFxTrace(),
      event("appserver.turn/started", {
        threadId: "unexpected-internal-thread",
        turn: { id: "codex-turn" },
      }),
    ]);

    expect(() => validateCodexFxRunEvents(events, "voice-thread")).toThrow(
      "expected zero Codex work turn lifecycle events in the voice sidecar",
    );

    const completionOnly = resequence([
      ...validCodexFxTrace(),
      event("appserver.turn/completed", {
        threadId: "unexpected-internal-thread",
        turn: { id: "codex-turn" },
      }),
    ]);
    expect(() => validateCodexFxRunEvents(completionOnly, "voice-thread")).toThrow(
      "expected zero Codex work turn lifecycle events in the voice sidecar",
    );
  });

  test("binds the zero-turn proof to the recorded native voice thread", () => {
    expect(() => validateCodexFxRunEvents(validCodexFxTrace(), "made-up-thread")).toThrow(
      "expected exactly 1 voice thread start globally for made-up-thread",
    );
  });

  test("rejects an outbound Codex turn request even without lifecycle notifications", () => {
    const events = resequence([
      ...validCodexFxTrace(),
      event("appserver.rpc.out", { method: "turn/start", params: {} }, "app-server"),
    ]);
    expect(() => validateCodexFxRunEvents(events, "voice-thread")).toThrow(
      "expected zero outbound Codex turn/start requests",
    );
  });

  test("rejects failed Fx outcomes and delegation failures", () => {
    const events = validCodexFxTrace();
    for (const completion of events.filter((item) => item.type === "orchestrator.turn.completed")) {
      completion.data = { ...completion.data, status: "failed", outcome: "failed" };
    }
    events.push(event("delegation.failed", { delegationTurnId: "41" }));

    expect(() => validateCodexFxRunEvents(resequence(events), "voice-thread")).toThrow(
      "did not complete successfully",
    );
  });

  test("binds queued admissions and steering acknowledgments to their Fx turns", () => {
    const events = validCodexFxTrace();
    const admissions = events.filter((item) => item.type === "delegation.admitted");
    admissions[0]!.data["delegationTurnId"] = "unrelated-1";
    admissions[1]!.data["delegationTurnId"] = "unrelated-2";
    admissions[3]!.data["delegationTurnId"] = "unrelated-3";
    events.find((item) => item.type === "delegation.steered")!.data["delegationTurnId"] =
      "wrong-steer";

    expect(() => validateCodexFxRunEvents(events, "voice-thread")).toThrow("instead of Fx turn");
  });

  test("requires one ordered steering-audio finish", () => {
    const missing = validCodexFxTrace().filter(
      (item) => !(item.type === "input.audio.finished" && item.data["id"] === "steer"),
    );
    expect(() => validateCodexFxRunEvents(resequence(missing), "voice-thread")).toThrow(
      "expected exactly 1 input.audio.finished",
    );

    const duplicate = validCodexFxTrace();
    duplicate.push(
      event("input.audio.finished", { id: "steer", startSample: 1_000, endSample: 2_000 }),
    );
    expect(() => validateCodexFxRunEvents(resequence(duplicate), "voice-thread")).toThrow(
      "observed 2",
    );

    const reversed = validCodexFxTrace();
    const finishIndex = reversed.findIndex((item) => item.type === "input.audio.finished");
    const [finish] = reversed.splice(finishIndex, 1);
    const startIndex = reversed.findIndex((item) => item.type === "input.audio.started");
    reversed.splice(startIndex, 0, finish!);
    expect(() => validateCodexFxRunEvents(resequence(reversed), "voice-thread")).toThrow(
      "finished before it started",
    );
  });

  test("rejects an extra voice thread", () => {
    const events = validCodexFxTrace();
    events.push(event("voice.thread.started", { threadId: "other-thread" }));
    expect(() => validateCodexFxRunEvents(resequence(events), "voice-thread")).toThrow(
      "expected exactly 1 voice thread start globally",
    );
  });

  test("uses native voice order, not Fx admission order, for delegation semantics", () => {
    const events = validCodexFxTrace();
    const raw = events.filter((item) => item.type === "delegation.created");
    [raw[1]!.data, raw[2]!.data] = [raw[2]!.data, raw[1]!.data];
    expect(() => validateCodexFxRunEvents(events, "voice-thread")).toThrow(
      "delegation 2 must be queued",
    );
  });

  test("normalizes native delegation edge whitespace exactly as the bridge does", () => {
    const events = validCodexFxTrace();
    events.find((item) => item.type === "delegation.created")!.data["text"] = "  diagnose  ";
    expect(validateCodexFxRunEvents(events, "voice-thread").delegationCount).toBe(4);
  });

  test("rejects duplicate IDs, text drift, and stale PCM measurements", () => {
    const duplicate = validCodexFxTrace();
    const raw = duplicate.filter((item) => item.type === "delegation.created");
    raw[1]!.data["id"] = raw[0]!.data["id"];
    expect(() => validateCodexFxRunEvents(duplicate, "voice-thread")).toThrow("was duplicated");

    const textDrift = validCodexFxTrace();
    textDrift.find((item) => item.type === "delegation.admitted")!.data["text"] = "different";
    expect(() => validateCodexFxRunEvents(textDrift, "voice-thread")).toThrow("text did not match");

    const staleMeasurement = validCodexFxTrace();
    staleMeasurement.find((item) => item.type === "audio.overlap.measured")!.data[
      "inputStartSample"
    ] = 999;
    expect(() => validateCodexFxRunEvents(staleMeasurement, "voice-thread")).toThrow(
      "decoded-PCM overlap measurement",
    );

    const impossibleSpan = validCodexFxTrace();
    impossibleSpan.find((item) => item.type === "input.audio.finished")!.data["endSample"] = 1_001;
    impossibleSpan.find((item) => item.type === "audio.overlap.measured")!.data["inputEndSample"] =
      1_001;
    expect(() => validateCodexFxRunEvents(impossibleSpan, "voice-thread")).toThrow(
      "decoded-PCM overlap measurement",
    );

    const impossibleWindowCount = validCodexFxTrace();
    impossibleWindowCount.find((item) => item.type === "input.audio.finished")!.data["endSample"] =
      97_000;
    const impossibleMeasurement = impossibleWindowCount.find(
      (item) => item.type === "audio.overlap.measured",
    )!;
    impossibleMeasurement.data["inputEndSample"] = 97_000;
    impossibleMeasurement.data["overlappingWindowCount"] = 100;
    impossibleMeasurement.data["overlappingSampleCount"] = 1;
    impossibleMeasurement.data["overlapDurationMs"] = 1 / 48;
    expect(() => validateCodexFxRunEvents(impossibleWindowCount, "voice-thread")).toThrow(
      "decoded-PCM overlap measurement",
    );
  });

  test("requires Fx and bridge provenance plus complete media", () => {
    const wrongSource = validCodexFxTrace();
    wrongSource.find((item) => item.type === "orchestrator.turn.started")!.source = "app-server";
    wrongSource.find((item) => item.type === "delegation.completed")!.source = "harness";
    expect(() => validateCodexFxRunEvents(wrongSource, "voice-thread")).toThrow(
      "came from app-server, not fx",
    );

    for (const failureType of [
      "output.audio.decode-error",
      "input.audio.clock-reset",
      "output.audio.truncated",
      "realtime.non-json",
      "peer.failed",
    ]) {
      const corrupted = resequence([...validCodexFxTrace(), event(failureType)]);
      expect(() => validateCodexFxRunEvents(corrupted, "voice-thread")).toThrow(
        `expected zero ${failureType} events`,
      );
    }
  });

  test("requires completed Fx results to be appended back into native voice", () => {
    const events = validCodexFxTrace().filter(
      (item) =>
        !(
          item.type === "handoff.append.completed" &&
          item.data["handoffId"] === "handoff-2" &&
          item.data["phase"] === "result"
        ),
    );
    expect(() => validateCodexFxRunEvents(resequence(events), "voice-thread")).toThrow(
      "native handoff handoff-2 did not have one ordered result append",
    );
  });

  test("requires ordered delegation lifecycle and bijective ADE provenance", () => {
    const earlySteer = validCodexFxTrace();
    const steerIndex = earlySteer.findIndex((item) => item.type === "delegation.steered");
    const [steer] = earlySteer.splice(steerIndex, 1);
    const admissionIndex = earlySteer.findIndex(
      (item) => item.type === "delegation.admitted" && item.data["disposition"] === "steering",
    );
    earlySteer.splice(admissionIndex, 0, steer!);
    expect(() => validateCodexFxRunEvents(resequence(earlySteer), "voice-thread")).toThrow(
      "delegation.steered was recorded before its steering admission",
    );

    const earlyCompletion = validCodexFxTrace();
    const lifecycleIndex = earlyCompletion.findIndex(
      (item) => item.type === "delegation.completed" && item.data["turnId"] === "41",
    );
    const [lifecycle] = earlyCompletion.splice(lifecycleIndex, 1);
    const fxCompletionIndex = earlyCompletion.findIndex(
      (item) => item.type === "orchestrator.turn.completed" && item.data["turnId"] === "41",
    );
    earlyCompletion.splice(fxCompletionIndex, 0, lifecycle!);
    expect(() => validateCodexFxRunEvents(resequence(earlyCompletion), "voice-thread")).toThrow(
      "completed before Fx turn 41 completed",
    );

    const reusedAdeSequence = validCodexFxTrace();
    for (const item of reusedAdeSequence.filter(
      (event) => event.type.startsWith("fx.ade.") || event.type.startsWith("orchestrator.turn."),
    )) {
      item.data["adeSequence"] = 1;
    }
    expect(() => validateCodexFxRunEvents(reusedAdeSequence, "voice-thread")).toThrow(
      "Fx ADE sequence did not increase",
    );
  });

  test("attests exact native V3 and Fx identities", () => {
    const wrongFx = validCodexFxTrace();
    wrongFx.find((item) => item.type === "fx.identity")!.data["model"] = "different";
    expect(() => validateCodexFxRunEvents(wrongFx, "voice-thread")).toThrow(
      "exact authenticated Fx identity",
    );

    const wrongVoice = validCodexFxTrace();
    wrongVoice.find((item) => item.type === "voice.session.started")!.source = "app-server";
    expect(() => validateCodexFxRunEvents(wrongVoice, "voice-thread")).toThrow(
      "native voice model session",
    );

    const wrongStart = validCodexFxTrace();
    const start = wrongStart.find(
      (item) =>
        item.type === "appserver.rpc.out" && item.data["method"] === "thread/realtime/start",
    )!;
    (start.data["params"] as Record<string, unknown>)["clientManagedHandoffs"] = false;
    expect(() => validateCodexFxRunEvents(wrongStart, "voice-thread")).toThrow(
      "exact client-managed native V3 start request",
    );
  });

  test("rejects orphan and reversed Fx completions", () => {
    const orphan = validCodexFxTrace();
    orphan.push(
      event("orchestrator.turn.completed", {
        turnId: "orphan",
        status: "completed",
        outcome: "completed",
        error: null,
      }),
    );
    expect(() => validateCodexFxRunEvents(resequence(orphan), "voice-thread")).toThrow(
      "had no matching turn start",
    );

    const reversed = validCodexFxTrace();
    const completionIndex = reversed.findIndex(
      (item) => item.type === "orchestrator.turn.completed" && item.data["turnId"] === "41",
    );
    const [completion] = reversed.splice(completionIndex, 1);
    const startIndex = reversed.findIndex(
      (item) => item.type === "orchestrator.turn.started" && item.data["turnId"] === "41",
    );
    reversed.splice(startIndex, 0, completion!);
    expect(() => validateCodexFxRunEvents(resequence(reversed), "voice-thread")).toThrow(
      "completed before it started",
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
    event(
      "delegation.created",
      { delegationTurnId: "41", disposition: "queued", activeTurnId: null },
      "livekit",
    ),
    ...fxTurnStarted("41", 1),
    ...fxTurnCompleted("41", 3),
    event(
      "delegation.completed",
      { delegationTurnId: "41", turnId: "41", outcome: "completed" },
      "livekit",
    ),
    event(
      "delegation.created",
      { delegationTurnId: "42", disposition: "queued", activeTurnId: null },
      "livekit",
    ),
    ...fxTurnStarted("42", 4),
    event("output.audio.started"),
    event("input.audio.started", { id: "steer", startSample: 1_000 }),
    event(
      "delegation.created",
      { delegationTurnId: "steer-1", disposition: "steering", activeTurnId: "42" },
      "livekit",
    ),
    event("delegation.steered", { delegationTurnId: "steer-1", activeTurnId: "42" }, "livekit"),
    event("input.audio.finished", { id: "steer", startSample: 1_000, endSample: 2_000 }),
    event("output.audio.stopped"),
    ...fxTurnCompleted("42", 6),
    event(
      "delegation.completed",
      { delegationTurnId: "42", turnId: "42", outcome: "completed" },
      "livekit",
    ),
    event(
      "delegation.created",
      { delegationTurnId: "43", disposition: "queued", activeTurnId: null },
      "livekit",
    ),
    ...fxTurnStarted("43", 7),
    ...fxTurnCompleted("43", 9),
    event(
      "delegation.completed",
      { delegationTurnId: "43", turnId: "43", outcome: "completed" },
      "livekit",
    ),
  ]);
}

function validCodexFxTrace(): EventRecord[] {
  return resequence([
    event(
      "fx.identity",
      {
        auth: "Codex subscription",
        modelSource: "Codex subscription",
        permissionMode: "yolo",
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
      },
      "fx",
    ),
    event("voice.thread.started", { threadId: "voice-thread" }),
    event(
      "appserver.rpc.out",
      {
        method: "thread/realtime/start",
        params: {
          threadId: "voice-thread",
          version: "v3",
          voice: "cove",
          outputModality: "audio",
          clientManagedHandoffs: true,
          delegationAckFiller: false,
        },
      },
      "app-server",
    ),
    event(
      "voice.session.started",
      { rawType: "session.started", model: null, voice: null },
      "realtime",
    ),
    event("delegation.created", { id: "raw-1", target: "client", text: "diagnose" }),
    forwarded("raw-1", "handoff-1", "diagnose"),
    admitted("raw-1", "handoff-1", "diagnose", "41", "queued", null),
    ...fxTurnStarted("41", 1),
    ...handoffAppend("handoff-1", "progress"),
    ...fxTurnCompleted("41", 3),
    event(
      "delegation.completed",
      { delegationTurnId: "41", turnId: "41", outcome: "completed" },
      "bridge",
    ),
    ...handoffAppend("handoff-1", "result"),
    event("delegation.created", { id: "raw-2", target: "client", text: "implement" }),
    forwarded("raw-2", "handoff-2", "implement"),
    admitted("raw-2", "handoff-2", "implement", "42", "queued", null),
    ...fxTurnStarted("42", 4),
    ...handoffAppend("handoff-2", "progress"),
    event("output.audio.started"),
    event("input.audio.started", { id: "steer", startSample: 1_000 }),
    event("delegation.created", { id: "raw-3", target: "client", text: "steer" }),
    forwarded("raw-3", "handoff-3", "steer"),
    admitted("raw-3", "handoff-3", "steer", "steer-1", "steering", "42"),
    ...handoffAppend("handoff-3", "progress"),
    event("delegation.steered", { delegationTurnId: "steer-1", activeTurnId: "42" }),
    event("input.audio.finished", { id: "steer", startSample: 1_000, endSample: 2_000 }),
    event("output.audio.idle"),
    ...fxTurnCompleted("42", 6),
    event(
      "delegation.completed",
      { delegationTurnId: "42", turnId: "42", outcome: "completed" },
      "bridge",
    ),
    ...handoffAppend("handoff-2", "result"),
    event("delegation.created", { id: "raw-4", target: "client", text: "verify" }),
    forwarded("raw-4", "handoff-4", "verify"),
    admitted("raw-4", "handoff-4", "verify", "43", "queued", null),
    ...fxTurnStarted("43", 7),
    ...handoffAppend("handoff-4", "progress"),
    ...fxTurnCompleted("43", 9),
    event(
      "delegation.completed",
      { delegationTurnId: "43", turnId: "43", outcome: "completed" },
      "bridge",
    ),
    ...handoffAppend("handoff-4", "result"),
    event("scenario.completed"),
    event("bridge.closed", {}, "bridge"),
    event("session.closed"),
    event("audio.overlap.measured", {
      inputId: "steer",
      sampleRate: 48_000,
      windowSamples: 960,
      resolutionSamples: 48,
      inputStartSample: 1_000,
      inputEndSample: 2_000,
      overlappingWindowCount: 1,
      overlappingSampleCount: 960,
      overlapDurationMs: 20,
    }),
    event("fx.stopped", {}, "fx"),
  ]);
}

function event(
  type: string,
  data: Record<string, unknown> = {},
  source: EventSource = sourceFor(type),
): EventRecord {
  return { seq: 0, atMs: 0, source, type, data };
}

function fxTurnStarted(turnId: string, adeSequence: number): EventRecord[] {
  return [
    event(
      "fx.ade.turnstarted",
      {
        adeSequence,
        event: "TurnStarted",
        context: { agent_role: "main", turn_id: Number(turnId) },
        payload: {},
      },
      "fx",
    ),
    event("orchestrator.turn.started", { turnId, status: "inProgress", adeSequence }, "fx"),
  ];
}

function fxTurnCompleted(turnId: string, adeSequence: number): EventRecord[] {
  return [
    event(
      "fx.ade.postturnend",
      {
        adeSequence,
        event: "PostTurnEnd",
        context: { agent_role: "main", turn_id: Number(turnId) },
        payload: { outcome: "completed", provider_disposition: "completed" },
      },
      "fx",
    ),
    event(
      "orchestrator.turn.completed",
      {
        turnId,
        status: "completed",
        outcome: "completed",
        error: null,
        adeSequence,
      },
      "fx",
    ),
  ];
}

function forwarded(itemId: string, handoffId: string, text: string): EventRecord {
  return event("delegation.forwarded", { itemId, handoffId, text }, "bridge");
}

function admitted(
  itemId: string,
  handoffId: string,
  text: string,
  delegationTurnId: string,
  disposition: "queued" | "steering",
  activeTurnId: string | null,
): EventRecord {
  return event(
    "delegation.admitted",
    { itemId, handoffId, text, delegationTurnId, disposition, activeTurnId },
    "bridge",
  );
}

function handoffAppend(handoffId: string, phase: "progress" | "result"): EventRecord[] {
  return [
    event("handoff.append.started", { handoffId, phase, text: `${phase} text` }, "bridge"),
    event("handoff.append.completed", { handoffId, phase }, "bridge"),
  ];
}

function resequence(events: readonly EventRecord[]): EventRecord[] {
  return events.map((item, index) => ({ ...item, seq: index + 1, atMs: index }));
}

function sourceFor(type: string): EventSource {
  if (
    type.startsWith("input.audio") ||
    type.startsWith("output.audio") ||
    type.startsWith("audio.")
  ) {
    return "media";
  }
  if (type.startsWith("orchestrator")) return "app-server";
  if (type.startsWith("appserver.") || type === "voice.thread.started") return "app-server";
  if (type.startsWith("delegation.admitted") || type.startsWith("delegation.steered")) {
    return "bridge";
  }
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
