import { z } from "zod";

export const JUDGE_RUBRIC_VERSION = "compact-full-duplex-v1" as const;

export const CRITERION_IDS = [
  "task_outcome",
  "instruction_and_steering_fidelity",
  "full_duplex_interruption_handling",
  "spoken_grounding_and_completeness",
  "conversational_flow_and_economy",
  "responsiveness_and_latency",
  "vocal_delivery",
] as const;

export type CriterionId = (typeof CRITERION_IDS)[number];

export interface RubricCriterion {
  id: CriterionId;
  title: string;
  weight: number;
  description: string;
  anchors: {
    0: string;
    2: string;
    4: string;
  };
}

export const JUDGE_RUBRIC: readonly RubricCriterion[] = [
  {
    id: "task_outcome",
    title: "Task outcome",
    weight: 22,
    description:
      "Whether the orchestrator's diagnosis, code change, and verification solve the requested problem without regressions. Deterministic oracle evidence is relevant, but harness completion alone does not earn quality credit.",
    anchors: {
      0: "The requested task is not completed or the result is materially wrong.",
      2: "The core task is partly correct, with meaningful omissions, weak verification, or regressions.",
      4: "The result fully satisfies the task, preserves constraints, and is convincingly verified.",
    },
  },
  {
    id: "instruction_and_steering_fidelity",
    title: "Instruction and steering fidelity",
    weight: 20,
    description:
      "Whether initial instructions and the mid-work steering constraint are recognized, delegated, and reflected in the result without being lost or distorted.",
    anchors: {
      0: "Important instructions or steering are ignored or contradicted.",
      2: "The main intent is followed, but some explicit detail is lost, delayed, or only partially reflected.",
      4: "Every material instruction, including steering delivered during work, is promptly and exactly incorporated.",
    },
  },
  {
    id: "full_duplex_interruption_handling",
    title: "Full-duplex interruption handling",
    weight: 18,
    description:
      "Whether the agent remains usable when the evaluator speaks over active output: it should stop or adapt cleanly, preserve the new constraint, steer the in-flight work when appropriate, and resume coherently.",
    anchors: {
      0: "The interruption is missed, corrupts the interaction, or becomes an unrelated later turn.",
      2: "The interruption is processed, but handling is awkward, delayed, repetitive, or only partly integrated.",
      4: "The interruption is handled immediately and naturally, with correct in-flight steering and a coherent continuation.",
    },
  },
  {
    id: "spoken_grounding_and_completeness",
    title: "Spoken grounding and completeness",
    weight: 15,
    description:
      "Whether spoken progress and final reports are accurate, supported by workspace and test evidence, and cover the behavior change, tests run, and requested residual risk.",
    anchors: {
      0: "Spoken claims are materially false, unsupported, or omit the requested report.",
      2: "The report is broadly correct but vague, incomplete, or contains a meaningful unsupported claim.",
      4: "Progress and final speech are concise, complete, and precisely grounded in the observed work and verification.",
    },
  },
  {
    id: "conversational_flow_and_economy",
    title: "Conversational flow and economy",
    weight: 10,
    description:
      "Whether acknowledgements, progress updates, and summaries form a natural conversation without needless echoing, repeated setup, confusing fragments, or excessive narration.",
    anchors: {
      0: "The conversation is confusing, highly repetitive, or unusably verbose.",
      2: "The exchange is understandable but has noticeable repetition, awkward transitions, or unnecessary narration.",
      4: "The exchange is consistently natural, economical, well-paced, and easy to follow.",
    },
  },
  {
    id: "responsiveness_and_latency",
    title: "Responsiveness and latency",
    weight: 10,
    description:
      "Whether acknowledgements, delegations, interruption uptake, and useful spoken results arrive promptly relative to the evaluator's utterances and the underlying work.",
    anchors: {
      0: "Long unexplained delays or late reactions make the agent impractical.",
      2: "Responsiveness is usable but has one or more conspicuous delays or poorly timed updates.",
      4: "Reactions and updates are consistently prompt, well-timed, and appropriate to work duration.",
    },
  },
  {
    id: "vocal_delivery",
    title: "Vocal delivery",
    weight: 5,
    description:
      "Naturalness, intelligibility, prosody, pronunciation, artifacts, clipping, and audible truncation in the rendered agent speech. This criterion must be not_observable when the judge receives no audio bytes.",
    anchors: {
      0: "Speech is frequently unintelligible, badly clipped, or conspicuously synthetic.",
      2: "Speech is intelligible but has noticeable delivery, pronunciation, or audio-quality defects.",
      4: "Speech is natural, clear, expressive, artifact-free, and appropriately paced throughout.",
    },
  },
] as const;

