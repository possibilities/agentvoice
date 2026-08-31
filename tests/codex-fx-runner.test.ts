import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertCapturedEvaluationInputsUnchanged,
  CODEX_SIDECAR_SOURCE_REVISION,
  captureEvaluationInputs,
  loadSidecarBuildMetadata,
  resolveCodexFxExecutionProfile,
} from "../src/codex-fx-runner.ts";
import { loadScenario } from "../src/scenario.ts";
import {
  VOICE_SIDECAR_WIRE_CONTRACT_VERSION,
  voiceSidecarWireContractSha256,
} from "../src/voice-sidecar-contract.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Codex voice-sidecar build metadata", () => {
  test("binds the source revision, patch, binary, and reported version", () => {
    const fixture = sidecarFixture();

    expect(
      loadSidecarBuildMetadata(fixture.binaryPath, "codex-app-server 0.0.0", fixture.patchPath),
    ).toMatchObject({
      schemaVersion: 1,
      sourceRevision: CODEX_SIDECAR_SOURCE_REVISION,
      binaryVersion: "codex-app-server 0.0.0",
    });
  });

  test("rejects a binary changed after metadata was written", () => {
    const fixture = sidecarFixture();
    writeFileSync(fixture.binaryPath, "tampered binary");

    expect(() =>
      loadSidecarBuildMetadata(fixture.binaryPath, "codex-app-server 0.0.0", fixture.patchPath),
    ).toThrow("binary SHA-256 did not match");
  });

  test("rejects a source patch changed after the binary was built", () => {
    const fixture = sidecarFixture();
    writeFileSync(fixture.patchPath, "tampered patch");

    expect(() =>
      loadSidecarBuildMetadata(fixture.binaryPath, "codex-app-server 0.0.0", fixture.patchPath),
    ).toThrow("source patch SHA-256 did not match");
  });

  test("accepts schema 2 native metadata without requiring the legacy patch", () => {
    const fixture = nativeSidecarFixture();

    expect(
      loadSidecarBuildMetadata(
        fixture.binaryPath,
        "codex-voice-sidecar 0.0.0",
        "/does/not/exist.patch",
        2,
      ),
    ).toMatchObject({
      schemaVersion: 2,
      implementation: "codex-voice-sidecar",
      sourceRepository: "possibilities/codex",
      sourceRevision: fixture.sourceRevision,
      upstreamRevision: fixture.upstreamRevision,
      wireContractVersion: VOICE_SIDECAR_WIRE_CONTRACT_VERSION,
      wireContractSha256: voiceSidecarWireContractSha256(),
      binaryVersion: "codex-voice-sidecar 0.0.0",
    });
  });

  test("rejects stale schema 2 wire contracts and schema/profile mismatches", () => {
    const fixture = nativeSidecarFixture({ wireContractSha256: "0".repeat(64) });
    expect(() =>
      loadSidecarBuildMetadata(fixture.binaryPath, "codex-voice-sidecar 0.0.0", undefined, 2),
    ).toThrow("wire contract SHA-256");

    const legacy = sidecarFixture();
    expect(() =>
      loadSidecarBuildMetadata(legacy.binaryPath, "codex-app-server 0.0.0", legacy.patchPath, 2),
    ).toThrow("schemaVersion 1 did not match required 2");
  });
});

describe("Codex-Fx execution profile resolution", () => {
  test("keeps --app-server on the legacy metadata/profile path", () => {
    expect(resolveCodexFxExecutionProfile({ appServerPath: "legacy-bin" })).toEqual({
      implementationProfile: "legacy-app-server",
      binaryPath: resolve("legacy-bin"),
      command: [
        resolve("legacy-bin"),
        "-c",
        "features.realtime_conversation=true",
        "--listen",
        "stdio://",
      ],
      requiredMetadataSchemaVersion: 1,
    });
  });

  test("routes --voice-sidecar through the native metadata/profile path", () => {
    expect(resolveCodexFxExecutionProfile({ voiceSidecarPath: "native-bin" })).toEqual({
      implementationProfile: "native-voice-sidecar",
      binaryPath: resolve("native-bin"),
      command: [
        resolve("native-bin"),
        "-c",
        "features.realtime_conversation=true",
        "--listen",
        "stdio://",
      ],
      appServerExecutionProfile: "native-voice-sidecar",
      requiredMetadataSchemaVersion: 2,
    });
  });

  test("does not allow both sidecar profile flags at once", () => {
    expect(() =>
      resolveCodexFxExecutionProfile({
        appServerPath: "legacy-bin",
        voiceSidecarPath: "native-bin",
      }),
    ).toThrow("mutually exclusive");
  });
});

