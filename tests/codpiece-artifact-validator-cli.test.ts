import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NATIVE_SIDECAR_SANDBOX_PROFILE } from "../src/app-server.ts";
import {
  AUDIO_FRAME_SAMPLES,
  AUDIO_SAMPLE_RATE,
  type AudibleOverlapMeasurement,
  measureAudiblePcmOverlap,
  wavBuffer,
} from "../src/audio.ts";
import { validateCodpieceArtifact } from "../src/codpiece-artifact-validator-cli.ts";
import type { EventRecord, EventSource } from "../src/events.ts";
import { loadVerifiedFixtureAudio, type VerifiedFixtureAudio } from "../src/fixture-audio.ts";
import { validateCodexFxRunEvents } from "../src/run-validation.ts";
import type { Scenario } from "../src/scenario.ts";
import {
  VOICE_SIDECAR_WIRE_CONTRACT_VERSION,
  voiceSidecarWireContractSha256,
} from "../src/voice-sidecar-contract.ts";

const CANDIDATE_SHA = "1234567890abcdef1234567890abcdef12345678";
const UPSTREAM_SHA = "abcdef1234567890abcdef1234567890abcdef12";
const BINARY_VERSION = "codex-voice-sidecar 0.0.0";
const CANONICAL_FIXTURE_ROOT = resolve(import.meta.dir, "..", "fixtures", "compact-full-duplex");
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
    const fixture = await writeArtifactFixture();

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
        declaredEvidenceSha256: expectedDeclaredEvidenceSha256(fixture.artifact),
      },
    });
  });

  test("rejects schema 2 parity metadata as lacking Fx credential authority", async () => {
    const fixture = await writeArtifactFixture();
    const metadataPath = join(fixture.root, "binary", "metadata.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    metadata.schemaVersion = 2;
    delete metadata.credentialAuthority;
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    await expect(validateFixture(fixture)).rejects.toThrow(
      "schemaVersion 2 did not match required 3",
    );
  });

  test("rejects artifacts whose native manifest is not accepted by strict validation", async () => {
    const fixture = await writeArtifactFixture();
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

  test("rejects missing declared evidence files", async () => {
    const fixture = await writeArtifactFixture();
    rmSync(join(fixture.artifact, "fx-stderr.log"));

    await expect(validateFixture(fixture)).rejects.toThrow(
      "manifest evidence fxStderr does not exist",
    );
  });

  test("rejects an incomplete declared evidence inventory", async () => {
    const fixture = await writeArtifactFixture();
    const manifestPath = join(fixture.artifact, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.evidence.fxTerminal;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(validateFixture(fixture)).rejects.toThrow(
      "manifest evidence fxTerminal must declare exactly one Fx terminal log file",
    );
  });

  test("rejects declared evidence paths with symlinked parent components", async () => {
    const fixture = await writeArtifactFixture();
    symlinkSync(".", join(fixture.artifact, "linked"));
    const manifestPath = join(fixture.artifact, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.evidence.fxTerminal = "linked/fx-terminal.log";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(validateFixture(fixture)).rejects.toThrow(
      "manifest evidence fxTerminal path component linked must not be a symbolic link",
    );
  });

  test("rejects event files that are not in seq order", async () => {
    const fixture = await writeArtifactFixture();
    const eventsPath = join(fixture.artifact, "events.ndjson");
    const events = readEvents(eventsPath);
    events[0]!.seq = 2;
    writeEvents(eventsPath, events);

    await expect(validateFixture(fixture)).rejects.toThrow(
      "events line 1 seq 2 did not match expected 1",
    );
  });

  test("rejects event files whose atMs moves backward", async () => {
    const fixture = await writeArtifactFixture();
    const eventsPath = join(fixture.artifact, "events.ndjson");
    const events = readEvents(eventsPath);
    events[1]!.atMs = -1;
    writeEvents(eventsPath, events);

    await expect(validateFixture(fixture)).rejects.toThrow(
      "events line 2 is not an AgentVoice event",
    );

    const monotonic = await writeArtifactFixture();
    const monotonicEventsPath = join(monotonic.artifact, "events.ndjson");
    const monotonicEvents = readEvents(monotonicEventsPath);
    monotonicEvents[2]!.atMs = monotonicEvents[1]!.atMs - 0.5;
    writeEvents(monotonicEventsPath, monotonicEvents);

    await expect(validateFixture(monotonic)).rejects.toThrow("events line 3 atMs");
  });

  test("rejects oracle evidence that did not pass with score 1", async () => {
    const fixture = await writeArtifactFixture();
    const oraclePath = join(fixture.artifact, "oracle.json");
    const oracle = JSON.parse(readFileSync(oraclePath, "utf8"));
    oracle.valid = false;
    writeFileSync(oraclePath, `${JSON.stringify(oracle, null, 2)}\n`);

    await expect(validateFixture(fixture)).rejects.toThrow("oracle evidence valid must be true");
  });

  test("rejects fixture-audio manifest drift from canonical normalized audio", async () => {
    const fixture = await writeArtifactFixture();
    const manifestPath = join(fixture.artifact, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.fixtureAudio.utterances[0].normalized.sha256 = "0".repeat(64);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(validateFixture(fixture)).rejects.toThrow(
      "manifest fixtureAudio utterances did not match",
    );
  });

  test("rejects recorded input spans that do not match canonical normalized speech", async () => {
    const fixture = await writeArtifactFixture();
    const audio = validAudioProof(fixture.canonicalFixtureAudio);
    const steer = spanFor(audio.spans, "steer");
    const input = readFileSync(join(fixture.artifact, "input.wav"));
    const comparison = readFileSync(join(fixture.artifact, "comparison.wav"));
    input.writeInt16LE(1234, 44 + steer.startSample * 2);
    comparison.writeInt16LE(1234, 44 + steer.startSample * 4);
    writeFileSync(join(fixture.artifact, "input.wav"), input);
    writeFileSync(join(fixture.artifact, "comparison.wav"), comparison);

    await expect(validateFixture(fixture)).rejects.toThrow("recorded input span for steer");
  });

  test("rejects a comparison WAV whose channels are not the isolated source tracks", async () => {
    const fixture = await writeArtifactFixture();
    const audio = validAudioProof(fixture.canonicalFixtureAudio);
    audio.comparison.writeInt16LE(1234, 44 + 1_200 * 4 + 2);
    writeFileSync(join(fixture.artifact, "comparison.wav"), audio.comparison);

    await expect(validateFixture(fixture)).rejects.toThrow("comparison audio channel 2");
  });

  test("rejects stale decoded-PCM overlap measurements", async () => {
    const fixture = await writeArtifactFixture();
    const audio = validAudioProof(fixture.canonicalFixtureAudio, { outputAudible: false });
    writeFileSync(join(fixture.artifact, "output.wav"), audio.output);
    writeFileSync(join(fixture.artifact, "comparison.wav"), audio.comparison);

    await expect(validateFixture(fixture)).rejects.toThrow("decoded PCM overlap measurement");
  });

  test("rejects symlinks in workspace evidence before rerunning the oracle", async () => {
    const fixture = await writeArtifactFixture();
    const workspaceAfter = join(fixture.artifact, "workspace-after");
    rmSync(join(workspaceAfter, "README.md"));
    symlinkSync("/etc/passwd", join(workspaceAfter, "README.md"));
    writeWorkspacePatch(fixture.artifact);

    await expect(validateFixture(fixture)).rejects.toThrow(
      "workspace-after contains a symbolic link",
    );
  });

  test("rejects a non-canonical starting workspace even when its patch is self-consistent", async () => {
    const fixture = await writeArtifactFixture();
    writeFileSync(join(fixture.artifact, "workspace-before", "unexpected.txt"), "drift\n");
    writeWorkspacePatch(fixture.artifact);

    await expect(validateFixture(fixture)).rejects.toThrow(
      "workspace-before did not match the canonical compact-full-duplex workspace",
    );
  });
});

async function writeArtifactFixture(): Promise<{
  root: string;
  artifact: string;
  binary: string;
  binarySha256: string;
  canonicalFixtureAudio: VerifiedFixtureAudio;
}> {
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
    schemaVersion: 3,
    implementation: "codex-voice-sidecar",
    sourceRepository: "possibilities/codex",
    sourceRevision: CANDIDATE_SHA,
    upstreamRevision: UPSTREAM_SHA,
    wireContractVersion: VOICE_SIDECAR_WIRE_CONTRACT_VERSION,
    wireContractSha256: voiceSidecarWireContractSha256(),
    builtAt: "2026-08-30T00:00:00Z",
    binarySha256,
    binaryVersion: BINARY_VERSION,
    credentialAuthority: {
      owner: "fx",
      provider: "codex",
      transport: "inherited-fd",
      descriptor: 3,
      protocolVersion: 1,
      maxFrameBytes: 65_536,
    },
  };
  writeFileSync(
    join(binaryDirectory, "metadata.json"),
    `${JSON.stringify(sidecarBuild, null, 2)}\n`,
  );

  const scenarioBytes = readFileSync(join(CANONICAL_FIXTURE_ROOT, "scenario.json"));
  const scenario = JSON.parse(scenarioBytes.toString("utf8")) as Scenario;
  const canonicalFixtureAudio = await loadCanonicalFixtureAudio(scenario);
  const audio = validAudioProof(canonicalFixtureAudio);
  const events = validNativeCodexFxTrace(audio.spans, audio.steerOverlap);
  const validation = validateCodexFxRunEvents(events, "voice-thread", {
    implementationProfile: "native-voice-sidecar",
  });
  writeFileSync(
    join(artifact, "events.ndjson"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );

  const oracleBytes = readFileSync(join(CANONICAL_FIXTURE_ROOT, "oracle.py"));
  const fixtureAudioReceiptBytes = readFileSync(
    join(CANONICAL_FIXTURE_ROOT, "audio", "rendered.json"),
  );
  writeFileSync(join(artifact, "scenario.json"), scenarioBytes);
  writeFileSync(join(artifact, "oracle.py"), oracleBytes);
  writeFileSync(join(artifact, "fixture-audio-receipt.json"), fixtureAudioReceiptBytes);
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
  writeWorkspaceEvidence(artifact);
  writeOracleEvidence(artifact);
  writeFileSync(join(artifact, "input.wav"), audio.input);
  writeFileSync(join(artifact, "output.wav"), audio.output);
  writeFileSync(join(artifact, "comparison.wav"), audio.comparison);
  writeFileSync(join(artifact, "app-server.stderr.log"), "");
  writeFileSync(join(artifact, "fx-terminal.log"), "Fx terminal log\n");
  writeFileSync(join(artifact, "fx-stderr.log"), "");

  const manifest = {
    schemaVersion: 1,
    contender: "codex-fx",
    status: "completed",
    failure: null,
    scenario: {
      id: "compact-full-duplex",
      path: "scenario.json",
      description: scenario.description,
    },
    agent: {
      voiceProtocol: "v3",
      voiceModelSelection: "server-owned",
      requestedVoiceModel: null,
      ...scenario.agent,
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
    fixtureAudio: {
      provenance: canonicalFixtureAudio.provenance,
      utterances: canonicalFixtureAudio.evidence,
    },
    evaluationInputs,
    runtime: {
      harnessVersion: "0.1.0",
      appServerVersion: BINARY_VERSION,
      startedAt: "2026-08-30T00:00:00Z",
      finishedAt: "2026-08-30T00:00:01Z",
      audioDurationMs: audio.durationMs,
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
  return { root, artifact, binary, binarySha256, canonicalFixtureAudio };
}

function validateFixture(fixture: { artifact: string; binary: string }): Promise<unknown> {
  return validateCodpieceArtifact({
    artifact: fixture.artifact,
    binary: fixture.binary,
    candidateSha: CANDIDATE_SHA,
  });
}

function readEvents(path: string): EventRecord[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EventRecord);
}

function writeEvents(path: string, events: readonly EventRecord[]): void {
  writeFileSync(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

function expectedDeclaredEvidenceSha256(artifact: string): Record<string, string | string[]> {
  return {
    events: sha256(readFileSync(join(artifact, "events.ndjson"))),
    inputAudio: sha256(readFileSync(join(artifact, "input.wav"))),
    outputAudio: sha256(readFileSync(join(artifact, "output.wav"))),
    comparisonAudio: sha256(readFileSync(join(artifact, "comparison.wav"))),
    fixtureAudioReceipt: sha256(readFileSync(join(artifact, "fixture-audio-receipt.json"))),
    evaluationInputReceipt: sha256(readFileSync(join(artifact, "evaluation-input-receipt.json"))),
    scenario: sha256(readFileSync(join(artifact, "scenario.json"))),
    oracleInputs: [sha256(readFileSync(join(artifact, "oracle.py")))],
    workspacePatch: sha256(readFileSync(join(artifact, "workspace.patch"))),
    oracle: sha256(readFileSync(join(artifact, "oracle.json"))),
    appServerStderr: sha256(readFileSync(join(artifact, "app-server.stderr.log"))),
    fxTerminal: sha256(readFileSync(join(artifact, "fx-terminal.log"))),
    fxStderr: sha256(readFileSync(join(artifact, "fx-stderr.log"))),
  };
}

function writeWorkspaceEvidence(artifact: string): void {
  const source = join(CANONICAL_FIXTURE_ROOT, "workspace");
  const before = join(artifact, "workspace-before");
  const after = join(artifact, "workspace-after");
  cpSync(source, before, { recursive: true });
  cpSync(source, after, { recursive: true });
  writeFileSync(join(after, "inventory.py"), fixedInventorySource());
  writeWorkspacePatch(artifact);
}

function writeWorkspacePatch(artifact: string): void {
  const before = realpathSync(join(artifact, "workspace-before"));
  const after = realpathSync(join(artifact, "workspace-after"));
  const result = Bun.spawnSync(["diff", "-ruN", before, after], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode > 1) {
    throw new Error(`test workspace diff failed: ${result.stderr.toString().trim()}`);
  }
  writeFileSync(join(artifact, "workspace.patch"), result.stdout);
}

function fixedInventorySource(): string {
  return `from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Reservation:
    request_id: str
    sku: str
    quantity: int


class Inventory:
    def __init__(self, stock: dict[str, int]) -> None:
        self._available = dict(stock)
        self._reservations: dict[str, Reservation] = {}

    def available(self, sku: str) -> int:
        return self._available.get(sku, 0)

    def reserve(self, request_id: str, sku: str, quantity: int) -> Reservation:
        if not request_id:
            raise ValueError("request_id must not be empty")
        if quantity <= 0:
            raise ValueError("quantity must be positive")

        existing = self._reservations.get(request_id)
        if existing is not None:
            if existing.sku == sku and existing.quantity == quantity:
                return existing
            raise ValueError(f"request_id {request_id} reused with different reservation")

        available = self.available(sku)
        if quantity > available:
            raise ValueError(
                f"insufficient stock for {sku}: requested {quantity}, available {available}"
            )

        reservation = Reservation(request_id=request_id, sku=sku, quantity=quantity)
        self._available[sku] = available - quantity
        self._reservations[request_id] = reservation
        return reservation

    def reservation(self, request_id: str) -> Reservation | None:
        return self._reservations.get(request_id)
`;
}

function writeOracleEvidence(artifact: string): void {
  const parsed = {
    passed: 1,
    total: 1,
    score: 1,
    checks: [{ name: "fixture proof", passed: true, detail: "stored oracle evidence passed" }],
  };
  const stdout = `${JSON.stringify(parsed)}\n`;
  const oracle = {
    command: ["python3", "oracle.py"],
    exitCode: 0,
    durationMs: 1,
    stdout,
    stderr: "",
    parsed,
    valid: true,
    validationError: null,
    score: 1,
  };
  writeFileSync(join(artifact, "oracle.json"), `${JSON.stringify(oracle, null, 2)}\n`);
}

interface AudioSpan {
  id: string;
  startSample: number;
  endSample: number;
  durationMs: number;
}

interface AudioProof {
  input: Buffer;
  output: Buffer;
  comparison: Buffer;
  durationMs: number;
  spans: Map<string, AudioSpan>;
  steerOverlap: AudibleOverlapMeasurement;
}

let canonicalFixtureAudioCache: Promise<VerifiedFixtureAudio> | null = null;

function loadCanonicalFixtureAudio(scenario: Scenario): Promise<VerifiedFixtureAudio> {
  if (!canonicalFixtureAudioCache) {
    canonicalFixtureAudioCache = loadVerifiedFixtureAudio(
      {
        path: join(CANONICAL_FIXTURE_ROOT, "scenario.json"),
        directory: CANONICAL_FIXTURE_ROOT,
        scenario,
        workspace: join(CANONICAL_FIXTURE_ROOT, "workspace"),
      },
      join(CANONICAL_FIXTURE_ROOT, "audio", "tts.json"),
    );
  }
  return canonicalFixtureAudioCache;
}

function validAudioProof(
  canonicalFixtureAudio: VerifiedFixtureAudio,
  options: { outputAudible?: boolean } = {},
): AudioProof {
  const outputAudible = options.outputAudible ?? true;
  const playIds = ["diagnose", "implement", "steer", "verify"];
  const spans = new Map<string, AudioSpan>();
  let sampleCursor = 0;
  for (const id of playIds) {
    const pcm = canonicalFixtureAudio.pcmByStepId.get(id);
    if (!pcm) throw new Error(`test fixture is missing canonical PCM for ${id}`);
    const pcmSamples = pcm.length / 2;
    const spanSamples = Math.ceil(pcmSamples / AUDIO_FRAME_SAMPLES) * AUDIO_FRAME_SAMPLES;
    spans.set(id, {
      id,
      startSample: sampleCursor,
      endSample: sampleCursor + spanSamples,
      durationMs: (pcmSamples / AUDIO_SAMPLE_RATE) * 1_000,
    });
    sampleCursor += spanSamples + AUDIO_FRAME_SAMPLES;
  }

  const sampleCount = sampleCursor;
  const inputPcm = Buffer.alloc(sampleCount * 2);
  const outputPcm = Buffer.alloc(sampleCount * 2);
  for (const [id, span] of spans) {
    const pcm = canonicalFixtureAudio.pcmByStepId.get(id)!;
    pcm.copy(inputPcm, span.startSample * 2);
  }

  const steer = spanFor(spans, "steer");
  if (outputAudible) {
    for (let sample = steer.startSample; sample < steer.endSample; sample++) {
      outputPcm.writeInt16LE(1_400, sample * 2);
    }
  }
  const steerOverlap = measureAudiblePcmOverlap(
    inputPcm,
    outputPcm,
    steer.startSample,
    steer.endSample,
  );
  if (outputAudible && steerOverlap.overlappingSampleCount <= 0) {
    throw new Error("test fixture did not create positive steering overlap");
  }
  return {
    input: wavBuffer(inputPcm, 1),
    output: wavBuffer(outputPcm, 1),
    comparison: wavBuffer(interleaveStereo(inputPcm, outputPcm), 2),
    durationMs: (sampleCount / AUDIO_SAMPLE_RATE) * 1_000,
    spans,
    steerOverlap,
  };
}

function spanFor(spans: Map<string, AudioSpan>, id: string): AudioSpan {
  const span = spans.get(id);
  if (!span) throw new Error(`test fixture is missing audio span for ${id}`);
  return span;
}

function interleaveStereo(left: Buffer, right: Buffer): Buffer {
  const samples = Math.max(left.length, right.length) / 2;
  const stereo = Buffer.alloc(samples * 4);
  for (let sample = 0; sample < samples; sample++) {
    stereo.writeInt16LE(left.readInt16LE(sample * 2), sample * 4);
    stereo.writeInt16LE(right.readInt16LE(sample * 2), sample * 4 + 2);
  }
  return stereo;
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

function validNativeCodexFxTrace(
  spans: Map<string, AudioSpan>,
  steerOverlap: AudibleOverlapMeasurement,
): EventRecord[] {
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
    ...inputAudioEvents(spanFor(spans, "diagnose")),
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
    ...inputAudioEvents(spanFor(spans, "implement")),
    event("delegation.created", { id: "raw-2", target: "client", text: "implement" }, "realtime"),
    forwarded("raw-2", "handoff-2", "implement"),
    admitted("raw-2", "handoff-2", "implement", "42", "queued", null),
    ...fxTurnStarted("42", 4),
    ...handoffAppend("handoff-2", "progress"),
    event("output.audio.started", {}, "media"),
    inputAudioStartEvent(spanFor(spans, "steer")),
    event("delegation.created", { id: "raw-3", target: "client", text: "steer" }, "realtime"),
    forwarded("raw-3", "handoff-3", "steer"),
    admitted("raw-3", "handoff-3", "steer", "steer-1", "steering", "42"),
    ...handoffAppend("handoff-3", "progress"),
    event("delegation.steered", { delegationTurnId: "steer-1", activeTurnId: "42" }, "bridge"),
    inputAudioFinishEvent(spanFor(spans, "steer")),
    event("output.audio.idle", {}, "media"),
    ...fxTurnCompleted("42", 6),
    event(
      "delegation.completed",
      { delegationTurnId: "42", turnId: "42", outcome: "completed" },
      "bridge",
    ),
    ...handoffAppend("handoff-2", "result"),
    ...inputAudioEvents(spanFor(spans, "verify")),
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
    event("audio.overlap.measured", { inputId: "steer", ...steerOverlap }, "media"),
    event("fx.stopped", {}, "fx"),
    event("sidecar.isolation.completed", nativeIsolationEvidence(), "app-server"),
  ]);
}

function inputAudioEvents(span: AudioSpan): EventRecord[] {
  return [inputAudioStartEvent(span), inputAudioFinishEvent(span)];
}

function inputAudioStartEvent(span: AudioSpan): EventRecord {
  return event(
    "input.audio.started",
    { id: span.id, durationMs: span.durationMs, startSample: span.startSample },
    "media",
  );
}

function inputAudioFinishEvent(span: AudioSpan): EventRecord {
  return event(
    "input.audio.finished",
    { id: span.id, startSample: span.startSample, endSample: span.endSample },
    "media",
  );
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