const TOTAL_RUBRIC_WEIGHT = JUDGE_RUBRIC.reduce((total, criterion) => total + criterion.weight, 0);
if (TOTAL_RUBRIC_WEIGHT !== 100) {
  throw new Error(`quality rubric weights must total 100; got ${TOTAL_RUBRIC_WEIGHT}`);
}

const criterionIdSchema = z.enum(CRITERION_IDS);
const evidenceIdSchema = z.string().min(1).max(160);

export const modelCriterionAssessmentSchema = z
  .object({
    id: criterionIdSchema,
    observability: z.enum(["scored", "not_observable"]),
    score: z.number().int().min(0).max(4).nullable(),
    evidenceIds: z.array(evidenceIdSchema).max(6),
    rationale: z.string().min(1).max(1_200),
  })
  .strict();

const modelFindingSchema = z
  .object({
    text: z.string().min(1).max(600),
    evidenceIds: z.array(evidenceIdSchema).min(1).max(5),
  })
  .strict();

export const modelJudgmentSchema = z
  .object({
    criteria: z.array(modelCriterionAssessmentSchema).length(CRITERION_IDS.length),
    summary: z.string().min(1).max(1_500),
    strengths: z.array(modelFindingSchema).max(4),
    weaknesses: z.array(modelFindingSchema).max(4),
    limitations: z.array(z.string().min(1).max(600)).min(1).max(6),
    confidence: z.enum(["low", "medium", "high"]),
  })
  .strict();

export type ModelJudgment = z.infer<typeof modelJudgmentSchema>;

const scoredCriterionSchema = modelCriterionAssessmentSchema.extend({
  title: z.string().min(1),
  weight: z.number().int().positive(),
  weightedPoints: z.number().min(0),
});

export const qualityAssessmentSchema = z
  .object({
    score: z.number().min(0).max(100).nullable(),
    scoreScale: z.literal("0-100"),
    scoredWeight: z.number().int().min(0).max(100),
    totalWeight: z.literal(100),
    band: z.enum(["excellent", "strong", "mixed", "weak", "unjudgeable"]),
    criteria: z.array(scoredCriterionSchema).length(CRITERION_IDS.length),
    summary: z.string().min(1).max(1_500),
    strengths: z.array(modelFindingSchema).max(4),
    weaknesses: z.array(modelFindingSchema).max(4),
    limitations: z.array(z.string().min(1).max(600)).min(1).max(6),
    confidence: z.enum(["low", "medium", "high"]),
  })
  .strict();

export type QualityAssessment = z.infer<typeof qualityAssessmentSchema>;

export class JudgeValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`quality judgment validation failed:\n- ${issues.join("\n- ")}`);
    this.name = "JudgeValidationError";
    this.issues = issues;
  }
}

/**
 * Validates the model's structured assessment and computes its aggregate.
 * The model never supplies the total score, weights, or quality band.
 */
