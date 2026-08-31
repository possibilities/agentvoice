import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_SIDECAR_SANDBOX_PROFILE } from "../src/app-server.ts";
import { validateCodpieceArtifact } from "../src/codpiece-artifact-validator-cli.ts";
import type { EventRecord, EventSource } from "../src/events.ts";
import { validateCodexFxRunEvents } from "../src/run-validation.ts";
import {
  VOICE_SIDECAR_WIRE_CONTRACT_VERSION,
  voiceSidecarWireContractSha256,
} from "../src/voice-sidecar-contract.ts";

const CANDIDATE_SHA = "1234567890abcdef1234567890abcdef12345678";
const UPSTREAM_SHA = "abcdef1234567890abcdef1234567890abcdef12";
const BINARY_VERSION = "codex-voice-sidecar 0.0.0";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Codpiece artifact validator CLI", () => {
  test("prints the stable AgentVoice wire-contract digest", async () => {
    const child = Bun.spawn(
      ["bun", "run", "src/codpiece-artifact-validator-cli.ts", "--print-contract-sha"],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe(voiceSidecarWireContractSha256());
    expect(stdout.trim()).toMatch(/^[a-f0-9]{64}$/);
  });

  test("accepts a completed native Codex-Fx artifact and returns Codpiece's JSON shape", async () => {
    const fixture = writeArtifactFixture();

    const receipt = await validateCodpieceArtifact({
      artifact: fixture.artifact,
      binary: fixture.binary,
      candidateSha: CANDIDATE_SHA,
    });

    expect(receipt).toEqual({
      schemaVersion: 1,
      status: "accepted",
      candidateSha: CANDIDATE_SHA,
      binarySha256: fixture.binarySha256,
      binaryVersion: BINARY_VERSION,
      wireContractSha256: voiceSidecarWireContractSha256(),
      artifact: {
        path: realpathSync(fixture.artifact),
        manifestSha256: sha256(readFileSync(join(fixture.artifact, "manifest.json"))),
        eventsSha256: sha256(readFileSync(join(fixture.artifact, "events.ndjson"))),
        scenarioSha256: sha256(readFileSync(join(fixture.artifact, "scenario.json"))),
        evaluationInputReceiptSha256: sha256(
          readFileSync(join(fixture.artifact, "evaluation-input-receipt.json")),
        ),
        comparisonWavSha256: sha256(readFileSync(join(fixture.artifact, "comparison.wav"))),
        inputWavSha256: sha256(readFileSync(join(fixture.artifact, "input.wav"))),
        outputWavSha256: sha256(readFileSync(join(fixture.artifact, "output.wav"))),
      },
    });
  });

  test("rejects artifacts whose native manifest is not accepted by strict validation", async () => {
    const fixture = writeArtifactFixture();
    const manifestPath = join(fixture.artifact, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.isolation.observedChildProcessCount = 1;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(
      validateCodpieceArtifact({
        artifact: fixture.artifact,
        binary: fixture.binary,
        candidateSha: CANDIDATE_SHA,
      }),
    ).rejects.toThrow("manifest isolation did not prove native no-fork execution");
  });
});

