import { describe, expect, test } from "bun:test";
import {
  CRITERION_IDS,
  scoreModelJudgment,
  validateQualityAssessment,
} from "../src/judge-rubric.ts";

describe("quality judge rubric", () => {
  test("computes the aggregate locally and renormalizes unobservable audio", () => {
    const quality = scoreModelJudgment(perfectTextJudgment(), new Set(["evidence:1"]));

    expect(quality.score).toBe(100);
    expect(quality.scoredWeight).toBe(95);
    expect(quality.totalWeight).toBe(100);
    expect(quality.band).toBe("excellent");
    expect(quality.criteria.at(-1)).toMatchObject({
      id: "vocal_delivery",
      observability: "not_observable",
      score: null,
      weightedPoints: 0,
    });
  });

  test("rejects unknown evidence, duplicate criteria, and scoring absent audio", () => {
    const unknownEvidence = perfectTextJudgment();
    unknownEvidence.criteria[0]!.evidenceIds = ["invented"];
    expect(() => scoreModelJudgment(unknownEvidence, new Set(["evidence:1"]))).toThrow(
      "unknown evidence ID invented",
    );

    const duplicate = perfectTextJudgment();
    duplicate.criteria[1]!.id = "task_outcome";
    expect(() => scoreModelJudgment(duplicate, new Set(["evidence:1"]))).toThrow(
      "appears more than once",
    );

    const scoredAudio = perfectTextJudgment();
    scoredAudio.criteria.at(-1)!.observability = "scored";
    scoredAudio.criteria.at(-1)!.score = 4;
    scoredAudio.criteria.at(-1)!.evidenceIds = ["evidence:1"];
    expect(() => scoreModelJudgment(scoredAudio, new Set(["evidence:1"]))).toThrow(
      "vocal_delivery must be not_observable",
    );
  });

  test("rejects a persisted score that does not match criterion scores", () => {
    const quality = scoreModelJudgment(perfectTextJudgment(), new Set(["evidence:1"]));
    const tampered = structuredClone(quality);
    tampered.score = 12.3;

    expect(() => validateQualityAssessment(tampered)).toThrow("score must be 100");
  });
});

function perfectTextJudgment() {
  return {
    criteria: CRITERION_IDS.map((id) =>
      id === "vocal_delivery"
        ? {
            id,
            observability: "not_observable" as const,
            score: null,
            evidenceIds: [],
            rationale: "Audio bytes were not supplied.",
          }
        : {
            id,
            observability: "scored" as const,
            score: 4,
            evidenceIds: ["evidence:1"],
            rationale: "The cited evidence fully supports this criterion.",
          },
    ),
    summary: "The observable interaction is exemplary.",
    strengths: [{ text: "The result is grounded.", evidenceIds: ["evidence:1"] }],
    weaknesses: [],
    limitations: ["Audio bytes were not supplied."],
    confidence: "high" as const,
  };
}