export function scoreModelJudgment(
  value: unknown,
  validEvidenceIds: ReadonlySet<string>,
): QualityAssessment {
  const parsed = modelJudgmentSchema.safeParse(value);
  if (!parsed.success) {
    throw new JudgeValidationError(parsed.error.issues.map((issue) => issue.message));
  }

  const issues: string[] = [];
  const byId = new Map<CriterionId, ModelJudgment["criteria"][number]>();
  for (const assessment of parsed.data.criteria) {
    if (byId.has(assessment.id)) issues.push(`criterion ${assessment.id} appears more than once`);
    byId.set(assessment.id, assessment);
    validateObservability(assessment, issues);
    validateEvidenceIds(
      assessment.evidenceIds,
      validEvidenceIds,
      `criterion ${assessment.id}`,
      issues,
    );
  }
  for (const criterion of JUDGE_RUBRIC) {
    if (!byId.has(criterion.id)) issues.push(`criterion ${criterion.id} is missing`);
  }
  for (const [kind, findings] of [
    ["strength", parsed.data.strengths],
    ["weakness", parsed.data.weaknesses],
  ] as const) {
    for (const [index, finding] of findings.entries()) {
      validateEvidenceIds(finding.evidenceIds, validEvidenceIds, `${kind} ${index + 1}`, issues);
    }
  }

  const vocalDelivery = byId.get("vocal_delivery");
  if (vocalDelivery?.observability !== "not_observable") {
    issues.push("vocal_delivery must be not_observable because this judge receives no audio bytes");
  }
  if (issues.length > 0) throw new JudgeValidationError(issues);

  let scoredWeight = 0;
  let weightedPoints = 0;
  const criteria = JUDGE_RUBRIC.map((rubricCriterion) => {
    const assessment = byId.get(rubricCriterion.id)!;
    const criterionPoints =
      assessment.observability === "scored" && assessment.score !== null
        ? round((assessment.score / 4) * rubricCriterion.weight, 4)
        : 0;
    if (assessment.observability === "scored") {
      scoredWeight += rubricCriterion.weight;
      weightedPoints += criterionPoints;
    }
    return {
      ...assessment,
      title: rubricCriterion.title,
      weight: rubricCriterion.weight,
      weightedPoints: criterionPoints,
    };
  });

  const score = scoredWeight === 0 ? null : round((weightedPoints / scoredWeight) * 100, 1);
  const assessment: QualityAssessment = {
    score,
    scoreScale: "0-100",
    scoredWeight,
    totalWeight: 100,
    band: qualityBand(score, scoredWeight),
    criteria,
    summary: parsed.data.summary,
    strengths: parsed.data.strengths,
    weaknesses: parsed.data.weaknesses,
    limitations: parsed.data.limitations,
    confidence: parsed.data.confidence,
  };
  return validateQualityAssessment(assessment);
}

/** Revalidates persisted output and rejects a tampered or stale aggregate. */
export function validateQualityAssessment(value: unknown): QualityAssessment {
  const parsed = qualityAssessmentSchema.safeParse(value);
  if (!parsed.success) {
    throw new JudgeValidationError(parsed.error.issues.map((issue) => issue.message));
  }
  const issues: string[] = [];
  let scoredWeight = 0;
  let weightedPoints = 0;
  const seen = new Set<CriterionId>();

  for (const [index, rubricCriterion] of JUDGE_RUBRIC.entries()) {
    const criterion = parsed.data.criteria[index];
    if (!criterion) continue;
    if (criterion.id !== rubricCriterion.id) {
      issues.push(`criterion ${index + 1} must be ${rubricCriterion.id}; got ${criterion.id}`);
    }
    if (seen.has(criterion.id)) issues.push(`criterion ${criterion.id} appears more than once`);
    seen.add(criterion.id);
    if (criterion.title !== rubricCriterion.title) {
      issues.push(`criterion ${criterion.id} has an unexpected title`);
    }
    if (criterion.weight !== rubricCriterion.weight) {
      issues.push(
        `criterion ${criterion.id} weight must be ${rubricCriterion.weight}; got ${criterion.weight}`,
      );
    }
    validateObservability(criterion, issues);
    const expectedPoints =
      criterion.observability === "scored" && criterion.score !== null
        ? round((criterion.score / 4) * criterion.weight, 4)
        : 0;
    if (!nearlyEqual(criterion.weightedPoints, expectedPoints)) {
      issues.push(
        `criterion ${criterion.id} weightedPoints must be ${expectedPoints}; got ${criterion.weightedPoints}`,
      );
    }
    if (criterion.observability === "scored") {
      scoredWeight += criterion.weight;
      weightedPoints += expectedPoints;
    }
  }

  const expectedScore = scoredWeight === 0 ? null : round((weightedPoints / scoredWeight) * 100, 1);
  if (parsed.data.scoredWeight !== scoredWeight) {
    issues.push(`scoredWeight must be ${scoredWeight}; got ${parsed.data.scoredWeight}`);
  }
  if (
    (expectedScore === null && parsed.data.score !== null) ||
    (expectedScore !== null &&
      (parsed.data.score === null || !nearlyEqual(parsed.data.score, expectedScore)))
  ) {
    issues.push(`score must be ${expectedScore}; got ${parsed.data.score}`);
  }
  const expectedBand = qualityBand(expectedScore, scoredWeight);
  if (parsed.data.band !== expectedBand) {
    issues.push(`band must be ${expectedBand}; got ${parsed.data.band}`);
  }

  if (issues.length > 0) throw new JudgeValidationError(issues);
  return parsed.data;
}

