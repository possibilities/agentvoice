import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CRITERION_IDS } from "../src/judge-rubric.ts";
import {
  AUDIO_DIMENSION_IDS,
  aggregatePairwisePasses,
  defaultPairwiseAudioJudgmentPath,
  judgeArtifactPair,
  LEGACY_PAIRWISE_AUDIO_JUDGE_PROTOCOL_VERSION,
  loadPairwiseResponseCheckpoint,
  normalizePairwiseAudioTimestamps,
  type OpenAIPairwiseAudioRequest,
  type PairwiseAudioPassAssessment,
  type PairwiseAudioResponseClient,
  type PairwiseResponseCheckpoint,
  validatePairwiseAudioJudgment,
  validatePairwisePassAssessment,
  writePairwiseAudioJudgment,
  writePairwiseResponseCheckpoint,
} from "../src/pairwise-audio-judge.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("blind pairwise audio judge", () => {
  test("runs reversed blind passes and aggregates scores locally without persisting audio", async () => {
    const root = temporaryDirectory();
    const secret = "sk-proj-pairwise-secret-never-send-123456";
    const first = makeArtifact(root, "run-product-one", "product-one", 1, secret);
    const second = makeArtifact(root, "run-product-two", "product-two", 2, secret);
    const client = new FakePairwiseClient();

    const judgment = await judgeArtifactPair({
      artifactDirectories: [first.directory, second.directory],
      apiKey: secret,
      responseClient: client,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });

    expect(client.requests).toHaveLength(2);
    expect(audioPayloads(client.requests[0]!)).toEqual([
      first.outputBytes.toString("base64"),
      first.comparisonBytes.toString("base64"),
      second.outputBytes.toString("base64"),
      second.comparisonBytes.toString("base64"),
    ]);
    expect(audioPayloads(client.requests[1]!)).toEqual([
      second.outputBytes.toString("base64"),
      second.comparisonBytes.toString("base64"),
      first.outputBytes.toString("base64"),
      first.comparisonBytes.toString("base64"),
    ]);
    for (const request of client.requests) {
      expect(request.store).toBe(false);
      expect(request.modalities).toEqual(["text"]);
      expect(request.tool_choice).toEqual({
        type: "function",
        function: { name: "submit_audio_comparison" },
      });
      expect(request.tools[0].function.strict).toBe(true);
      const textOnly = request.messages
        .flatMap((message) =>
          typeof message.content === "string"
            ? [message.content]
            : message.content.filter((part) => part.type === "text").map((part) => part.text),
        )
        .join("\n");
      expect(textOnly).not.toContain("product-one");
      expect(textOnly).not.toContain("product-two");
      expect(textOnly).not.toContain("codexWorkTurnCount");
      expect(textOnly).not.toContain(secret);
      expect(textOnly).not.toContain("run-product-one");
      expect(textOnly).not.toContain("run-product-two");
    }

    expect(judgment.passes.map((pass) => pass.labelMapping)).toEqual([
      { A: "subject-1", B: "subject-2" },
      { A: "subject-2", B: "subject-1" },
    ]);
    expect(judgment.passes.map((pass) => pass.finishReason)).toEqual(["stop", "stop"]);
    expect(judgment.aggregate).toMatchObject({
      winner: "subject-1",
      marginPoints: 25,
      consensus: "both_prefer_winner",
      passWinners: ["subject-1", "subject-1"],
    });
    expect(judgment.aggregate.subjects[0]).toMatchObject({
      subjectId: "subject-1",
      score: 100,
      vocalDeliveryScore: 4,
      vocalDeliveryPoints: 5,
      audibleExperienceScore: 100,
      passScores: [100, 100],
    });
    expect(judgment.aggregate.subjects[1]).toMatchObject({
      subjectId: "subject-2",
      score: 75,
      vocalDeliveryScore: 3,
      vocalDeliveryPoints: 3.75,
      audibleExperienceScore: 75,
      passScores: [75, 75],
    });
    expect(judgment.judge).toMatchObject({
      store: false,
      outputModality: "text",
      forcedFunction: "submit_audio_comparison",
      resolvedModels: ["gpt-audio-1.5-snapshot", "gpt-audio-1.5-snapshot"],
      usage: {
        promptTokens: 200,
        completionTokens: 100,
        totalTokens: 300,
        inputAudioTokens: 160,
        outputAudioTokens: 0,
      },
    });

    const serialized = JSON.stringify(judgment);
    expect(serialized).not.toContain(first.outputBytes.toString("base64"));
    expect(serialized).not.toContain(first.comparisonBytes.toString("base64"));
    expect(serialized).not.toContain(second.outputBytes.toString("base64"));
    expect(serialized).not.toContain(second.comparisonBytes.toString("base64"));
    expect(serialized).not.toContain(secret);
    expect(judgment.subjects[0].audio.originalPcm.conversation.sha256).not.toBe(
      judgment.subjects[1].audio.originalPcm.conversation.sha256,
    );
    expect(judgment.protocol).toMatchObject({
      isolatedOutputAudioBytesProvided: true,
      conversationAudioBytesProvided: true,
      originalPcmMetricsProvided: true,
      base64AudioPersisted: false,
      responseBindingVersion: "sanitized-provider-response-json-sha256-v1",
    });
    expect(judgment.passes[0].requestInputSha256).not.toBe(judgment.passes[1].requestInputSha256);
  });

  test("rejects invented evidence, invalid timestamps, and preferences inconsistent with scores", () => {
    const valid = modelAssessment("A");
    const context = {
      candidateAEvidenceIds: new Set(["manifest:run-state"]),
      candidateBEvidenceIds: new Set(["manifest:run-state"]),
      candidateATrackDurations: { isolated_output: 1_000, conversation: 1_000 },
      candidateBTrackDurations: { isolated_output: 1_000, conversation: 1_000 },
    };
    expect(() => validatePairwisePassAssessment(valid, context)).not.toThrow();

    const invented = structuredClone(valid);
    invented.criteria[0]!.candidateAEvidenceIds = ["invented"];
    expect(() => validatePairwisePassAssessment(invented, context)).toThrow(
      "unknown evidence ID invented",
    );

    const invalidTimestamp = structuredClone(valid);
    invalidTimestamp.audioObservations[0]!.endMs = 1_001;
    expect(() => validatePairwisePassAssessment(invalidTimestamp, context)).toThrow(
      "beyond candidate A isolated_output duration",
    );

    const wrongTrack = structuredClone(valid);
    wrongTrack.audioObservations[0]!.track = "conversation";
    expect(() => validatePairwisePassAssessment(wrongTrack, context)).toThrow(
      "isolated_output is required",
    );

    const inconsistent = structuredClone(valid);
    inconsistent.criteria[0]!.preference = "B";
    expect(() => validatePairwisePassAssessment(inconsistent, context)).toThrow(
      "preference must be A",
    );

    const missingCitationArray = structuredClone(valid);
    delete (
      missingCitationArray.criteria[6] as Partial<(typeof missingCitationArray.criteria)[number]>
    ).candidateAEvidenceIds;
    expect(() =>
      normalizePairwiseAudioTimestamps(missingCitationArray, {
        candidateATrackDurations: context.candidateATrackDurations,
        candidateBTrackDurations: context.candidateBTrackDurations,
      }),
    ).toThrow("candidateAEvidenceIds");

    const audioTimed = structuredClone(valid);
    audioTimed.audioObservations[0]!.startMs = 900;
    audioTimed.audioObservations[0]!.endMs = 900;
    audioTimed.audioObservations[1]!.endMs = 1_006;
    const normalized = normalizePairwiseAudioTimestamps(audioTimed, {
      candidateATrackDurations: context.candidateATrackDurations,
      candidateBTrackDurations: context.candidateBTrackDurations,
    });
    expect(normalized.receipt).toMatchObject({
      method: "audio-time-citations-v2",
      candidateA: {
        expandedPointObservations: [
          {
            observationId: "audio-a-output",
            originalStartMs: 900,
            originalEndMs: 900,
            normalizedStartMs: 400,
            normalizedEndMs: 1_000,
          },
        ],
        clampedEndObservations: [
          {
            observationId: "audio-a-conversation",
            originalStartMs: 300,
            originalEndMs: 1_006,
            normalizedStartMs: 300,
            normalizedEndMs: 1_000,
          },
        ],
      },
      candidateB: {
        expandedPointObservations: [],
        clampedEndObservations: [],
      },
    });
    expect(normalized.assessment.audioObservations[0]).toMatchObject({
      startMs: 400,
      endMs: 1_000,
    });
    expect(normalized.assessment.audioObservations[1]).toMatchObject({
      startMs: 300,
      endMs: 1_000,
    });
    expect(() => validatePairwisePassAssessment(normalized.assessment, context)).not.toThrow();

    const reversed = structuredClone(valid);
    reversed.audioObservations[0]!.startMs = 900;
    reversed.audioObservations[0]!.endMs = 100;
    expect(() =>
      normalizePairwiseAudioTimestamps(reversed, {
        candidateATrackDurations: context.candidateATrackDurations,
        candidateBTrackDurations: context.candidateBTrackDurations,
      }),
    ).toThrow("reversed interval");

    const journalOrDecimalTimed = structuredClone(valid);
    journalOrDecimalTimed.audioObservations[1]!.endMs = 4_000;
    expect(() =>
      normalizePairwiseAudioTimestamps(journalOrDecimalTimed, {
        candidateATrackDurations: context.candidateATrackDurations,
        candidateBTrackDurations: context.candidateBTrackDurations,
      }),
    ).toThrow("beyond 1000ms conversation duration");
  });

  test("revalidates local aggregates and writes reports exactly once", async () => {
    const root = temporaryDirectory();
    const first = makeArtifact(root, "run-one", "product-alpha", 1, "not-a-secret");
    const second = makeArtifact(root, "run-two", "product-beta", 2, "not-a-secret");
    const judgment = await judgeArtifactPair({
      artifactDirectories: [first.directory, second.directory],
      responseClient: new FakePairwiseClient(),
    });
    const tampered = structuredClone(judgment);
    tampered.aggregate.subjects[0].score = 1;
    expect(() => validatePairwiseAudioJudgment(tampered)).toThrow("aggregate does not match");

    const wrongResponseHeader = structuredClone(judgment);
    wrongResponseHeader.judge.responseIds[0] = "chatcmpl_fabricated";
    expect(() => validatePairwiseAudioJudgment(wrongResponseHeader)).toThrow(
      "response IDs do not match",
    );

    const wrongModelHeader = structuredClone(judgment);
    wrongModelHeader.judge.resolvedModels[1] = "fabricated-model";
    expect(() => validatePairwiseAudioJudgment(wrongModelHeader)).toThrow(
      "resolved models do not match",
    );

    const missingProviderResponse = structuredClone(judgment);
    delete missingProviderResponse.passes[0].providerResponse;
    delete missingProviderResponse.passes[0].providerResponseSha256;
    expect(() => validatePairwiseAudioJudgment(missingProviderResponse)).toThrow(
      "missing its sanitized provider response provenance",
    );

    const tamperedProviderResponse = structuredClone(judgment);
    tamperedProviderResponse.passes[0].providerResponse!.id = "chatcmpl_fabricated";
    expect(() => validatePairwiseAudioJudgment(tamperedProviderResponse)).toThrow(
      "provider response SHA-256 does not match",
    );

    const duplicateSubject = structuredClone(judgment);
    duplicateSubject.subjects[1].manifestSha256 = duplicateSubject.subjects[0].manifestSha256;
    expect(() => validatePairwiseAudioJudgment(duplicateSubject)).toThrow("two distinct artifacts");

    const wrongNormalizationReceipt = structuredClone(judgment);
    const receipt = wrongNormalizationReceipt.passes[0].timestampNormalization;
    if (receipt.method !== "audio-time-citations-v2") throw new Error("expected v2 receipt");
    receipt.candidateA.expandedPointObservations.push({
      observationId: "invented-observation",
      originalStartMs: 500,
      originalEndMs: 500,
      normalizedStartMs: 0,
      normalizedEndMs: 1_000,
    });
    expect(() => validatePairwiseAudioJudgment(wrongNormalizationReceipt)).toThrow(
      "unknown audio observation invented-observation",
    );

    const legacy = structuredClone(judgment);
    legacy.protocolVersion = LEGACY_PAIRWISE_AUDIO_JUDGE_PROTOCOL_VERSION;
    legacy.protocol = {
      passCount: 2,
      orderCounterbalanced: true,
      textIdentityWithheldFromModel: true,
      acousticIdentityNotMasked: true,
      isolatedOutputAudioBytesProvided: true,
      conversationAudioBytesProvided: true,
      originalPcmMetricsProvided: true,
      timestampNormalization: "citation-canonicalization-v1",
      base64AudioPersisted: false,
      audioLayouts: {
        isolatedOutput: "agent-mono",
        conversation: "evaluator-left-agent-right",
      },
      aggregation: "local-mean-of-two-reversed-label-passes",
    };
    const subjectById = new Map(legacy.subjects.map((subject) => [subject.subjectId, subject]));
    for (const pass of legacy.passes) {
      const legacyCandidateReceipt = (subjectId: "subject-1" | "subject-2") => ({
        journalToAudioOffsetMs:
          subjectById.get(subjectId)!.audio.originalPcm.timelineAlignment.journalToAudioOffsetMs,
        offsetApplied: false,
        expandedPointObservationIds: [],
        clampedEndObservationIds: [],
        decimalScaleCorrections: [],
      });
      pass.timestampNormalization = {
        method: "citation-canonicalization-v1",
        defaultedEmptyArrayPaths: [],
        candidateA: legacyCandidateReceipt(pass.labelMapping.A),
        candidateB: legacyCandidateReceipt(pass.labelMapping.B),
      };
    }
    expect(() => validatePairwiseAudioJudgment(legacy)).not.toThrow();

    const output = join(root, "judgments", "comparison.json");
    writePairwiseAudioJudgment(output, judgment);
    expect(() => writePairwiseAudioJudgment(output, judgment)).toThrow();
    expect(defaultPairwiseAudioJudgmentPath(second.directory, first.directory)).toEndWith(
      "/judgments/run-one--vs--run-two.pairwise-audio.json",
    );
  });

  test("binds v2 timestamp receipts to the exact before and after intervals", async () => {
    const root = temporaryDirectory();
    const first = makeArtifact(root, "run-one", "product-alpha", 1, "not-a-secret");
    const second = makeArtifact(root, "run-two", "product-beta", 2, "not-a-secret");
    const client = new FakePairwiseClient((index) => {
      const assessment = modelAssessment(index === 0 ? "A" : "B");
      if (index === 0) {
        const point = assessment.audioObservations.find(
          (observation) => observation.id === "audio-a-output",
        )!;
        point.startMs = 900;
        point.endMs = 900;
        const clamped = assessment.audioObservations.find(
          (observation) => observation.id === "audio-a-conversation",
        )!;
        clamped.endMs = 1_006;
      }
      return assessment;
    });
    const judgment = await judgeArtifactPair({
      artifactDirectories: [first.directory, second.directory],
      responseClient: client,
    });
    const pass = judgment.passes[0];
    const receipt = pass.timestampNormalization;
    if (receipt.method !== "audio-time-citations-v2") throw new Error("expected v2 receipt");
    expect(receipt.candidateA).toMatchObject({
      expandedPointObservations: [
        {
          observationId: "audio-a-output",
          originalStartMs: 900,
          originalEndMs: 900,
          normalizedStartMs: 400,
          normalizedEndMs: 1_000,
        },
      ],
      clampedEndObservations: [
        {
          observationId: "audio-a-conversation",
          originalStartMs: 300,
          originalEndMs: 1_006,
          normalizedStartMs: 300,
          normalizedEndMs: 1_000,
        },
      ],
    });
    expect(() => validatePairwiseAudioJudgment(judgment)).not.toThrow();

    const incomplete = structuredClone(judgment);
    const incompleteReceipt = incomplete.passes[0].timestampNormalization;
    if (incompleteReceipt.method !== "audio-time-citations-v2") throw new Error("expected v2");
    incompleteReceipt.candidateA.expandedPointObservations.length = 0;
    expect(() => validatePairwiseAudioJudgment(incomplete)).toThrow(
      "timestamp normalization receipt is incomplete",
    );

    const nonPointClaim = structuredClone(judgment);
    const nonPointReceipt = nonPointClaim.passes[0].timestampNormalization;
    if (nonPointReceipt.method !== "audio-time-citations-v2") throw new Error("expected v2");
    nonPointReceipt.candidateA.expandedPointObservations[0]!.originalEndMs = 901;
    expect(() => validatePairwiseAudioJudgment(nonPointClaim)).toThrow("not originally a point");

    const wrongExpansion = structuredClone(judgment);
    const wrongExpansionReceipt = wrongExpansion.passes[0].timestampNormalization;
    if (wrongExpansionReceipt.method !== "audio-time-citations-v2") {
      throw new Error("expected v2");
    }
    wrongExpansionReceipt.candidateA.expandedPointObservations[0]!.normalizedStartMs = 401;
    expect(() => validatePairwiseAudioJudgment(wrongExpansion)).toThrow(
      "exact normalized interval",
    );

    const excessiveClamp = structuredClone(judgment);
    const excessiveClampReceipt = excessiveClamp.passes[0].timestampNormalization;
    if (excessiveClampReceipt.method !== "audio-time-citations-v2") {
      throw new Error("expected v2");
    }
    excessiveClampReceipt.candidateA.clampedEndObservations[0]!.originalEndMs = 1_051;
    expect(() => validatePairwiseAudioJudgment(excessiveClamp)).toThrow(
      "does not prove a 0..50ms encoder overflow",
    );

    const duplicate = structuredClone(judgment);
    const duplicateReceipt = duplicate.passes[0].timestampNormalization;
    if (duplicateReceipt.method !== "audio-time-citations-v2") throw new Error("expected v2");
    duplicateReceipt.candidateA.expandedPointObservations.push(
      structuredClone(duplicateReceipt.candidateA.expandedPointObservations[0]!),
    );
    expect(() => validatePairwiseAudioJudgment(duplicate)).toThrow(
      "candidate A expanded points contains audio-a-output more than once",
    );

    const overlapping = structuredClone(judgment);
    const overlappingReceipt = overlapping.passes[0].timestampNormalization;
    if (overlappingReceipt.method !== "audio-time-citations-v2") throw new Error("expected v2");
    overlappingReceipt.candidateA.clampedEndObservations.push({
      observationId: "audio-a-output",
      originalStartMs: 400,
      originalEndMs: 1_006,
      normalizedStartMs: 400,
      normalizedEndMs: 1_000,
    });
    expect(() => validatePairwiseAudioJudgment(overlapping)).toThrow(
      "cannot be both point-expanded and end-clamped",
    );
  });

  test("checkpoints paid responses and replays them only for the exact bound input", async () => {
    const root = temporaryDirectory();
    const first = makeArtifact(root, "run-one", "product-alpha", 1, "not-a-secret");
    const second = makeArtifact(root, "run-two", "product-beta", 2, "not-a-secret");
    const checkpoints: PairwiseResponseCheckpoint[] = [];
    const live = new FakePairwiseClient();
    const original = await judgeArtifactPair({
      artifactDirectories: [first.directory, second.directory],
      responseClient: live,
      onResponseCheckpoint(checkpoint) {
        checkpoints.push(checkpoint);
      },
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]!.requestInputSha256).toBe(
      createHash("sha256").update(JSON.stringify(live.requests[0]!)).digest("hex"),
    );
    expect(original.passes[0].providerResponse).toEqual(
      checkpoints[0]!.response as Record<string, unknown>,
    );
    expect(original.passes[0].providerResponseSha256).toBe(
      createHash("sha256").update(JSON.stringify(checkpoints[0]!.response)).digest("hex"),
    );

    const path = join(root, "pass-1.response.json");
    writePairwiseResponseCheckpoint(path, checkpoints[0]!);
    expect(loadPairwiseResponseCheckpoint(path)).toEqual(checkpoints[0]!);

    const noNetwork = new ThrowingPairwiseClient();
    const replayed = await judgeArtifactPair({
      artifactDirectories: [first.directory, second.directory],
      responseClient: noNetwork,
      responseCheckpoints: [checkpoints[0], checkpoints[1]],
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });
    expect(noNetwork.calls).toBe(0);
    expect(replayed).toEqual(original);

    const keylessReplay = await judgeArtifactPair({
      artifactDirectories: [first.directory, second.directory],
      responseCheckpoints: [checkpoints[0], checkpoints[1]],
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });
    expect(keylessReplay).toEqual(original);

    const wrongInput = structuredClone(checkpoints[0]!);
    wrongInput.requestInputSha256 = "0".repeat(64);
    await expect(
      judgeArtifactPair({
        artifactDirectories: [first.directory, second.directory],
        responseClient: noNetwork,
        responseCheckpoints: [wrongInput, checkpoints[1]],
      }),
    ).rejects.toThrow("does not match pass 1 input");

    await expect(
      judgeArtifactPair({
        artifactDirectories: [first.directory, second.directory],
        responseCheckpoints: [checkpoints[0], checkpoints[1]],
        model: "entirely-different-model",
      }),
    ).rejects.toThrow("does not match pass 1 input");

    await expect(
      judgeArtifactPair({
        artifactDirectories: [first.directory, second.directory],
        responseCheckpoints: [checkpoints[0], checkpoints[1]],
        maxCompletionTokens: 1,
      }),
    ).rejects.toThrow("does not match pass 1 input");

    const currentCheckpoint = checkpoints[0]!;
    if (currentCheckpoint.protocolVersion === LEGACY_PAIRWISE_AUDIO_JUDGE_PROTOCOL_VERSION) {
      throw new Error("expected current checkpoint");
    }
    const { requestBindingVersion: _binding, ...legacyBase } = currentCheckpoint;
    const legacyCheckpoint: PairwiseResponseCheckpoint = {
      ...legacyBase,
      protocolVersion: LEGACY_PAIRWISE_AUDIO_JUDGE_PROTOCOL_VERSION,
    };
    await expect(
      judgeArtifactPair({
        artifactDirectories: [first.directory, second.directory],
        responseCheckpoints: [legacyCheckpoint, checkpoints[1]],
      }),
    ).rejects.toThrow("validation-only and cannot be replayed");
  });

  test("aggregates raw pass totals before rounding presentation fields", async () => {
    const root = temporaryDirectory();
    const first = makeArtifact(root, "run-one", "product-alpha", 1, "not-a-secret");
    const second = makeArtifact(root, "run-two", "product-beta", 2, "not-a-secret");
    const judgment = await judgeArtifactPair({
      artifactDirectories: [first.directory, second.directory],
      responseClient: new FakePairwiseClient(),
    });
    const passes = structuredClone(judgment.passes);
    const firstPassSubjectOneLabel = passes[0].labelMapping.A;
    expect(firstPassSubjectOneLabel).toBe("subject-1");
    const criterion = passes[0].assessment.criteria.find(
      (candidate) => candidate.id === "spoken_grounding_and_completeness",
    )!;
    criterion.candidateAScore = 3;
    const aggregate = aggregatePairwisePasses(passes);

    expect(aggregate.subjects[0]).toMatchObject({
      subjectId: "subject-1",
      passScores: [96.3, 100],
      score: 98.1,
    });
  });

  test("requires the isolated output to equal the conversation right channel", async () => {
    const root = temporaryDirectory();
    const first = makeArtifact(root, "run-one", "product-alpha", 1, "not-a-secret");
    const second = makeArtifact(root, "run-two", "product-beta", 2, "not-a-secret");
    const mismatched = Buffer.from(second.comparisonBytes);
    mismatched.writeInt16LE(3, 46);
    writeFileSync(join(second.directory, "comparison.wav"), mismatched);

    await expect(
      judgeArtifactPair({
        artifactDirectories: [first.directory, second.directory],
        responseClient: new FakePairwiseClient(),
      }),
    ).rejects.toThrow("right channel must equal output.wav sample-for-sample");
  });

  test("requires both PCM tracks to share an exact sample timeline", async () => {
    const root = temporaryDirectory();
    const first = makeArtifact(root, "run-one", "product-alpha", 1, "not-a-secret");
    const second = makeArtifact(root, "run-two", "product-beta", 2, "not-a-secret");
    writeFileSync(join(second.directory, "comparison.wav"), minimalWav(2, 2, 44_100));

    await expect(
      judgeArtifactPair({
        artifactDirectories: [first.directory, second.directory],
        responseClient: new FakePairwiseClient(),
      }),
    ).rejects.toThrow("identical sample rates and timeline lengths");
  });
});

