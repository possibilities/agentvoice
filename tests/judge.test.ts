import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultJudgmentPath,
  type JudgeResponseClient,
  judgeArtifact,
  type OpenAIJudgeRequest,
  validateQualityJudgment,
  writeQualityJudgment,
} from "../src/judge.ts";
import { CRITERION_IDS } from "../src/judge-rubric.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("quality judge", () => {
  test("produces a blind, evidence-backed judgment separate from harness completion", async () => {
    const apiKey = "sk-proj-never-persist-this-secret-123456";
    const artifact = makeArtifact(apiKey);
    const client = new FakeResponseClient(apiKey);

    const judgment = await judgeArtifact({
      artifactDirectory: artifact,
      apiKey,
      model: "judge-model",
      reasoningEffort: "high",
      responseClient: client,
    });

    expect(judgment.subject).toMatchObject({
      contender: "codex-reference",
      scenarioId: "judge-test",
    });
    expect(judgment.deterministicHarness).toMatchObject({
      status: "completed",
      completed: true,
      workspaceOracle: { passed: true, score: 1 },
    });
    expect(judgment.quality).toMatchObject({
      score: 82.1,
      scoredWeight: 95,
      band: "strong",
    });
    expect(judgment.judge).toMatchObject({
      requestedModel: "judge-model",
      resolvedModel: "judge-model-snapshot",
      store: false,
      blindToContenderIdentity: true,
      audioBytesProvided: false,
      endpoint: "https://api.openai.com/v1/responses",
    });

    const requestText = JSON.stringify(client.request);
    expect(requestText).not.toContain(apiKey);
    expect(requestText).not.toContain("codex-reference");
    expect(requestText).not.toContain("appserver raw secret");
    expect(client.request?.store).toBe(false);
    expect(client.request?.text.format.strict).toBe(true);
    expect(
      client.request?.text.format.schema.properties.criteria.items.properties.evidenceIds.items
        .enum,
    ).toContain("manifest:run-state");
    expect(JSON.stringify(judgment)).not.toContain(apiKey);
  });

  test("revalidates score and writes a judgment only once", async () => {
    const artifact = makeArtifact("sk-proj-another-secret-123456789");
    const judgment = await judgeArtifact({
      artifactDirectory: artifact,
      responseClient: new FakeResponseClient("irrelevant"),
    });
    const tampered = structuredClone(judgment);
    tampered.quality.score = 1;
    expect(() => validateQualityJudgment(tampered)).toThrow("score must be 82.1");

    const output = join(artifact, "outside-run", "quality.json");
    writeQualityJudgment(output, judgment);
    expect(() => writeQualityJudgment(output, judgment)).toThrow();
  });

  test("places the default judgment beside, not inside, the immutable run", () => {
    expect(defaultJudgmentPath("/tmp/artifacts/run-123")).toBe(
      "/tmp/artifacts/judgments/run-123.quality.json",
    );
  });
});

class FakeResponseClient implements JudgeResponseClient {
  readonly endpoint: string;
  request: OpenAIJudgeRequest | null = null;

  constructor(secretInQuery: string) {
    this.endpoint = `https://api.openai.com/v1/responses?api_key=${secretInQuery}`;
  }

  create(request: OpenAIJudgeRequest): Promise<unknown> {
    this.request = request;
    return Promise.resolve({
      id: "resp_judge_test",
      model: "judge-model-snapshot",
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(modelJudgment()) }],
        },
      ],
      usage: { input_tokens: 1_000, output_tokens: 500, total_tokens: 1_500 },
    });
  }
}

function modelJudgment() {
  const scores: Record<(typeof CRITERION_IDS)[number], number | null> = {
    task_outcome: 4,
    instruction_and_steering_fidelity: 3,
    full_duplex_interruption_handling: 3,
    spoken_grounding_and_completeness: 4,
    conversational_flow_and_economy: 2,
    responsiveness_and_latency: 3,
    vocal_delivery: null,
  };
  return {
    criteria: CRITERION_IDS.map((id) => ({
      id,
      observability: id === "vocal_delivery" ? "not_observable" : "scored",
      score: scores[id],
      evidenceIds: id === "vocal_delivery" ? [] : ["manifest:run-state"],
      rationale:
        id === "vocal_delivery"
          ? "Audio bytes were not supplied."
          : "The cited artifact evidence supports this score.",
    })),
    summary: "The observable run is strong, while vocal delivery remains a manual-review item.",
    strengths: [
      { text: "The workspace result passed its oracle.", evidenceIds: ["oracle:summary"] },
    ],
    weaknesses: [
      { text: "The exchange contains some conversational friction.", evidenceIds: ["event:8"] },
    ],
    limitations: ["Audio bytes were not supplied, so vocal delivery was not scored."],
    confidence: "high",
  };
}

function makeArtifact(secret: string): string {
  const directory = mkdtempSync(join(tmpdir(), "agentvoice-judge-"));
  temporaryDirectories.push(directory);
  writeFileSync(
    join(directory, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      contender: "codex-reference",
      status: "completed",
      failure: null,
      scenario: { id: "judge-test", description: "Evaluate a compact coding conversation." },
      runtime: { audioDurationMs: 2_000 },
      validation: { outputAudioOverlap: "confirmed" },
      quality: { workspaceScore: 1, workspacePassed: true },
      evidence: {
        events: "events.ndjson",
        workspacePatch: "workspace.patch",
        oracle: "oracle.json",
        inputAudio: null,
        outputAudio: null,
        comparisonAudio: null,
      },
    })}\n`,
  );
  const events = [
    event(1, 0, "fixture.utterance", { id: "implement", transcript: "Fix it." }),
    event(2, 100, "input.audio.started", { id: "implement", durationMs: 200 }),
    event(3, 300, "input.audio.finished", { id: "implement" }),
    event(4, 400, "delegation.created", { text: "Fix it." }),
    event(5, 450, "output.audio.started"),
    event(6, 500, "orchestrator.turn.started", { status: "inProgress" }),
    event(7, 700, "orchestrator.turn.completed", { status: "completed" }),
    event(8, 800, "output.transcript.done", { text: "Fixed and tested." }),
    event(9, 900, "output.audio.idle"),
    event(10, 1_000, "appserver.rpc.in", { secret: "appserver raw secret" }),
  ];
  writeFileSync(
    join(directory, "events.ndjson"),
    `${events.map((value) => JSON.stringify(value)).join("\n")}\n`,
  );
  writeFileSync(join(directory, "workspace.patch"), `+token=${secret}\n+fixed = True\n`);
  writeFileSync(
    join(directory, "oracle.json"),
    `${JSON.stringify({
      exitCode: 0,
      durationMs: 20,
      valid: true,
      validationError: null,
      score: 1,
      parsed: { checks: [{ name: "tests", passed: true, detail: "all passed" }] },
    })}\n`,
  );
  return directory;
}

function event(seq: number, atMs: number, type: string, data: Record<string, unknown> = {}) {
  return { seq, atMs, source: "test", type, data };
}
