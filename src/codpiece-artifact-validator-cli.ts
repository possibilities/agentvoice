#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeSync } from "node:fs";
import { resolve, sep } from "node:path";
import { NATIVE_SIDECAR_SANDBOX_PROFILE } from "./app-server.ts";
import {
  loadSidecarBuildMetadata,
  type NativeCodexSidecarBuildMetadata,
} from "./codex-fx-runner.ts";
import { commandVersion } from "./codex-runner.ts";
import type { EventRecord } from "./events.ts";
import { validateCodexFxRunEvents } from "./run-validation.ts";
import {
  assertConsumedWireContract,
  voiceSidecarWireContractSha256,
  wireMessagesFromEvents,
} from "./voice-sidecar-contract.ts";

const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_EVENTS_BYTES = 16 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 1_000_000;
const MAX_SCENARIO_BYTES = 1_000_000;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const FULL_SHA_PATTERN = /^[a-f0-9]{40}$/;

export interface CodpieceArtifactValidationOptions {
  artifact: string;
  binary: string;
  candidateSha: string;
}

export interface CodpieceArtifactValidationReceipt {
  schemaVersion: 1;
  status: "accepted";
  candidateSha: string;
  binarySha256: string;
  binaryVersion: string;
  wireContractSha256: string;
  artifact: {
    path: string;
    manifestSha256: string;
    eventsSha256: string;
    scenarioSha256: string;
    evaluationInputReceiptSha256: string;
    comparisonWavSha256: string;
    inputWavSha256: string;
    outputWavSha256: string;
  };
}

interface LoadedFile {
  path: string;
  bytes: Buffer;
  sha256: string;
}

class UsageError extends Error {}

if (import.meta.main) {
  let exitCode = 0;
  try {
    const args = parseArgs(Bun.argv.slice(2));
    if (args.printContractSha) {
      stdout(`${voiceSidecarWireContractSha256()}\n`);
    } else {
      const receipt = await validateCodpieceArtifact({
        artifact: args.artifact,
        binary: args.binary,
        candidateSha: args.candidateSha,
      });
      stdout(`${JSON.stringify(receipt, null, 2)}\n`);
    }
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    exitCode = error instanceof UsageError ? 64 : 1;
  }
  process.exit(exitCode);
}

