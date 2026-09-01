import { createHash } from "node:crypto";
import { NATIVE_SIDECAR_SANDBOX_PROFILE } from "./app-server.ts";
import {
  AUDIBLE_OVERLAP_RESOLUTION_SAMPLES,
  AUDIO_FRAME_SAMPLES,
  AUDIO_SAMPLE_RATE,
} from "./audio.ts";
import type { EventRecord, EventSource } from "./events.ts";
import type { FxCredentialBrokerProofMode } from "./fx-orchestrator.ts";
import { CODEX_REFERENCE } from "./reference.ts";
import { assertConsumedWireContract, wireMessagesFromEvents } from "./voice-sidecar-contract.ts";

const OUTPUT_AUDIO_STARTED = "output.audio.started";
const OUTPUT_AUDIO_ENDED = new Set([
  "output.audio.finished",
  "output.audio.stopped",
  "output.audio.idle",
]);
export const FX_CREDENTIAL_AUTHORITY_LIFECYCLE_EVENT =
  "appserver.voiceSidecarAuthority/leaseAccepted";
const CREDENTIAL_LEASE_MINIMUM_VALIDITY_MS = 300_000;
const ACCOUNT_DIGEST_PATTERN = /^[a-f0-9]{32}$/;
const DECIMAL_GENERATION_PATTERN = /^[1-9][0-9]*$/;
const CREDENTIAL_AUTHORITY_LIFECYCLE_FIELDS = [
  "schemaVersion",
  "operation",
  "reason",
  "provider",
  "accountDigest",
  "generation",
  "count",
  "refreshDeadlineMs",
  "remainingValidityMs",
] as const;

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

export interface CodexFxRunValidationResult extends LiveKitRunValidationResult {
  voiceThreadId: string;
  implementationProfile: CodexFxImplementationProfile;
  codexWorkTurnCount: 0;
  pcmOverlapDurationMs: number;
  credentialAuthorityLifecycle?: FxCredentialAuthorityLifecycleValidation;
}

export interface FxCredentialAuthorityLifecycleValidation {
  proofMode: FxCredentialBrokerProofMode;
  lifecycleEvent: typeof FX_CREDENTIAL_AUTHORITY_LIFECYCLE_EVENT;
  resolveAcceptedSeq: number;
  refreshAcceptedSeq: number | null;
  accountDigest: string;
  resolveGeneration: string;
  refreshGeneration: string | null;
  completedFxTurnAfterRenewalSeq: number | null;
  completedFxTurnAfterRenewalId: string | null;
}

