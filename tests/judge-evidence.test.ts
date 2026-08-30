import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadJudgeEvidence, redactSecrets } from "../src/judge-evidence.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("judge evidence", () => {
  test("allowlists canonical evidence and redacts credentials", () => {
    const secret = "sk-proj-super-secret-value-123456789";
    const artifact = makeArtifact(secret);
    const evidence = loadJudgeEvidence(artifact, { secrets: [secret] });
    const serialized = JSON.stringify(evidence);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(secret.slice(0, 5));
    expect(serialized).not.toContain("RAW_EVENT_MUST_NOT_REACH_JUDGE");
    expect(serialized).toContain("[REDACTED");
    expect(evidence.catalog.map((item) => item.id)).toContain("event:1");
    expect(evidence.catalog.map((item) => item.id)).toContain("derived:interaction-summary");
    expect(evidence.catalog.map((item) => item.id)).toContain("workspace-patch:1");
    expect(evidence.deterministicHarness).toMatchObject({
      status: "completed",
      completed: true,
      traceValidation: "passed",
      workspaceOracle: { passed: true, score: 1 },
    });
  });

  test("rejects manifest evidence paths outside the artifact", () => {
    const artifact = makeArtifact("not-a-secret");
    const manifestPath = join(artifact, "manifest.json");
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...baseManifest(), evidence: { ...baseManifest().evidence, events: "../events.ndjson" } })}\n`,
    );

    expect(() => loadJudgeEvidence(artifact)).toThrow("escapes its directory");
  });

  test("redacts the partially masked key shape returned by API errors", () => {
    const message =
      "Incorrect API key provided: 1ca1256a****************************************************0dbc.";
    const redacted = redactSecrets(message);

    expect(redacted).toBe("Incorrect API key provided: [REDACTED_SECRET].");
    expect(redacted).not.toContain("1ca1256a");
    expect(redacted).not.toContain("0dbc");
  });
});

function makeArtifact(secret: string): string {
  const directory = mkdtempSync(join(tmpdir(), "agentvoice-judge-evidence-"));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, "nested"), { recursive: true });
  writeFileSync(join(directory, "manifest.json"), `${JSON.stringify(baseManifest())}\n`);
  const events = [
    event(1, 0, "fixture.utterance", {
      id: "steer",
      transcript: `Keep working. OPENAI_API_KEY=${secret}`,
    }),
    event(2, 1, "appserver.rpc.in", {
      payload: `RAW_EVENT_MUST_NOT_REACH_JUDGE ${secret}`,
    }),
    event(3, 100, "input.audio.started", { id: "steer", durationMs: 200 }),
    event(4, 300, "input.audio.finished", { id: "steer" }),
    event(5, 450, "delegation.created", { text: "Keep working." }),
    event(6, 150, "output.audio.started"),
    event(7, 350, "output.audio.idle"),
    event(8, 500, "orchestrator.turn.started", { status: "inProgress" }),
    event(9, 700, "orchestrator.turn.completed", { status: "completed", error: null }),
    event(10, 750, "output.transcript.done", { text: "Implemented and verified." }),
    event(11, 800, "output.transcript.done", {
      text: `${"x".repeat(7_995)}${secret}`,
    }),
  ];
  writeFileSync(
    join(directory, "events.ndjson"),
    `${events.map((value) => JSON.stringify(value)).join("\n")}\n`,
  );
  writeFileSync(
    join(directory, "oracle.json"),
    `${JSON.stringify({
      exitCode: 0,
      durationMs: 10,
      valid: true,
      validationError: null,
      score: 1,
      parsed: {
        checks: [{ name: "suite", passed: true, detail: "all tests passed" }],
      },
    })}\n`,
  );
  writeFileSync(join(directory, "workspace.patch"), `+OPENAI_API_KEY=${secret}\n+fixed = True\n`);
  writeFileSync(join(directory, "input.wav"), "input");
  writeFileSync(join(directory, "output.wav"), "output");
  writeFileSync(join(directory, "comparison.wav"), "comparison");
  return directory;
}

function baseManifest() {
  return {
    schemaVersion: 1,
    contender: "anonymous-test-contender",
    status: "completed",
    failure: null,
    scenario: { id: "test-scenario", description: "A test scenario." },
    runtime: { audioDurationMs: 1_000 },
    validation: { outputAudioOverlap: "confirmed", rootThreadId: "opaque-id" },
    quality: { workspaceScore: 1, workspacePassed: true },
    evidence: {
      events: "events.ndjson",
      inputAudio: "input.wav",
      outputAudio: "output.wav",
      comparisonAudio: "comparison.wav",
      workspacePatch: "workspace.patch",
      oracle: "oracle.json",
    },
  };
}

function event(seq: number, atMs: number, type: string, data: Record<string, unknown> = {}) {
  return { seq, atMs, source: "test", type, data };
}