export async function validateCodpieceArtifact(
  options: CodpieceArtifactValidationOptions,
): Promise<CodpieceArtifactValidationReceipt> {
  if (!FULL_SHA_PATTERN.test(options.candidateSha)) {
    throw new Error("--candidate-sha must be a full lowercase commit SHA");
  }

  const artifactRoot = realDirectory(options.artifact, "artifact");
  const binaryPath = realExecutable(options.binary, "binary");
  const binaryBytes = readFileSync(binaryPath);
  const binarySha256 = sha256(binaryBytes);
  const binaryVersion = await commandVersion(binaryPath);
  const sidecarBuild = loadSidecarBuildMetadata(
    binaryPath,
    binaryVersion,
    undefined,
    2,
  ) as NativeCodexSidecarBuildMetadata;

  if (sidecarBuild.sourceRevision !== options.candidateSha) {
    throw new Error(
      `sidecar metadata sourceRevision ${sidecarBuild.sourceRevision} did not match ` +
        options.candidateSha,
    );
  }
  if (sidecarBuild.binarySha256 !== binarySha256) {
    throw new Error("sidecar metadata binary SHA-256 did not match the candidate binary");
  }
  if (sidecarBuild.binaryVersion !== binaryVersion) {
    throw new Error("sidecar metadata binary version did not match the candidate binary");
  }

  const wireContractSha256 = voiceSidecarWireContractSha256();
  if (sidecarBuild.wireContractSha256 !== wireContractSha256) {
    throw new Error("sidecar metadata is bound to a stale AgentVoice wire contract");
  }

  const manifest = readArtifactFile(artifactRoot, "manifest.json", MAX_MANIFEST_BYTES, "manifest");
  const manifestJson = parseJsonRecord(manifest.bytes, "manifest");
  const evidence = requiredRecord(manifestJson["evidence"], "manifest evidence");
  const runtime = requiredRecord(manifestJson["runtime"], "manifest runtime");
  const manifestSidecarBuild = requiredRecord(
    manifestJson["sidecarBuild"],
    "manifest sidecarBuild",
  );

  assertEqual("manifest schemaVersion", manifestJson["schemaVersion"], 1);
  assertEqual("manifest contender", manifestJson["contender"], "codex-fx");
  assertEqual("manifest status", manifestJson["status"], "completed");
  assertEqual("manifest failure", manifestJson["failure"] ?? null, null);
  assertEqual(
    "manifest implementationProfile",
    manifestJson["implementationProfile"],
    "native-voice-sidecar",
  );
  assertEqual("manifest runtime appServerVersion", runtime["appServerVersion"], binaryVersion);
  assertEqualJson("manifest sidecarBuild", manifestSidecarBuild, sidecarBuild);

  const quality = requiredRecord(manifestJson["quality"], "manifest quality");
  assertEqual("manifest workspacePassed", quality["workspacePassed"], true);
  assertEqual("manifest workspaceScore", quality["workspaceScore"], 1);
  assertStrictIsolation(requiredRecord(manifestJson["isolation"], "manifest isolation"));

  const events = readDeclaredArtifactFile(
    artifactRoot,
    evidence["events"],
    MAX_EVENTS_BYTES,
    "events",
  );
  const eventRecords = parseEventRecords(events.bytes, "events");
  const voiceThreadId = requiredString(runtime["voiceThreadId"], "manifest runtime voiceThreadId");
  const validation = validateCodexFxRunEvents(eventRecords, voiceThreadId, {
    steerInputId: "steer",
    implementationProfile: "native-voice-sidecar",
  });
  assertEqualJson("manifest validation", manifestJson["validation"], validation);
  assertConsumedWireContract(wireMessagesFromEvents(eventRecords));

  const scenario = readDeclaredArtifactFile(
    artifactRoot,
    evidence["scenario"],
    MAX_SCENARIO_BYTES,
    "scenario",
  );
  const evaluationInputReceipt = readDeclaredArtifactFile(
    artifactRoot,
    evidence["evaluationInputReceipt"],
    MAX_RECEIPT_BYTES,
    "evaluation input receipt",
  );
  validateEvaluationInputReceipt(
    artifactRoot,
    manifestJson["evaluationInputs"],
    evaluationInputReceipt.bytes,
    scenario,
  );

  const comparisonWav = readDeclaredArtifactFile(
    artifactRoot,
    evidence["comparisonAudio"],
    MAX_AUDIO_BYTES,
    "comparison audio",
  );
  const inputWav = readDeclaredArtifactFile(
    artifactRoot,
    evidence["inputAudio"],
    MAX_AUDIO_BYTES,
    "input audio",
  );
  const outputWav = readDeclaredArtifactFile(
    artifactRoot,
    evidence["outputAudio"],
    MAX_AUDIO_BYTES,
    "output audio",
  );

  return {
    schemaVersion: 1,
    status: "accepted",
    candidateSha: options.candidateSha,
    binarySha256,
    binaryVersion,
    wireContractSha256,
    artifact: {
      path: artifactRoot,
      manifestSha256: manifest.sha256,
      eventsSha256: events.sha256,
      scenarioSha256: scenario.sha256,
      evaluationInputReceiptSha256: evaluationInputReceipt.sha256,
      comparisonWavSha256: comparisonWav.sha256,
      inputWavSha256: inputWav.sha256,
      outputWavSha256: outputWav.sha256,
    },
  };
}

interface ParsedArgs {
  printContractSha: boolean;
  artifact: string;
  binary: string;
  candidateSha: string;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const parsed: Partial<ParsedArgs> = { printContractSha: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const [name, inlineValue] = arg.includes("=") ? splitOption(arg) : [arg, undefined];
    switch (name) {
      case "--print-contract-sha":
        parsed.printContractSha = true;
        break;
      case "--artifact":
      case "--binary":
      case "--candidate-sha": {
        const value = inlineValue ?? args[++index];
        if (!value) throw new UsageError(`${name} requires a value`);
        if (name === "--artifact") parsed.artifact = value;
        if (name === "--binary") parsed.binary = value;
        if (name === "--candidate-sha") parsed.candidateSha = value;
        break;
      }
      case "-h":
      case "--help":
        throw new UsageError(usage());
      default:
        throw new UsageError(usage());
    }
  }
  if (parsed.printContractSha) {
    return {
      printContractSha: true,
      artifact: parsed.artifact ?? "",
      binary: parsed.binary ?? "",
      candidateSha: parsed.candidateSha ?? "",
    };
  }
  if (!parsed.artifact || !parsed.binary || !parsed.candidateSha) {
    throw new UsageError(usage());
  }
  return parsed as ParsedArgs;
}

function splitOption(arg: string): [string, string] {
  const index = arg.indexOf("=");
  return [arg.slice(0, index), arg.slice(index + 1)];
}

function usage(): string {
  return (
    "Usage:\n" +
    "  bun run src/codpiece-artifact-validator-cli.ts --print-contract-sha\n" +
    "  bun run src/codpiece-artifact-validator-cli.ts " +
    "--artifact DIR --binary PATH --candidate-sha SHA"
  );
}