function writeArtifactFixture(): {
  root: string;
  artifact: string;
  binary: string;
  binarySha256: string;
} {
  const root = mkdtempSync(join(tmpdir(), "agentvoice-codpiece-validator-"));
  temporaryDirectories.push(root);
  const artifact = join(root, "artifact");
  const binaryDirectory = join(root, "binary");
  mkdirSync(artifact);
  mkdirSync(binaryDirectory);

  const binary = join(binaryDirectory, "codex-voice-sidecar");
  writeFileSync(binary, fakeBinaryProgram(), { mode: 0o700 });
  chmodSync(binary, 0o700);
  const binarySha256 = sha256(readFileSync(binary));
  const sidecarBuild = {
    schemaVersion: 2,
    implementation: "codex-voice-sidecar",
    sourceRepository: "possibilities/codex",
    sourceRevision: CANDIDATE_SHA,
    upstreamRevision: UPSTREAM_SHA,
    wireContractVersion: VOICE_SIDECAR_WIRE_CONTRACT_VERSION,
    wireContractSha256: voiceSidecarWireContractSha256(),
    builtAt: "2026-08-30T00:00:00Z",
    binarySha256,
    binaryVersion: BINARY_VERSION,
  };
  writeFileSync(
    join(binaryDirectory, "metadata.json"),
    `${JSON.stringify(sidecarBuild, null, 2)}\n`,
  );

  const events = validNativeCodexFxTrace();
  const validation = validateCodexFxRunEvents(events, "voice-thread", {
    implementationProfile: "native-voice-sidecar",
  });
  writeFileSync(
    join(artifact, "events.ndjson"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );

  const scenarioBytes = Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      id: "compact-full-duplex",
      description: "Synthetic validator fixture.",
      workspace: "workspace",
      steps: [{ type: "sleep", ms: 0 }],
      oracle: { command: ["python3", "oracle.py"], timeoutMs: 1_000 },
    })}\n`,
  );
  const oracleBytes = Buffer.from("print('ok')\n");
  writeFileSync(join(artifact, "scenario.json"), scenarioBytes);
  writeFileSync(join(artifact, "oracle.py"), oracleBytes);
  const evaluationInputs = {
    scenario: {
      artifact: "scenario.json",
      sha256: sha256(scenarioBytes),
      bytes: scenarioBytes.length,
    },
    oracle: {
      command: ["python3", "oracle.py"],
      files: [
        {
          argumentIndex: 1,
          commandValue: "oracle.py",
          artifact: "oracle.py",
          sha256: sha256(oracleBytes),
          bytes: oracleBytes.length,
        },
      ],
    },
  };
  writeFileSync(
    join(artifact, "evaluation-input-receipt.json"),
    `${JSON.stringify(evaluationInputs, null, 2)}\n`,
  );
  writeFileSync(join(artifact, "input.wav"), "input audio\n");
  writeFileSync(join(artifact, "output.wav"), "output audio\n");
  writeFileSync(join(artifact, "comparison.wav"), "comparison audio\n");

  const manifest = {
    schemaVersion: 1,
    contender: "codex-fx",
    status: "completed",
    failure: null,
    scenario: {
      id: "compact-full-duplex",
      path: "scenario.json",
      description: "Synthetic validator fixture.",
    },
    agent: {
      voiceProtocol: "v3",
      voiceModelSelection: "server-owned",
      requestedVoiceModel: null,
      voice: "cove",
      voiceModel: "gpt-live-1-codex",
      orchestratorModel: "gpt-5.6-terra",
      reasoningEffort: "medium",
      includeStartupContext: true,
      orchestratorImplementation: "fx-work-control",
    },
    implementationProfile: "native-voice-sidecar",
    isolation: nativeIsolationEvidence(),
    sidecarBuild,
    fxIdentity: {
      auth: "Codex subscription",
      modelSource: "Codex subscription",
      permissionMode: "yolo",
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    },
    fixtureAudio: { provenance: {}, utterances: [] },
    evaluationInputs,
    runtime: {
      harnessVersion: "0.1.0",
      appServerVersion: BINARY_VERSION,
      startedAt: "2026-08-30T00:00:00Z",
      finishedAt: "2026-08-30T00:00:01Z",
      audioDurationMs: 1_000,
      voiceThreadId: "voice-thread",
      realtimeSessionId: "realtime-session",
      advertisedVoices: null,
    },
    validation,
    quality: {
      workspaceScore: 1,
      workspacePassed: true,
    },
    evidence: {
      events: "events.ndjson",
      inputAudio: "input.wav",
      outputAudio: "output.wav",
      comparisonAudio: "comparison.wav",
      fixtureAudioReceipt: "fixture-audio-receipt.json",
      evaluationInputReceipt: "evaluation-input-receipt.json",
      scenario: "scenario.json",
      oracleInputs: ["oracle.py"],
      workspacePatch: "workspace.patch",
      oracle: "oracle.json",
      appServerStderr: "app-server.stderr.log",
      fxTerminal: "fx-terminal.log",
      fxStderr: "fx-stderr.log",
    },
  };
  writeFileSync(join(artifact, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, artifact, binary, binarySha256 };
}

function fakeBinaryProgram(): string {
  return `#!/usr/bin/env bun