export function buildModelJudgmentJsonSchema(validEvidenceIds: readonly string[]) {
  if (validEvidenceIds.length === 0) {
    throw new Error("the judge requires at least one evidence item");
  }
  const evidenceIds = {
    type: "array",
    items: { type: "string", enum: [...validEvidenceIds] },
    maxItems: 6,
  } as const;
  const finding = {
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string" },
      evidenceIds: { ...evidenceIds, minItems: 1, maxItems: 5 },
    },
    required: ["text", "evidenceIds"],
  } as const;

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      criteria: {
        type: "array",
        minItems: CRITERION_IDS.length,
        maxItems: CRITERION_IDS.length,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", enum: [...CRITERION_IDS] },
            observability: { type: "string", enum: ["scored", "not_observable"] },
            score: {
              anyOf: [{ type: "integer", minimum: 0, maximum: 4 }, { type: "null" }],
            },
            evidenceIds,
            rationale: { type: "string" },
          },
          required: ["id", "observability", "score", "evidenceIds", "rationale"],
        },
      },
      summary: { type: "string" },
      strengths: { type: "array", items: finding, maxItems: 4 },
      weaknesses: { type: "array", items: finding, maxItems: 4 },
      limitations: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 6,
      },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
    },
    required: ["criteria", "summary", "strengths", "weaknesses", "limitations", "confidence"],
  } as const;
}

function validateObservability(
  assessment: Pick<
    ModelJudgment["criteria"][number],
    "id" | "observability" | "score" | "evidenceIds"
  >,
  issues: string[],
): void {
  if (assessment.observability === "scored") {
    if (assessment.score === null)
      issues.push(`criterion ${assessment.id} is scored but has no score`);
    if (assessment.evidenceIds.length === 0) {
      issues.push(`criterion ${assessment.id} is scored but cites no evidence`);
    }
  } else if (assessment.score !== null) {
    issues.push(`criterion ${assessment.id} is not observable but has score ${assessment.score}`);
  }
}

function validateEvidenceIds(
  evidenceIds: readonly string[],
  validEvidenceIds: ReadonlySet<string>,
  label: string,
  issues: string[],
): void {
  const seen = new Set<string>();
  for (const id of evidenceIds) {
    if (!validEvidenceIds.has(id)) issues.push(`${label} cites unknown evidence ID ${id}`);
    if (seen.has(id)) issues.push(`${label} cites evidence ID ${id} more than once`);
    seen.add(id);
  }
}

function qualityBand(score: number | null, scoredWeight: number): QualityAssessment["band"] {
  if (score === null || scoredWeight < 60) return "unjudgeable";
  if (score >= 90) return "excellent";
  if (score >= 75) return "strong";
  if (score >= 50) return "mixed";
  return "weak";
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-6;
}