function realDirectory(path: string, label: string): string {
  const resolved = realpathSync(resolve(path));
  if (!statSync(resolved).isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  return resolved;
}

function realExecutable(path: string, label: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`${label} does not exist: ${path}`);
  const linkStat = lstatSync(resolved);
  if (linkStat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
  const realPath = realpathSync(resolved);
  const fileStat = statSync(realPath);
  if (!fileStat.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
  if ((fileStat.mode & 0o111) === 0) throw new Error(`${label} is not executable: ${path}`);
  return realPath;
}

function readArtifactFile(
  artifactRoot: string,
  relativePath: string,
  maxBytes: number,
  label: string,
): LoadedFile {
  return readDeclaredArtifactFile(artifactRoot, relativePath, maxBytes, label);
}

function readDeclaredArtifactFile(
  artifactRoot: string,
  declaredPath: unknown,
  maxBytes: number,
  label: string,
): LoadedFile {
  const relativePath = requiredString(declaredPath, `${label} path`);
  const resolved = realpathSync(resolve(artifactRoot, relativePath));
  assertWithin(artifactRoot, resolved, label);
  const fileStat = statSync(resolved);
  if (!fileStat.isFile()) throw new Error(`${label} is not a regular file: ${relativePath}`);
  if (fileStat.size <= 0) throw new Error(`${label} is empty: ${relativePath}`);
  if (fileStat.size > maxBytes) {
    throw new Error(`${label} is ${fileStat.size} bytes, over the ${maxBytes}-byte limit`);
  }
  const bytes = readFileSync(resolved);
  return { path: resolved, bytes, sha256: sha256(bytes) };
}

function validateEvaluationInputReceipt(
  artifactRoot: string,
  manifestReceipt: unknown,
  receiptBytes: Buffer,
  scenario: LoadedFile,
): void {
  const receipt = parseJsonRecord(receiptBytes, "evaluation input receipt");
  assertEqualJson("manifest evaluationInputs", manifestReceipt, receipt);
  const scenarioReceipt = requiredRecord(receipt["scenario"], "evaluation input scenario receipt");
  assertEqual("evaluation input scenario artifact", scenarioReceipt["artifact"], "scenario.json");
  assertEqual("evaluation input scenario sha256", scenarioReceipt["sha256"], scenario.sha256);
  assertEqual("evaluation input scenario bytes", scenarioReceipt["bytes"], scenario.bytes.length);

  const oracle = requiredRecord(receipt["oracle"], "evaluation input oracle receipt");
  const oracleFiles = requiredArray(oracle["files"], "evaluation input oracle files");
  if (oracleFiles.length === 0) {
    throw new Error("evaluation input receipt has no oracle source files");
  }
  for (const [index, file] of oracleFiles.entries()) {
    const source = requiredRecord(file, `evaluation input oracle file ${index + 1}`);
    const artifact = requiredString(
      source["artifact"],
      `evaluation input oracle file ${index + 1}`,
    );
    const captured = readDeclaredArtifactFile(
      artifactRoot,
      artifact,
      MAX_RECEIPT_BYTES,
      `evaluation input oracle file ${index + 1}`,
    );
    assertEqual(
      `evaluation input oracle file ${index + 1} sha256`,
      source["sha256"],
      captured.sha256,
    );
    assertEqual(
      `evaluation input oracle file ${index + 1} bytes`,
      source["bytes"],
      captured.bytes.length,
    );
  }
}

function parseEventRecords(bytes: Buffer, label: string): EventRecord[] {
  const events: EventRecord[] = [];
  for (const [index, line] of bytes.toString("utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    const value = parseJsonRecord(Buffer.from(line), `${label} line ${index + 1}`);
    const seq = value["seq"];
    const atMs = value["atMs"];
    const source = value["source"];
    const type = value["type"];
    const data = value["data"];
    if (
      !Number.isInteger(seq) ||
      (seq as number) < 1 ||
      typeof atMs !== "number" ||
      atMs < 0 ||
      typeof source !== "string" ||
      source.length === 0 ||
      typeof type !== "string" ||
      type.length === 0 ||
      !isRecord(data)
    ) {
      throw new Error(`${label} line ${index + 1} is not an AgentVoice event`);
    }
    events.push({ seq: seq as number, atMs, source, type, data } as EventRecord);
  }
  if (events.length === 0) throw new Error(`${label} contained no events`);
  return events;
}

function assertStrictIsolation(data: Record<string, unknown>): void {
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
    throw new Error("manifest isolation did not prove native no-fork execution");
  }
}

function assertWithin(root: string, candidate: string, label: string): void {
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} escapes artifact directory`);
  }
}

function parseJsonRecord(bytes: Buffer, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`);
  }
  return requiredRecord(value, label);
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is not an object`);
  return value;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is not a non-empty string`);
  }
  return value;
}

function assertEqual(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`${label} ${String(actual)} did not match ${String(expected)}`);
  }
}

function assertEqualJson(label: string, actual: unknown, expected: unknown): void {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(`${label} did not match`);
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = stableValue(value[key]);
  }
  return sorted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stdout(text: string): void {
  writeSync(process.stdout.fd, text);
}

function stderr(text: string): void {
  writeSync(process.stderr.fd, text);
}