export class CodexFxRunValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Codex-Fx run validation failed:\n- ${issues.join("\n- ")}`);
    this.name = "CodexFxRunValidationError";
    this.issues = issues;
  }
}

export type CodexFxImplementationProfile = "legacy-app-server" | "native-voice-sidecar";

export interface CodexFxRunValidationOptions {
  steerInputId?: string;
  implementationProfile?: CodexFxImplementationProfile;
  credentialAuthorityProofMode?: FxCredentialBrokerProofMode;
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
  return validateFxRunEvents(snapshot, steerInputId, {
    label: "LiveKit",
    delegationType: "delegation.created",
    admissionType: "delegation.created",
    delegationSource: "livekit",
    admissionSource: "livekit",
    delegationLifecycleSource: "livekit",
    fail: (issues) => new LiveKitRunValidationError(issues),
  });
}

/** Validates the Codex native voice sidecar while proving Codex did no coding work. */
export function validateCodexFxRunEvents(
  snapshot: readonly EventRecord[],
  voiceThreadId: string,
  optionsOrSteerInputId: string | CodexFxRunValidationOptions = {},
): CodexFxRunValidationResult {
  const options =
    typeof optionsOrSteerInputId === "string"
      ? { steerInputId: optionsOrSteerInputId }
      : optionsOrSteerInputId;
  const steerInputId = options.steerInputId ?? "steer";
  const implementationProfile = options.implementationProfile ?? "legacy-app-server";
  const base = validateFxRunEvents(snapshot, steerInputId, {
    label: "Codex-Fx",
    delegationType: "delegation.created",
    admissionType: "delegation.admitted",
    delegationSource: "realtime",
    admissionSource: "bridge",
    delegationLifecycleSource: "bridge",
    correlateNativeDelegations: true,
    fail: (issues) => new CodexFxRunValidationError(issues),
  });
  const issues: string[] = [];
  const credentialAuthorityLifecycle = options.credentialAuthorityProofMode
    ? validateFxCredentialAuthorityLifecycleInto(
        snapshot,
        options.credentialAuthorityProofMode,
        issues,
      )
    : null;
  const voiceThreadStarts = snapshot.filter((event) => event.type === "voice.thread.started");
  requireEventSource(voiceThreadStarts, "app-server", "native voice thread start", issues);
  if (voiceThreadStarts.length !== 1 || voiceThreadStarts[0]?.data["threadId"] !== voiceThreadId) {
    issues.push(
      `expected exactly 1 voice thread start globally for ${voiceThreadId}; observed ` +
        `${voiceThreadStarts.length} (${voiceThreadStarts
          .map((event) => String(event.data["threadId"]))
          .join(", ")})`,
    );
  }

  // Fail closed across the entire sidecar, not just the expected voice thread.
  // Otherwise a bad thread ID could make an internal Codex coding turn disappear
  // from the proof while it still consumed subscription inference.
  const codexTurnEvents = snapshot.filter(
    (event) => event.type === "appserver.turn/started" || event.type === "appserver.turn/completed",
  );
  if (codexTurnEvents.length > 0) {
    const threadIds = [
      ...new Set(
        codexTurnEvents.map((event) =>
          typeof event.data["threadId"] === "string" ? event.data["threadId"] : "unknown",
        ),
      ),
    ];
    issues.push(
      `expected zero Codex work turn lifecycle events in the voice sidecar; observed ` +
        `${codexTurnEvents.length} ` +
        `across thread(s) ${threadIds.join(", ")}`,
    );
  }
  const codexTurnRequests = snapshot.filter(
    (event) => event.type === "appserver.rpc.out" && event.data["method"] === "turn/start",
  );
  if (codexTurnRequests.length > 0) {
    issues.push(
      `expected zero outbound Codex turn/start requests; observed ${codexTurnRequests.length}`,
    );
  }

  for (const type of [
    "bridge.failed",
    "bridge.drain-error",
    "fx.ade.protocol-error",
    "fx.stop.error",
    "session.stop-error",
    "voice.error",
    "output.audio.decode-error",
    "input.audio.clock-reset",
    "output.audio.truncated",
    "realtime.non-json",
    "peer.failed",
  ]) {
    const failures = snapshot.filter((event) => event.type === type);
    if (failures.length > 0) {
      issues.push(`expected zero ${type} events; observed ${failures.length}`);
    }
  }
  const scenarioCompleted = snapshot.find((event) => event.type === "scenario.completed");
  const scenarioCompletions = snapshot.filter((event) => event.type === "scenario.completed");
  requireEventSource(scenarioCompletions, "harness", "scenario completion", issues);
  if (scenarioCompletions.length !== 1) {
    issues.push(
      `expected exactly 1 scenario.completed event; observed ${scenarioCompletions.length}`,
    );
  }
  const sessionClosed = snapshot.filter((event) => event.type === "session.closed");
  requireEventSource(sessionClosed, "harness", "voice session close", issues);
  if (
    sessionClosed.length !== 1 ||
    (scenarioCompleted && sessionClosed[0]!.seq <= scenarioCompleted.seq)
  ) {
    issues.push("voice session was not closed exactly once after scenario completion");
  }
  const bridgeClosed = snapshot.filter((event) => event.type === "bridge.closed");
  requireEventSource(bridgeClosed, "bridge", "Codex-Fx bridge close", issues);
  if (
    bridgeClosed.length !== 1 ||
    (scenarioCompleted && bridgeClosed[0]!.seq <= scenarioCompleted.seq) ||
    (sessionClosed[0] && bridgeClosed[0] && bridgeClosed[0].seq >= sessionClosed[0].seq)
  ) {
    issues.push(
      "Codex-Fx bridge was not closed once between scenario completion and voice teardown",
    );
  }
  const fxStopped = snapshot.filter((event) => event.type === "fx.stopped");
  requireEventSource(fxStopped, "fx", "Fx stop", issues);
  if (fxStopped.length !== 1 || (sessionClosed[0] && fxStopped[0]!.seq <= sessionClosed[0].seq)) {
    issues.push("Fx was not stopped exactly once after voice teardown");
  }
  validateCodexFxIdentityEvidence(snapshot, voiceThreadId, issues);
  if (implementationProfile === "native-voice-sidecar") {
    validateNativeVoiceSidecarEvidence(snapshot, issues);
  }
  for (const type of ["peer.disconnected", "peer.closed"]) {
    const premature = snapshot.filter(
      (event) => event.type === type && (!scenarioCompleted || event.seq < scenarioCompleted.seq),
    );
    if (premature.length > 0) {
      issues.push(`expected zero premature ${type} events; observed ${premature.length}`);
    }
  }
  validateCodexFxBridgeEvidence(snapshot, issues);

  const overlapMeasurements = snapshot.filter(
    (event) => event.type === "audio.overlap.measured" && event.data["inputId"] === steerInputId,
  );
  const measurement = overlapMeasurements[0];
  const pcmOverlapDurationMs = measurement?.data["overlapDurationMs"];
  const steerStart = snapshot.find(
    (event) => event.type === "input.audio.started" && event.data["id"] === steerInputId,
  );
  const steerFinish = snapshot.find(
    (event) => event.type === "input.audio.finished" && event.data["id"] === steerInputId,
  );
  const overlappingWindowCount = measurement?.data["overlappingWindowCount"];
  const overlappingSampleCount = measurement?.data["overlappingSampleCount"];
  const inputStartSample = steerStart?.data["startSample"];
  const finishStartSample = steerFinish?.data["startSample"];
  const inputEndSample = steerFinish?.data["endSample"];
  const inputSpanSamples =
    Number.isInteger(inputStartSample) &&
    (inputStartSample as number) >= 0 &&
    finishStartSample === inputStartSample &&
    Number.isInteger(inputEndSample) &&
    (inputEndSample as number) > (inputStartSample as number)
      ? (inputEndSample as number) - (inputStartSample as number)
      : null;
  if (
    overlapMeasurements.length !== 1 ||
    measurement?.source !== "media" ||
    (measurement?.seq ?? Number.NEGATIVE_INFINITY) <=
      (steerFinish?.seq ?? Number.POSITIVE_INFINITY) ||
    measurement.data["sampleRate"] !== AUDIO_SAMPLE_RATE ||
    measurement.data["windowSamples"] !== AUDIO_FRAME_SAMPLES ||
    measurement.data["resolutionSamples"] !== AUDIBLE_OVERLAP_RESOLUTION_SAMPLES ||
    measurement.data["inputStartSample"] !== inputStartSample ||
    measurement.data["inputStartSample"] !== finishStartSample ||
    measurement.data["inputEndSample"] !== inputEndSample ||
    inputSpanSamples === null ||
    typeof overlappingWindowCount !== "number" ||
    !Number.isInteger(overlappingWindowCount) ||
    overlappingWindowCount <= 0 ||
    typeof overlappingSampleCount !== "number" ||
    !Number.isInteger(overlappingSampleCount) ||
    overlappingSampleCount <= 0 ||
    overlappingSampleCount > inputSpanSamples ||
    overlappingSampleCount > overlappingWindowCount * AUDIO_FRAME_SAMPLES ||
    overlappingWindowCount > Math.ceil(inputSpanSamples / AUDIO_FRAME_SAMPLES) ||
    overlappingSampleCount <
      (overlappingWindowCount - 1) * AUDIBLE_OVERLAP_RESOLUTION_SAMPLES + 1 ||
    !validResolutionRemainder(overlappingSampleCount, inputSpanSamples) ||
    typeof pcmOverlapDurationMs !== "number" ||
    !Number.isFinite(pcmOverlapDurationMs) ||
    pcmOverlapDurationMs <= 0 ||
    Math.abs(pcmOverlapDurationMs - (overlappingSampleCount / AUDIO_SAMPLE_RATE) * 1_000) > 1e-6
  ) {
    issues.push(
      `expected exactly 1 positive decoded-PCM overlap measurement for ${steerInputId}; ` +
        `observed ${overlapMeasurements.length} with duration ${String(pcmOverlapDurationMs)}`,
    );
  }
  if (issues.length > 0) throw new CodexFxRunValidationError(issues);
  return {
    ...base,
    voiceThreadId,
    implementationProfile,
    codexWorkTurnCount: 0,
    pcmOverlapDurationMs: pcmOverlapDurationMs as number,
    ...(credentialAuthorityLifecycle ? { credentialAuthorityLifecycle } : {}),
  };
}

export function validateFxCredentialAuthorityLifecycle(
  snapshot: readonly EventRecord[],
  proofMode: FxCredentialBrokerProofMode,
): FxCredentialAuthorityLifecycleValidation {
  const issues: string[] = [];
  const validation = validateFxCredentialAuthorityLifecycleInto(snapshot, proofMode, issues);
  if (issues.length > 0 || !validation) throw new CodexFxRunValidationError(issues);
  return validation;
}

function validateFxCredentialAuthorityLifecycleInto(
  snapshot: readonly EventRecord[],
  proofMode: FxCredentialBrokerProofMode,
  issues: string[],
): FxCredentialAuthorityLifecycleValidation | null {
  const events = [...snapshot].sort((left, right) => left.seq - right.seq);
  const accepted = events.filter((event) => event.type === FX_CREDENTIAL_AUTHORITY_LIFECYCLE_EVENT);
  requireEventSource(accepted, "app-server", "Fx credential lease acceptance", issues);
  const expectedCount = proofMode === "none" ? 1 : 2;
  if (accepted.length !== expectedCount) {
    issues.push(
      `expected exactly ${expectedCount} Fx credential lease acceptance event(s) for ${proofMode}; observed ${accepted.length}`,
    );
  }

  for (const event of accepted) {
    const actualFields = Object.keys(event.data).sort();
    const expectedFields = [...CREDENTIAL_AUTHORITY_LIFECYCLE_FIELDS].sort();
    if (
      actualFields.length !== expectedFields.length ||
      actualFields.some((field, index) => field !== expectedFields[index])
    ) {
      issues.push(
        `Fx credential lease acceptance at event ${event.seq} did not contain the exact secret-free lifecycle fields`,
      );
    }
  }

  const resolve = accepted[0];
  validateCredentialLeaseAcceptance(
    resolve,
    { operation: "resolve", reason: "initial", count: 1 },
    "initial Fx credential resolve",
    issues,
  );
  const refresh = proofMode === "first-call-401-renewal" ? accepted[1] : undefined;
  if (refresh) {
    validateCredentialLeaseAcceptance(
      refresh,
      { operation: "refresh", reason: "callUnauthorized", count: 2 },
      "401-triggered Fx credential refresh",
      issues,
    );
  }

  const sessions = events.filter((event) => event.type === "voice.session.started");
  requireEventSource(sessions, "realtime", "native voice model session", issues);
  if (sessions.length !== 1) {
    issues.push(
      `expected exactly 1 native voice session for Fx credential proof; observed ${sessions.length}`,
    );
  }
  const acceptedBeforeSession = refresh ?? resolve;
  if (acceptedBeforeSession && sessions[0] && acceptedBeforeSession.seq >= sessions[0].seq) {
    issues.push(
      `${refresh ? "refreshed" : "resolved"} Fx credential lease was not accepted before voice.session.started`,
    );
  }

  const resolveDigest = credentialString(resolve, "accountDigest");
  const refreshDigest = credentialString(refresh, "accountDigest");
  if (!resolveDigest || !ACCOUNT_DIGEST_PATTERN.test(resolveDigest)) {
    issues.push("initial Fx credential resolve accountDigest was not a lowercase 128-bit digest");
  }
  if (refresh && (!refreshDigest || !ACCOUNT_DIGEST_PATTERN.test(refreshDigest))) {
    issues.push(
      "401-triggered Fx credential refresh accountDigest was not a lowercase 128-bit digest",
    );
  }
  if (resolveDigest && refreshDigest && resolveDigest !== refreshDigest) {
    issues.push("Fx credential renewal changed the pinned accountDigest");
  }

  const resolveGeneration = credentialString(resolve, "generation");
  const refreshGeneration = credentialString(refresh, "generation");
  if (!resolveGeneration || !DECIMAL_GENERATION_PATTERN.test(resolveGeneration)) {
    issues.push("initial Fx credential resolve generation was not a positive decimal string");
  }
  if (refresh && (!refreshGeneration || !DECIMAL_GENERATION_PATTERN.test(refreshGeneration))) {
    issues.push("401-triggered Fx credential refresh generation was not a positive decimal string");
  }
  if (
    resolveGeneration &&
    refreshGeneration &&
    DECIMAL_GENERATION_PATTERN.test(resolveGeneration) &&
    DECIMAL_GENERATION_PATTERN.test(refreshGeneration) &&
    BigInt(refreshGeneration) <= BigInt(resolveGeneration)
  ) {
    issues.push("Fx credential renewal generation did not strictly increase");
  }

  let completedAfterRenewal: EventRecord | undefined;
  if (refresh) {
    completedAfterRenewal = events.find((event) => {
      if (
        event.seq <= refresh.seq ||
        event.source !== "fx" ||
        event.type !== "orchestrator.turn.completed" ||
        event.data["status"] !== "completed" ||
        event.data["outcome"] !== "completed"
      ) {
        return false;
      }
      const turnId = event.data["turnId"];
      return (
        typeof turnId === "string" &&
        events.some(
          (candidate) =>
            candidate.seq > refresh.seq &&
            candidate.seq < event.seq &&
            candidate.source === "fx" &&
            candidate.type === "orchestrator.turn.started" &&
            candidate.data["turnId"] === turnId,
        )
      );
    });
    if (!completedAfterRenewal) {
      issues.push(
        "no completed Fx turn followed the accepted credential renewal with a matching post-renewal start",
      );
    }
  }

  if (!resolve || !resolveDigest || !resolveGeneration) return null;
  return {
    proofMode,
    lifecycleEvent: FX_CREDENTIAL_AUTHORITY_LIFECYCLE_EVENT,
    resolveAcceptedSeq: resolve.seq,
    refreshAcceptedSeq: refresh?.seq ?? null,
    accountDigest: resolveDigest,
    resolveGeneration,
    refreshGeneration: refreshGeneration ?? null,
    completedFxTurnAfterRenewalSeq: completedAfterRenewal?.seq ?? null,
    completedFxTurnAfterRenewalId:
      typeof completedAfterRenewal?.data["turnId"] === "string"
        ? completedAfterRenewal.data["turnId"]
        : null,
  };
}

function validateCredentialLeaseAcceptance(
  event: EventRecord | undefined,
  expected: { operation: "resolve" | "refresh"; reason: string; count: number },
  label: string,
  issues: string[],
): void {
  if (!event) return;
  if (
    event.data["schemaVersion"] !== 1 ||
    event.data["operation"] !== expected.operation ||
    event.data["reason"] !== expected.reason ||
    event.data["provider"] !== "codex" ||
    event.data["count"] !== expected.count
  ) {
    issues.push(
      `${label} did not carry schemaVersion 1, ${expected.operation}/${expected.reason}, provider codex, and count ${expected.count}`,
    );
  }
  const deadline = event.data["refreshDeadlineMs"];
  const remaining = event.data["remainingValidityMs"];
  if (
    !Number.isSafeInteger(deadline) ||
    (deadline as number) <= 0 ||
    !Number.isSafeInteger(remaining) ||
    (remaining as number) < CREDENTIAL_LEASE_MINIMUM_VALIDITY_MS ||
    (deadline as number) <= (remaining as number)
  ) {
    issues.push(
      `${label} did not carry a usable refresh deadline with at least ${CREDENTIAL_LEASE_MINIMUM_VALIDITY_MS}ms remaining`,
    );
  }
}

function credentialString(event: EventRecord | undefined, key: string): string | null {
  const value = event?.data[key];
  return typeof value === "string" ? value : null;
}

function validateNativeVoiceSidecarEvidence(
  snapshot: readonly EventRecord[],
  issues: string[],
): void {
  try {
    assertConsumedWireContract(wireMessagesFromEvents(snapshot));
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }

  const rpcEvents = snapshot.filter(
    (event) => event.type === "appserver.rpc.in" || event.type === "appserver.rpc.out",
  );
  const mcpRpcEvents = rpcEvents.filter((event) => {
    const method = rpcMethod(event);
    return method !== null && (method.startsWith("mcp/") || method.startsWith("mcpServer/"));
  });
  const mcpNotifications = snapshot.filter(
    (event) =>
      event.type.startsWith("appserver.mcp/") || event.type.startsWith("appserver.mcpServer/"),
  );
  if (mcpRpcEvents.length > 0 || mcpNotifications.length > 0) {
    issues.push(
      `expected zero native sidecar MCP events; observed ` +
        `${mcpRpcEvents.length + mcpNotifications.length}`,
    );
  }

  const serverRequests = rpcEvents.filter(
    (event) =>
      event.type === "appserver.rpc.in" &&
      requestId(event.data["id"]) !== null &&
      typeof event.data["method"] === "string",
  );
  if (serverRequests.length > 0) {
    issues.push(
      `expected zero native sidecar server-initiated requests; observed ${serverRequests.length}`,
    );
  }

  const childObserved = snapshot.filter((event) => event.type === "sidecar.child.observed");
  const childObservationErrors = snapshot.filter(
    (event) => event.type === "sidecar.child-observation.error",
  );
  if (childObserved.length > 0) {
    issues.push(
      `expected zero native sidecar child process observations; observed ${childObserved.length}`,
    );
  }
  if (childObservationErrors.length > 0) {
    issues.push(
      `expected zero native sidecar child observation errors; observed ${childObservationErrors.length}`,
    );
  }

  const isolationStarts = snapshot.filter((event) => event.type === "sidecar.isolation.started");
  const isolationCompletions = snapshot.filter(
    (event) => event.type === "sidecar.isolation.completed",
  );
  requireEventSource(isolationStarts, "app-server", "native sidecar isolation start", issues);
  requireEventSource(
    isolationCompletions,
    "app-server",
    "native sidecar isolation completion",
    issues,
  );
  if (isolationStarts.length !== 1 || isolationCompletions.length !== 1) {
    issues.push(
      `expected exactly 1 native sidecar isolation start and completion; observed ` +
        `${isolationStarts.length} starts and ${isolationCompletions.length} completions`,
    );
    return;
  }
  const start = isolationStarts[0]!;
  const completion = isolationCompletions[0]!;
  if (completion.seq <= start.seq) {
    issues.push("native sidecar isolation completed before it started");
  }
  validateNoForkIsolationEvidence(start.data, "start", issues);
  validateNoForkIsolationEvidence(completion.data, "completion", issues);
}

function validateFxRunEvents(
  snapshot: readonly EventRecord[],
  steerInputId: string,
  options: {
    label: string;
    delegationType: string;
    admissionType: string;
    delegationSource: EventSource;
    admissionSource: EventSource;
    delegationLifecycleSource: EventSource;
    correlateNativeDelegations?: boolean;
    fail(issues: readonly string[]): Error;
  },
): LiveKitRunValidationResult {
  const events = [...snapshot].sort((left, right) => left.seq - right.seq);
  const issues: string[] = [];
  const starts = events.filter((event) => event.type === "orchestrator.turn.started");
  if (starts.length !== 3) {
    issues.push(`expected exactly 3 Fx orchestrator turn starts; observed ${starts.length}`);
  }
  requireEventSource(starts, "fx", "Fx orchestrator turn start", issues);
  requirePositiveIntegerField(starts, "adeSequence", "Fx orchestrator turn start", issues);
  const turnIds = starts.map((event, index) =>
    requiredString(event, "turnId", `Fx orchestrator turn ${index + 1}`, issues),
  );
  if (new Set(turnIds.filter((turnId) => turnId !== null)).size !== turnIds.length) {
    issues.push("Fx orchestrator turn IDs were not unique");
  }

  const allCompletions = events.filter((event) => event.type === "orchestrator.turn.completed");
  if (allCompletions.length !== 3) {
    issues.push(
      `expected exactly 3 Fx orchestrator turn completions; observed ${allCompletions.length}`,
    );
  }
  requireEventSource(allCompletions, "fx", "Fx orchestrator turn completion", issues);
  requirePositiveIntegerField(
    allCompletions,
    "adeSequence",
    "Fx orchestrator turn completion",
    issues,
  );
  validateFxAdeProvenance(events, starts, allCompletions, issues);
  for (const completion of allCompletions) {
    const matchingStart = starts.find(
      (start) => start.data["turnId"] === completion.data["turnId"],
    );
    if (!matchingStart) {
      issues.push(`Fx completion ${String(completion.data["turnId"])} had no matching turn start`);
    } else if (matchingStart.seq >= completion.seq) {
      issues.push(`Fx turn ${String(completion.data["turnId"])} completed before it started`);
    }
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
    } else {
      const completion = completions[0]!;
      if (
        completion.data["status"] !== "completed" ||
        (completion.data["outcome"] !== undefined && completion.data["outcome"] !== "completed") ||
        (completion.data["error"] !== undefined && completion.data["error"] !== null)
      ) {
        issues.push(
          `Fx turn ${index + 1} (${turnId}) did not complete successfully: ` +
            `status=${String(completion.data["status"])} ` +
            `outcome=${String(completion.data["outcome"])} ` +
            `error=${String(completion.data["error"])}`,
        );
      }
    }
  }

  const delegations = events.filter((event) => event.type === options.delegationType);
  const admissions = events.filter((event) => event.type === options.admissionType);
  if (delegations.length !== 4) {
    issues.push(`expected exactly 4 ${options.label} delegations; observed ${delegations.length}`);
  }
  if (admissions.length !== 4) {
    issues.push(`expected exactly 4 ${options.label} admissions; observed ${admissions.length}`);
  }
  requireEventSource(delegations, options.delegationSource, `${options.label} delegation`, issues);
  if (
    options.admissionType !== options.delegationType ||
    options.admissionSource !== options.delegationSource
  ) {
    requireEventSource(admissions, options.admissionSource, `${options.label} admission`, issues);
  }
  const admissionIds = admissions.map((event) => event.data["delegationTurnId"]);
  if (
    admissionIds.some((id) => typeof id !== "string" || id.length === 0) ||
    new Set(admissionIds).size !== admissionIds.length
  ) {
    issues.push(`${options.label} admission IDs were missing or not unique`);
  }
  const semanticAdmissions = options.correlateNativeDelegations
    ? correlateNativeDelegations(delegations, admissions, issues)
    : admissions;
  for (const index of [0, 1, 3]) {
    const disposition = semanticAdmissions[index]?.data["disposition"];
    if (semanticAdmissions[index] && disposition !== "queued") {
      issues.push(`delegation ${index + 1} must be queued; observed ${String(disposition)}`);
    }
  }
  const steeringDelegation = semanticAdmissions[2];
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
  requireEventSource(
    steeringAdmissions,
    options.delegationLifecycleSource,
    `${options.label} steering acknowledgement`,
    issues,
  );
  if (steeringAdmissions.length !== 1) {
    issues.push(
      `expected exactly 1 delegation.steered event; observed ${steeringAdmissions.length}`,
    );
  } else if (steeringAdmissions[0]?.data["activeTurnId"] !== turnTwoId) {
    issues.push("delegation.steered did not identify Fx turn 2 as its active target");
  } else if (
    steeringAdmissions[0]?.data["delegationTurnId"] !== steeringDelegation?.data["delegationTurnId"]
  ) {
    issues.push("delegation.steered did not match delegation 3's admission ID");
  } else if (steeringDelegation && steeringAdmissions[0]!.seq <= steeringDelegation.seq) {
    issues.push("delegation.steered was recorded before its steering admission");
  }

  const delegationFailures = events.filter((event) => event.type === "delegation.failed");
  requireEventSource(
    delegationFailures,
    options.delegationLifecycleSource,
    `${options.label} delegation failure`,
    issues,
  );
  if (delegationFailures.length > 0) {
    issues.push(`expected zero delegation.failed events; observed ${delegationFailures.length}`);
  }

  const completedDelegations = events.filter((event) => event.type === "delegation.completed");
  requireEventSource(
    completedDelegations,
    options.delegationLifecycleSource,
    `${options.label} delegation completion`,
    issues,
  );
  if (completedDelegations.length !== 3) {
    issues.push(
      `expected exactly 3 delegation.completed events; observed ${completedDelegations.length}`,
    );
  }
  const queuedAdmissionIndexes = [0, 1, 3] as const;
  for (let turnIndex = 0; turnIndex < queuedAdmissionIndexes.length; turnIndex++) {
    const admissionIndex = queuedAdmissionIndexes[turnIndex]!;
    const admission = semanticAdmissions[admissionIndex];
    const turnId = turnIds[turnIndex];
    if (!admission || !turnId) continue;
    const delegationTurnId = admission.data["delegationTurnId"];
    if (delegationTurnId !== turnId) {
      issues.push(
        `queued delegation ${admissionIndex + 1} admitted ` +
          `${String(delegationTurnId)} instead of Fx turn ${turnId}`,
      );
      continue;
    }
    const matching = completedDelegations.filter(
      (event) =>
        event.data["delegationTurnId"] === delegationTurnId && event.data["turnId"] === turnId,
    );
    if (matching.length !== 1 || matching[0]?.data["outcome"] !== "completed") {
      issues.push(
        `queued delegation ${admissionIndex + 1} did not have exactly one ` +
          `successful completion bound to Fx turn ${turnId}`,
      );
    } else {
      const orchestratorCompletion = events.find(
        (event) => event.type === "orchestrator.turn.completed" && event.data["turnId"] === turnId,
      );
      if (orchestratorCompletion && matching[0]!.seq <= orchestratorCompletion.seq) {
        issues.push(
          `queued delegation ${admissionIndex + 1} completed before Fx turn ${turnId} completed`,
        );
      }
    }
  }

  const steerStarts = events.filter(
    (event) => event.type === "input.audio.started" && event.data["id"] === steerInputId,
  );
  requireEventSource(steerStarts, "media", "steering audio start", issues);
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

  if (issues.length > 0) throw options.fail(issues);
  if (
    turnIds.length !== 3 ||
    turnIds.some((turnId) => turnId === null) ||
    !steerStarted ||
    !steeringDelegation ||
    typeof steeringTarget !== "string" ||
    !turnTwoCompleted
  ) {
    throw options.fail([`trace did not contain the required ${options.label} run events`]);
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

function correlateNativeDelegations(
  delegations: readonly EventRecord[],
  admissions: readonly EventRecord[],
  issues: string[],
): Array<EventRecord | undefined> {
  const rawByItemId = new Map<string, EventRecord>();
  for (const [index, delegation] of delegations.entries()) {
    const itemId = requiredString(delegation, "id", `native delegation ${index + 1}`, issues);
    if (!itemId) continue;
    if (rawByItemId.has(itemId)) {
      issues.push(`native delegation item ID ${itemId} was duplicated`);
      continue;
    }
    if (delegation.data["target"] !== "client") {
      issues.push(`native delegation ${itemId} did not target the client`);
    }
    rawByItemId.set(itemId, delegation);
  }

  const admissionsByItemId = new Map<string, EventRecord>();
  for (const [index, admission] of admissions.entries()) {
    const itemId = requiredString(admission, "itemId", `Fx admission ${index + 1}`, issues);
    if (!itemId) continue;
    if (admissionsByItemId.has(itemId)) {
      issues.push(`Fx admission item ID ${itemId} was duplicated`);
      continue;
    }
    admissionsByItemId.set(itemId, admission);
  }

  for (const [itemId, delegation] of rawByItemId) {
    const admission = admissionsByItemId.get(itemId);
    if (!admission) {
      issues.push(`native delegation ${itemId} had no correlated Fx admission`);
      continue;
    }
    if (
      typeof delegation.data["text"] !== "string" ||
      delegation.data["text"].trim().length === 0 ||
      delegation.data["text"].trim() !== admission.data["text"]
    ) {
      issues.push(`native delegation ${itemId} text did not match its Fx admission`);
    }
  }
  for (const itemId of admissionsByItemId.keys()) {
    if (!rawByItemId.has(itemId)) {
      issues.push(`Fx admission ${itemId} had no correlated native delegation`);
    }
  }
  return delegations.map((delegation) => {
    const itemId = delegation.data["id"];
    return typeof itemId === "string" ? admissionsByItemId.get(itemId) : undefined;
  });
}

function validateCodexFxBridgeEvidence(snapshot: readonly EventRecord[], issues: string[]): void {
  const events = [...snapshot].sort((left, right) => left.seq - right.seq);
  const delegations = events.filter((event) => event.type === "delegation.created");
  const admissions = events.filter((event) => event.type === "delegation.admitted");
  const forwarded = events.filter((event) => event.type === "delegation.forwarded");
  const appendStarts = events.filter((event) => event.type === "handoff.append.started");
  const appendCompletions = events.filter((event) => event.type === "handoff.append.completed");
  requireEventSource(forwarded, "bridge", "forwarded native delegation", issues);
  requireEventSource(appendStarts, "bridge", "native handoff append start", issues);
  requireEventSource(appendCompletions, "bridge", "native handoff append completion", issues);
  if (forwarded.length !== 4) {
    issues.push(`expected exactly 4 forwarded native delegations; observed ${forwarded.length}`);
  }
  if (appendStarts.length !== 7 || appendCompletions.length !== 7) {
    issues.push(
      `expected exactly 7 native handoff append starts and completions; observed ` +
        `${appendStarts.length} starts and ${appendCompletions.length} completions`,
    );
  }

  const handoffIds = new Set<string>();
  for (const [index, delegation] of delegations.entries()) {
    const itemId = delegation.data["id"];
    if (typeof itemId !== "string" || itemId.length === 0) continue;
    const admission = admissions.find((event) => event.data["itemId"] === itemId);
    if (!admission) continue;
    const handoffId = admission.data["handoffId"];
    if (typeof handoffId !== "string" || handoffId.length === 0) {
      issues.push(`Codex-Fx admission for ${itemId} had no handoffId`);
      continue;
    }
    if (handoffIds.has(handoffId)) {
      issues.push(`native handoff ID ${handoffId} was reused`);
    }
    handoffIds.add(handoffId);
    const matchingForwarded = forwarded.filter(
      (event) => event.data["itemId"] === itemId && event.data["handoffId"] === handoffId,
    );
    if (
      matchingForwarded.length !== 1 ||
      matchingForwarded[0]!.seq >= admission.seq ||
      matchingForwarded[0]!.data["text"] !== admission.data["text"]
    ) {
      issues.push(
        `native delegation ${itemId} did not have exactly one ordered, text-matched forward`,
      );
    }

    const disposition = admission.data["disposition"];
    const requiredPhases = disposition === "steering" ? ["progress"] : ["progress", "result"];
    for (const phase of requiredPhases) {
      const starts = appendStarts.filter(
        (event) => event.data["handoffId"] === handoffId && event.data["phase"] === phase,
      );
      const completions = appendCompletions.filter(
        (event) => event.data["handoffId"] === handoffId && event.data["phase"] === phase,
      );
      if (
        starts.length !== 1 ||
        completions.length !== 1 ||
        starts[0]!.seq <= admission.seq ||
        completions[0]!.seq <= starts[0]!.seq
      ) {
        issues.push(
          `native handoff ${handoffId} did not have one ordered ${phase} append after admission`,
        );
        continue;
      }
      if (phase === "result") {
        const delegationCompletion = events.find(
          (event) =>
            event.type === "delegation.completed" &&
            event.data["delegationTurnId"] === admission.data["delegationTurnId"],
        );
        if (!delegationCompletion || starts[0]!.seq <= delegationCompletion.seq) {
          issues.push(`native handoff ${handoffId} result was appended before Fx completion`);
        }
      } else if (disposition === "steering") {
        const steering = events.find(
          (event) =>
            event.type === "delegation.steered" &&
            event.data["delegationTurnId"] === admission.data["delegationTurnId"],
        );
        if (!steering || steering.seq <= completions[0]!.seq) {
          issues.push(
            `native handoff ${handoffId} steering acknowledgement preceded its progress append`,
          );
        }
      }
    }
    if (disposition !== "queued" && disposition !== "steering") {
      issues.push(`native delegation ${index + 1} had invalid disposition ${String(disposition)}`);
    }
  }
}

function validateCodexFxIdentityEvidence(
  snapshot: readonly EventRecord[],
  voiceThreadId: string,
  issues: string[],
): void {
  const identities = snapshot.filter((event) => event.type === "fx.identity");
  requireEventSource(identities, "fx", "Fx identity", issues);
  const identity = identities[0];
  if (
    identities.length !== 1 ||
    identity?.data["auth"] !== "Codex subscription" ||
    identity.data["modelSource"] !== "Codex subscription" ||
    identity.data["permissionMode"] !== "yolo" ||
    identity.data["model"] !== CODEX_REFERENCE.orchestratorModel ||
    identity.data["reasoningEffort"] !== CODEX_REFERENCE.reasoningEffort
  ) {
    issues.push("trace did not contain the exact authenticated Fx identity");
  }

  const starts = snapshot.filter(
    (event) =>
      event.type === "appserver.rpc.out" && event.data["method"] === "thread/realtime/start",
  );
  requireEventSource(starts, "app-server", "native realtime start request", issues);
  const params = asRecord(starts[0]?.data["params"]);
  if (
    starts.length !== 1 ||
    params?.["threadId"] !== voiceThreadId ||
    params["version"] !== "v3" ||
    params["voice"] !== CODEX_REFERENCE.voice ||
    params["outputModality"] !== "audio" ||
    params["clientManagedHandoffs"] !== true ||
    params["delegationAckFiller"] !== false ||
    "model" in params
  ) {
    issues.push("trace did not contain the exact client-managed native V3 start request");
  }

  const sessions = snapshot.filter((event) => event.type === "voice.session.started");
  requireEventSource(sessions, "realtime", "native voice model session", issues);
  // V3 deliberately leaves model and voice null in the private session.started
  // payload. The pinned sidecar plus the model-less V3 request attest server-side
  // model selection; inventing an observed model here would weaken the proof.
  if (sessions.length < 1) {
    issues.push("trace did not contain a native realtime voice session");
  }
}

function validateFxAdeProvenance(
  events: readonly EventRecord[],
  starts: readonly EventRecord[],
  completions: readonly EventRecord[],
  issues: string[],
): void {
  const canonical = [
    ...starts.map((event) => ({ event, rawType: "fx.ade.turnstarted" })),
    ...completions.map((event) => ({ event, rawType: "fx.ade.postturnend" })),
  ].sort((left, right) => left.event.seq - right.event.seq);
  let previousAdeSequence = 0;
  for (const item of canonical) {
    const adeSequence = item.event.data["adeSequence"];
    if (!Number.isInteger(adeSequence) || (adeSequence as number) < 1) continue;
    if ((adeSequence as number) <= previousAdeSequence) {
      issues.push(`Fx ADE sequence did not increase at canonical event ${item.event.seq}`);
    }
    previousAdeSequence = adeSequence as number;
    const matching = events.filter(
      (event) =>
        event.type === item.rawType &&
        event.source === "fx" &&
        event.data["adeSequence"] === adeSequence,
    );
    const context = asRecord(matching[0]?.data["context"]);
    if (
      matching.length !== 1 ||
      matching[0]!.seq >= item.event.seq ||
      context?.["agent_role"] !== "main" ||
      String(context["turn_id"]) !== String(item.event.data["turnId"])
    ) {
      issues.push(
        `Fx canonical event ${item.event.seq} did not biject to its ordered raw ADE event`,
      );
    }
  }
}

function validateNoForkIsolationEvidence(
  data: Record<string, unknown>,
  phase: string,
  issues: string[],
): void {
  const expectedProfileSha256 = createHash("sha256")
    .update(NATIVE_SIDECAR_SANDBOX_PROFILE)
    .digest("hex");
  if (
    data["implementationProfile"] !== "native-voice-sidecar" ||
    data["childProcessPolicy"] !== "kernel-deny-fork" ||
    data["sandboxExecutable"] !== "/usr/bin/sandbox-exec" ||
    data["sandboxProfileSha256"] !== expectedProfileSha256 ||
    data["childObservation"] !== "ps-descendant-sampling" ||
    data["childObservationErrorCount"] !== 0 ||
    data["observedChildProcessCount"] !== 0
  ) {
    issues.push(`native sidecar isolation ${phase} did not prove kernel no-fork execution`);
  }
}

function rpcMethod(event: EventRecord): string | null {
  const method = event.data["method"];
  return typeof method === "string" ? method : null;
}

function requestId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function requireEventSource(
  events: readonly EventRecord[],
  expected: EventSource,
  label: string,
  issues: string[],
): void {
  for (const event of events) {
    if (event.source !== expected) {
      issues.push(`${label} at event ${event.seq} came from ${event.source}, not ${expected}`);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validResolutionRemainder(overlapSamples: number, spanSamples: number): boolean {
  const overlapRemainder = overlapSamples % AUDIBLE_OVERLAP_RESOLUTION_SAMPLES;
  const spanRemainder = spanSamples % AUDIBLE_OVERLAP_RESOLUTION_SAMPLES;
  return overlapRemainder === 0 || (spanRemainder > 0 && overlapRemainder === spanRemainder);
}

function requirePositiveIntegerField(
  events: readonly EventRecord[],
  key: string,
  label: string,
  issues: string[],
): void {
  for (const event of events) {
    const value = event.data[key];
    if (!Number.isInteger(value) || (value as number) < 1) {
      issues.push(`${label} at event ${event.seq} has no positive ${key}`);
    }
  }
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

  const steerFinishes = events.filter(
    (event) => event.type === "input.audio.finished" && event.data["id"] === steerInputId,
  );
  requireEventSource(steerFinishes, "media", "steering audio finish", issues);
  if (steerFinishes.length !== 1) {
    issues.push(
      `expected exactly 1 input.audio.finished event for ${JSON.stringify(steerInputId)}; ` +
        `observed ${steerFinishes.length}`,
    );
  }
  const steerFinished = steerFinishes[0];
  if (steerFinished && steerFinished.seq <= steerStarted.seq) {
    issues.push("steering audio finished before it started");
  }
  const steerEndSeq = steerFinished?.seq ?? steerStarted.seq;
  let outputActive = false;
  let overlap = false;

  for (const event of events) {
    if (
      (event.type === OUTPUT_AUDIO_STARTED || OUTPUT_AUDIO_ENDED.has(event.type)) &&
      event.source !== "media"
    ) {
      issues.push(`output audio lifecycle event ${event.seq} came from ${event.source}, not media`);
    }
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