class FakePairwiseClient implements PairwiseAudioResponseClient {
  readonly endpoint = "https://api.openai.com/v1/chat/completions?api_key=must-not-persist";
  readonly requests: OpenAIPairwiseAudioRequest[] = [];

  constructor(
    private readonly assessmentForPass: (index: number) => PairwiseAudioPassAssessment = (index) =>
      modelAssessment(index === 0 ? "A" : "B"),
  ) {}

  create(request: OpenAIPairwiseAudioRequest): Promise<unknown> {
    const index = this.requests.length;
    this.requests.push(request);
    return Promise.resolve({
      id: `chatcmpl_pairwise_${index + 1}`,
      model: "gpt-audio-1.5-snapshot",
      choices: [
        {
          // gpt-audio-1.5 currently reports stop even when it returns a forced function call.
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: `call_${index + 1}`,
                type: "function",
                function: {
                  name: "submit_audio_comparison",
                  arguments: JSON.stringify(this.assessmentForPass(index)),
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { audio_tokens: 80 },
        completion_tokens_details: { audio_tokens: 0 },
      },
    });
  }
}

class ThrowingPairwiseClient implements PairwiseAudioResponseClient {
  readonly endpoint = "https://api.openai.com/v1/chat/completions";
  calls = 0;

  create(): Promise<unknown> {
    this.calls++;
    throw new Error("network must not be used while replaying checkpoints");
  }
}

function modelAssessment(winner: "A" | "B"): PairwiseAudioPassAssessment {
  const scoreA = winner === "A" ? 4 : 3;
  const scoreB = winner === "B" ? 4 : 3;
  const preference = winner;
  const conversationCriteria = new Set([
    "full_duplex_interruption_handling",
    "conversational_flow_and_economy",
    "responsiveness_and_latency",
  ]);
  return {
    criteria: CRITERION_IDS.map((id) => {
      const suffix = id === "vocal_delivery" ? "output" : "conversation";
      const requiresAudio = id === "vocal_delivery" || conversationCriteria.has(id);
      return {
        id,
        candidateAScore: scoreA,
        candidateBScore: scoreB,
        preference,
        candidateAEvidenceIds: ["manifest:run-state"],
        candidateBEvidenceIds: ["manifest:run-state"],
        candidateAAudioObservationIds: requiresAudio ? [`audio-a-${suffix}`] : [],
        candidateBAudioObservationIds: requiresAudio ? [`audio-b-${suffix}`] : [],
        rationale: "The cited evidence and audio support the anchored comparison.",
      };
    }),
    audioObservations: [
      {
        id: "audio-a-output",
        candidate: "A",
        track: "isolated_output",
        startMs: 100,
        endMs: 200,
        dimensions: AUDIO_DIMENSION_IDS.filter((id) => id !== "interruption_recovery"),
        observation: "Candidate A's isolated voice is audible in this interval.",
      },
      {
        id: "audio-a-conversation",
        candidate: "A",
        track: "conversation",
        startMs: 300,
        endMs: 400,
        dimensions: ["interruption_recovery"],
        observation: "Candidate A's interruption recovery is audible in this interval.",
      },
      {
        id: "audio-b-output",
        candidate: "B",
        track: "isolated_output",
        startMs: 100,
        endMs: 200,
        dimensions: AUDIO_DIMENSION_IDS.filter((id) => id !== "interruption_recovery"),
        observation: "Candidate B's isolated voice is audible in this interval.",
      },
      {
        id: "audio-b-conversation",
        candidate: "B",
        track: "conversation",
        startMs: 300,
        endMs: 400,
        dimensions: ["interruption_recovery"],
        observation: "Candidate B's interruption recovery is audible in this interval.",
      },
    ],
    audioDimensions: AUDIO_DIMENSION_IDS.map((id) => {
      const suffix = id === "interruption_recovery" ? "conversation" : "output";
      return {
        id,
        candidateAScore: scoreA,
        candidateBScore: scoreB,
        preference,
        candidateAAudioObservationIds: [`audio-a-${suffix}`],
        candidateBAudioObservationIds: [`audio-b-${suffix}`],
        rationale: "The timestamped recordings support this audio dimension score.",
      };
    }),
    overallPreference: preference,
    summary: `Candidate ${winner} is stronger overall.`,
    candidateAStrengths: ["Candidate A has clear strengths."],
    candidateBStrengths: ["Candidate B has clear strengths."],
    tradeoffs: ["The candidates have different strengths."],
    limitations: ["Timestamps are approximate perceptual citations."],
    confidence: "high",
  };
}

function makeArtifact(
  root: string,
  name: string,
  contender: string,
  audioMarker: number,
  secret: string,
): { directory: string; outputBytes: Buffer; comparisonBytes: Buffer } {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  const outputBytes = minimalWav(audioMarker, 1);
  const comparisonBytes = minimalWav(audioMarker, 2);
  writeFileSync(join(directory, "output.wav"), outputBytes);
  writeFileSync(join(directory, "comparison.wav"), comparisonBytes);
  writeFileSync(
    join(directory, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      contender,
      status: "completed",
      failure: null,
      scenario: { id: "pairwise-test", description: "Compare a compact voice interaction." },
      runtime: { audioDurationMs: 1_000 },
      validation: { codexWorkTurnCount: 0, outputAudioOverlap: "confirmed" },
      quality: { workspaceScore: 1, workspacePassed: true },
      evidence: {
        events: "events.ndjson",
        inputAudio: null,
        outputAudio: "output.wav",
        comparisonAudio: "comparison.wav",
        workspacePatch: "workspace.patch",
        oracle: "oracle.json",
      },
    })}\n`,
  );
  writeFileSync(
    join(directory, "events.ndjson"),
    `${JSON.stringify({
      seq: 1,
      atMs: 100,
      source: "test",
      type: "output.transcript.done",
      data: { text: `Done safely. API key provided: ${secret}` },
    })}\n`,
  );
  writeFileSync(join(directory, "workspace.patch"), "+fixed = true\n");
  writeFileSync(
    join(directory, "oracle.json"),
    `${JSON.stringify({
      exitCode: 0,
      durationMs: 10,
      valid: true,
      validationError: null,
      score: 1,
      parsed: { checks: [{ name: "suite", passed: true, detail: "passed" }] },
    })}\n`,
  );
  return { directory, outputBytes, comparisonBytes };
}

function minimalWav(marker: number, channels: 1 | 2, sampleRate = 48_000): Buffer {
  const dataBytes = sampleRate * channels * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataBytes, 40);
  bytes.writeInt16LE(marker, 44 + (channels - 1) * 2);
  return bytes;
}

function audioPayloads(request: OpenAIPairwiseAudioRequest): string[] {
  return request.messages[1].content
    .filter((part) => part.type === "input_audio")
    .map((part) => part.input_audio.data);
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "agentvoice-pairwise-audio-"));
  temporaryDirectories.push(directory);
  return directory;
}