describe("Codex-Fx evaluation input provenance", () => {
  test("copies and hash-binds the exact scenario and oracle source", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentvoice-evaluation-inputs-"));
    temporaryDirectories.push(directory);
    const workspace = join(directory, "workspace");
    const artifactDirectory = join(directory, "artifact");
    mkdirSync(workspace);
    mkdirSync(artifactDirectory);
    const oraclePath = join(directory, "oracle.py");
    const scenarioPath = join(directory, "scenario.json");
    writeFileSync(oraclePath, "print('oracle')\n");
    writeFileSync(
      scenarioPath,
      `${JSON.stringify({
        schemaVersion: 1,
        id: "provenance-test",
        description: "Bind evaluation inputs.",
        workspace: "workspace",
        steps: [{ type: "sleep", ms: 0 }],
        oracle: { command: ["python3", "oracle.py"], timeoutMs: 1_000 },
      })}\n`,
    );

    const captured = captureEvaluationInputs(await loadScenario(scenarioPath), artifactDirectory);
    expect(captured.receipt.scenario).toMatchObject({
      artifact: "scenario.json",
      bytes: readFileSync(scenarioPath).length,
    });
    expect(captured.receipt.scenario.sha256).toHaveLength(64);
    expect(captured.receipt.oracle.files).toEqual([
      {
        argumentIndex: 1,
        commandValue: "oracle.py",
        artifact: "oracle.py",
        sha256: createHash("sha256").update("print('oracle')\n").digest("hex"),
        bytes: 16,
      },
    ]);
    expect(readFileSync(join(artifactDirectory, "oracle.py"), "utf8")).toBe("print('oracle')\n");
    expect(() => assertCapturedEvaluationInputsUnchanged(captured)).not.toThrow();

    writeFileSync(oraclePath, "print('changed')\n");
    expect(() => assertCapturedEvaluationInputsUnchanged(captured)).toThrow(
      "evaluation input changed during the run",
    );
  });
});

function sidecarFixture(): { binaryPath: string; patchPath: string } {
  const directory = mkdtempSync(join(tmpdir(), "agentvoice-sidecar-metadata-"));
  temporaryDirectories.push(directory);
  const binaryPath = join(directory, "codex-app-server");
  const patchPath = join(directory, "source.patch");
  const binary = Buffer.from("test binary");
  const patch = Buffer.from("test patch");
  writeFileSync(binaryPath, binary);
  writeFileSync(patchPath, patch);
  writeFileSync(
    join(directory, "metadata.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sourceRevision: CODEX_SIDECAR_SOURCE_REVISION,
        patchSha256: createHash("sha256").update(patch).digest("hex"),
        builtAt: "2026-08-30T00:00:00Z",
        binarySha256: createHash("sha256").update(binary).digest("hex"),
        binaryVersion: "codex-app-server 0.0.0",
      },
      null,
      2,
    )}\n`,
  );
  return { binaryPath, patchPath };
}

function nativeSidecarFixture(
  overrides: Partial<{
    sourceRevision: string;
    upstreamRevision: string;
    wireContractSha256: string;
  }> = {},
): { binaryPath: string; sourceRevision: string; upstreamRevision: string } {
  const directory = mkdtempSync(join(tmpdir(), "agentvoice-native-sidecar-metadata-"));
  temporaryDirectories.push(directory);
  const binaryPath = join(directory, "codex-voice-sidecar");
  const binary = Buffer.from("native test binary");
  const sourceRevision = overrides.sourceRevision ?? "1234567890abcdef1234567890abcdef12345678";
  const upstreamRevision = overrides.upstreamRevision ?? "abcdef1234567890abcdef1234567890abcdef12";
  writeFileSync(binaryPath, binary);
  writeFileSync(
    join(directory, "metadata.json"),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        implementation: "codex-voice-sidecar",
        sourceRepository: "possibilities/codex",
        sourceRevision,
        upstreamRevision,
        wireContractVersion: VOICE_SIDECAR_WIRE_CONTRACT_VERSION,
        wireContractSha256: overrides.wireContractSha256 ?? voiceSidecarWireContractSha256(),
        builtAt: "2026-08-30T00:00:00Z",
        binarySha256: createHash("sha256").update(binary).digest("hex"),
        binaryVersion: "codex-voice-sidecar 0.0.0",
      },
      null,
      2,
    )}\n`,
  );
  return { binaryPath, sourceRevision, upstreamRevision };
}
