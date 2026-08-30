import type { EventRecord } from "./events.ts";

const OUTPUT_AUDIO_STARTED = "output.audio.started";
const OUTPUT_AUDIO_ENDED = new Set([
  "output.audio.finished",
  "output.audio.stopped",
  "output.audio.idle",
]);

export interface CodexRunValidationOptions {
  /** Defaults to the sole orchestrator.thread.started event in the trace. */
  rootThreadId?: string;
  /** Fixture play-step ID used for the mid-work steering utterance. */
  steerInputId?: string;
}

export interface CodexRunValidationResult {
  rootThreadId: string;
  rootTurnIds: [string, string, string];
  steerInputStartedSeq: number;
  thirdDelegationSeq: number;
  turnTwoCompletedSeq: number;
  outputAudioOverlap: "confirmed" | "not-observable";
}

export class CodexRunValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Codex run validation failed:\n- ${issues.join("\n- ")}`);
    this.name = "CodexRunValidationError";
    this.issues = issues;
  }
}

export interface LiveKitRunValidationResult {
  orchestratorTurnIds: [string, string, string];
  delegationCount: 4;
  steerInputStartedSeq: number;
  steeringDelegationSeq: number;
  steeringTargetTurnId: string;
  turnTwoCompletedSeq: number;
  outputAudioOverlap: "confirmed";
}

export class LiveKitRunValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`LiveKit run validation failed:\n- ${issues.join("\n- ")}`);
    this.name = "LiveKitRunValidationError";
    this.issues = issues;
  }
}

/**
 * Validates the event-shape invariants that make the compact Codex run a
 * genuine mid-work, full-duplex evaluation instead of merely a completed
 * conversation.
 *
 * Audio overlap is fail-closed once the trace exposes an output-audio end or
 * idle event. Older traces only contain output.audio.started, which cannot
 * establish how long speech remained active; those report `not-observable`.
 */
export function validateCodexRunEvents(
  snapshot: readonly EventRecord[],
  options: CodexRunValidationOptions = {},
): CodexRunValidationResult {
  const events = [...snapshot].sort((left, right) => left.seq - right.seq);
  const issues: string[] = [];
  const rootThreadId = options.rootThreadId ?? inferRootThreadId(events, issues);
  const steerInputId = options.steerInputId ?? "steer";

  if (!rootThreadId) throw new CodexRunValidationError(issues);

  const rootStarts = events.filter(
    (event) =>
      event.type === "orchestrator.turn.started" && event.data["threadId"] === rootThreadId,
  );
  if (rootStarts.length !== 3) {
    issues.push(
      `expected exactly 3 root orchestrator turn starts for ${rootThreadId}; observed ${rootStarts.length}`,
    );
  }

  const rootTurnIds = rootStarts.map((event, index) =>
    requiredString(event, "turnId", `root orchestrator turn ${index + 1}`, issues),
  );
  const turnTwoStarted = rootStarts[1];
  const turnTwoId = rootTurnIds[1];

  const steerStarts = events.filter(
    (event) => event.type === "input.audio.started" && event.data["id"] === steerInputId,
  );
  if (steerStarts.length !== 1) {
    issues.push(
      `expected exactly 1 input.audio.started event for ${JSON.stringify(steerInputId)}; observed ${steerStarts.length}`,
    );
  }
  const steerStarted = steerStarts[0];

  const delegations = events.filter((event) => event.type === "delegation.created");
  if (delegations.length !== 4) {
    issues.push(`expected exactly 4 delegations; observed ${delegations.length}`);
  }
  const thirdDelegation = delegations[2];

  const turnTwoCompletions = turnTwoId
    ? events.filter(
        (event) =>
          event.type === "orchestrator.turn.completed" &&
          event.data["threadId"] === rootThreadId &&
          event.data["turnId"] === turnTwoId,
      )
    : [];
  if (turnTwoId && turnTwoCompletions.length !== 1) {
    issues.push(
      `expected exactly 1 completion for root orchestrator turn 2 (${turnTwoId}); observed ${turnTwoCompletions.length}`,
    );
  }
  const turnTwoCompleted = turnTwoCompletions[0];

  if (turnTwoStarted && steerStarted && turnTwoStarted.seq >= steerStarted.seq) {
    issues.push(
      `steer input started at event ${steerStarted.seq}, before root turn 2 started at event ${turnTwoStarted.seq}`,
    );
  }
  if (steerStarted && thirdDelegation && steerStarted.seq >= thirdDelegation.seq) {
    issues.push(
      `delegation 3 occurred at event ${thirdDelegation.seq}, before steer input started at event ${steerStarted.seq}`,
    );
  }
  if (thirdDelegation && turnTwoCompleted && thirdDelegation.seq >= turnTwoCompleted.seq) {
    issues.push(
      `root turn 2 completed at event ${turnTwoCompleted.seq}, before delegation 3 at event ${thirdDelegation.seq}; steering became a later turn`,
    );
  }

  const outputAudioOverlap = validateOutputAudioOverlap(events, steerInputId, steerStarted, issues);

  if (issues.length > 0) throw new CodexRunValidationError(issues);
  if (
    !turnTwoStarted ||
    !steerStarted ||
    !thirdDelegation ||
    !turnTwoCompleted ||
    rootTurnIds.length !== 3 ||
    rootTurnIds.some((id) => id === null)
  ) {
    throw new CodexRunValidationError(["trace did not contain the required Codex run events"]);
  }

  return {
    rootThreadId,
    rootTurnIds: rootTurnIds as [string, string, string],
    steerInputStartedSeq: steerStarted.seq,
    thirdDelegationSeq: thirdDelegation.seq,
    turnTwoCompletedSeq: turnTwoCompleted.seq,
    outputAudioOverlap,
  };
}

/** Validates genuine three-turn Fx work with a semantic steer inside turn two. */
export function validateLiveKitRunEvents(
  snapshot: readonly EventRecord[],
  steerInputId = "steer",
): LiveKitRunValidationResult {
  const events = [...snapshot].sort((left, right) => left.seq - right.seq);
  const issues: string[] = [];
  const starts = events.filter((event) => event.type === "orchestrator.turn.started");
  if (starts.length !== 3) {
    issues.push(`expected exactly 3 Fx orchestrator turn starts; observed ${starts.length}`);
  }
  const turnIds = starts.map((event, index) =>
    requiredString(event, "turnId", `Fx orchestrator turn ${index + 1}`, issues),
  );
  if (new Set(turnIds.filter((turnId) => turnId !== null)).size !== turnIds.length) {
    issues.push("Fx orchestrator turn IDs were not unique");
  }

  for (const [index, turnId] of turnIds.entries()) {
    if (!turnId) continue;
    const completions = events.filter(
      (event) => event.type === "orchestrator.turn.completed" && event.data["turnId"] === turnId,
    );
    if (completions.length !== 1) {
      issues.push(
        `expected exactly 1 completion for Fx turn ${index + 1} (${turnId}); ` +
          `observed ${completions.length}`,
      );
    }
  }

  const delegations = events.filter((event) => event.type === "delegation.created");
  if (delegations.length !== 4) {
    issues.push(`expected exactly 4 LiveKit delegations; observed ${delegations.length}`);
  }
  for (const index of [0, 1, 3]) {
    const disposition = delegations[index]?.data["disposition"];
    if (delegations[index] && disposition !== "queued") {
      issues.push(`delegation ${index + 1} must be queued; observed ${String(disposition)}`);
    }
  }
  const steeringDelegation = delegations[2];
  if (steeringDelegation && steeringDelegation.data["disposition"] !== "steering") {
    issues.push(
      `delegation 3 must be semantic steering; observed ` +
        `${String(steeringDelegation.data["disposition"])}`,
    );
  }
  const turnTwoId = turnIds[1];
  const steeringTarget = steeringDelegation?.data["activeTurnId"];
  if (steeringDelegation && steeringTarget !== turnTwoId) {
    issues.push(
      `delegation 3 targeted ${String(steeringTarget)} instead of active Fx turn 2 ` +
        `${String(turnTwoId)}`,
    );
  }
  const steeringAdmissions = events.filter((event) => event.type === "delegation.steered");
  if (steeringAdmissions.length !== 1) {
    issues.push(
      `expected exactly 1 delegation.steered event; observed ${steeringAdmissions.length}`,
    );
  } else if (steeringAdmissions[0]?.data["activeTurnId"] !== turnTwoId) {
    issues.push("delegation.steered did not identify Fx turn 2 as its active target");
  }

  const steerStarts = events.filter(
    (event) => event.type === "input.audio.started" && event.data["id"] === steerInputId,
  );
  if (steerStarts.length !== 1) {
    issues.push(
      `expected exactly 1 input.audio.started event for ${JSON.stringify(steerInputId)}; ` +
        `observed ${steerStarts.length}`,
    );
  }
  const steerStarted = steerStarts[0];
  const turnTwoStarted = starts[1];
  const turnTwoCompleted = turnTwoId
    ? events.find(
        (event) =>
          event.type === "orchestrator.turn.completed" && event.data["turnId"] === turnTwoId,
      )
    : undefined;
  if (turnTwoStarted && steerStarted && turnTwoStarted.seq >= steerStarted.seq) {
    issues.push("steering audio began before Fx turn 2 started");
  }
  if (steerStarted && steeringDelegation && steerStarted.seq >= steeringDelegation.seq) {
    issues.push("steering delegation occurred before the steering audio began");
  }
  if (steeringDelegation && turnTwoCompleted && steeringDelegation.seq >= turnTwoCompleted.seq) {
    issues.push("steering was admitted after Fx turn 2 completed");
  }

  const outputAudioOverlap = validateOutputAudioOverlap(events, steerInputId, steerStarted, issues);
  if (outputAudioOverlap !== "confirmed") {
    issues.push("LiveKit output-audio overlap was not observable");
  }

  if (issues.length > 0) throw new LiveKitRunValidationError(issues);
  if (
    turnIds.length !== 3 ||
    turnIds.some((turnId) => turnId === null) ||
    !steerStarted ||
    !steeringDelegation ||
    typeof steeringTarget !== "string" ||
    !turnTwoCompleted
  ) {
    throw new LiveKitRunValidationError(["trace did not contain the required LiveKit run events"]);
  }
  return {
    orchestratorTurnIds: turnIds as [string, string, string],
    delegationCount: 4,
    steerInputStartedSeq: steerStarted.seq,
    steeringDelegationSeq: steeringDelegation.seq,
    steeringTargetTurnId: steeringTarget,
    turnTwoCompletedSeq: turnTwoCompleted.seq,
    outputAudioOverlap: "confirmed",
  };
}

function inferRootThreadId(events: readonly EventRecord[], issues: string[]): string | undefined {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type !== "orchestrator.thread.started") continue;
    const threadId = event.data["threadId"];
    if (typeof threadId === "string" && threadId.length > 0) ids.add(threadId);
  }
  if (ids.size !== 1) {
    issues.push(`expected exactly 1 root orchestrator thread ID; observed ${ids.size}`);
    return undefined;
  }
  return ids.values().next().value;
}

function requiredString(
  event: EventRecord,
  key: string,
  label: string,
  issues: string[],
): string | null {
  const value = event.data[key];
  if (typeof value === "string" && value.length > 0) return value;
  issues.push(`${label} at event ${event.seq} has no ${key}`);
  return null;
}

function validateOutputAudioOverlap(
  events: readonly EventRecord[],
  steerInputId: string,
  steerStarted: EventRecord | undefined,
  issues: string[],
): "confirmed" | "not-observable" {
  if (!events.some((event) => OUTPUT_AUDIO_ENDED.has(event.type))) return "not-observable";
  if (!steerStarted) return "confirmed";

  const steerFinished = events.find(
    (event) =>
      event.seq >= steerStarted.seq &&
      event.type === "input.audio.finished" &&
      event.data["id"] === steerInputId,
  );
  const steerEndSeq = steerFinished?.seq ?? steerStarted.seq;
  let outputActive = false;
  let overlap = false;

  for (const event of events) {
    if (event.type === OUTPUT_AUDIO_STARTED) outputActive = true;
    if (event.seq >= steerStarted.seq && event.seq <= steerEndSeq && outputActive) overlap = true;
    if (OUTPUT_AUDIO_ENDED.has(event.type)) outputActive = false;
  }

  if (!overlap) {
    issues.push(
      `steer input events ${steerStarted.seq}-${steerEndSeq} did not overlap active output audio`,
    );
  }
  return "confirmed";
}