if (Bun.argv.includes("--version")) {
  console.log(${JSON.stringify(BINARY_VERSION)});
  process.exit(0);
}
process.exit(2);
`;
}

function validNativeCodexFxTrace(): EventRecord[] {
  return resequence([
    event("sidecar.isolation.started", nativeIsolationEvidence(), "app-server"),
    ...nativeConsumedWireEvents(),
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
    event("voice.thread.started", { threadId: "voice-thread" }, "app-server"),
    event(
      "voice.session.started",
      { rawType: "session.started", model: null, voice: null },
      "realtime",
    ),
    event("delegation.created", { id: "raw-1", target: "client", text: "diagnose" }, "realtime"),
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
    event("delegation.created", { id: "raw-2", target: "client", text: "implement" }, "realtime"),
    forwarded("raw-2", "handoff-2", "implement"),
    admitted("raw-2", "handoff-2", "implement", "42", "queued", null),
    ...fxTurnStarted("42", 4),
    ...handoffAppend("handoff-2", "progress"),
    event("output.audio.started", {}, "media"),
    event("input.audio.started", { id: "steer", startSample: 1_000 }, "media"),
    event("delegation.created", { id: "raw-3", target: "client", text: "steer" }, "realtime"),
    forwarded("raw-3", "handoff-3", "steer"),
    admitted("raw-3", "handoff-3", "steer", "steer-1", "steering", "42"),
    ...handoffAppend("handoff-3", "progress"),
    event("delegation.steered", { delegationTurnId: "steer-1", activeTurnId: "42" }, "bridge"),
    event("input.audio.finished", { id: "steer", startSample: 1_000, endSample: 2_000 }, "media"),
    event("output.audio.idle", {}, "media"),
    ...fxTurnCompleted("42", 6),
    event(
      "delegation.completed",
      { delegationTurnId: "42", turnId: "42", outcome: "completed" },
      "bridge",
    ),
    ...handoffAppend("handoff-2", "result"),
    event("delegation.created", { id: "raw-4", target: "client", text: "verify" }, "realtime"),
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
    event("scenario.completed", {}, "harness"),
    event("bridge.closed", {}, "bridge"),
    event("session.closed", {}, "harness"),
    event(
      "audio.overlap.measured",
      {
        inputId: "steer",
        sampleRate: 48_000,
        windowSamples: 960,
        resolutionSamples: 48,
        inputStartSample: 1_000,
        inputEndSample: 2_000,
        overlappingWindowCount: 1,
        overlappingSampleCount: 960,
        overlapDurationMs: 20,
      },
      "media",
    ),
    event("fx.stopped", {}, "fx"),
    event("sidecar.isolation.completed", nativeIsolationEvidence(), "app-server"),
  ]);
}

function nativeConsumedWireEvents(): EventRecord[] {
  return readFileSync(
    new URL("../fixtures/codex-voice-sidecar/native-consumed-wire.ndjson", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const record = JSON.parse(line) as {
        direction: "in" | "out";
        message: Record<string, unknown>;
      };
      return event(
        `appserver.rpc.${record.direction}`,
        replaceWirePlaceholders(record.message) as Record<string, unknown>,
        "app-server",
      );
    });
}

function replaceWirePlaceholders(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceWirePlaceholders(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceWirePlaceholders(item)]),
    );
  }
  switch (value) {
    case "$thread":
      return "voice-thread";
    case "$session":
      return "realtime-session";
    case "$workspace":
      return "/tmp/agentvoice-workspace";
    case "$codex-home":
      return "/tmp/codex-home";
    case "$offer-sdp":
      return "offer-sdp";
    case "$answer-sdp":
      return "answer-sdp";
    default:
      return value;
  }
}

function nativeIsolationEvidence(): Record<string, unknown> {
  return {
    implementationProfile: "native-voice-sidecar",
    platform: "darwin",
    childProcessPolicy: "kernel-deny-fork",
    sandboxExecutable: "/usr/bin/sandbox-exec",
    sandboxProfileSha256: createHash("sha256").update(NATIVE_SIDECAR_SANDBOX_PROFILE).digest("hex"),
    childObservation: "ps-descendant-sampling",
    childObservationErrorCount: 0,
    observedChildProcessCount: 0,
  };
}

function event(type: string, data: Record<string, unknown>, source: EventSource): EventRecord {
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
      { turnId, status: "completed", outcome: "completed", error: null, adeSequence },
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

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
