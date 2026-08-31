#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { NATIVE_SIDECAR_SANDBOX_PROFILE } from "./app-server.ts";
import {
  AUDIBLE_OVERLAP_RESOLUTION_SAMPLES,
  AUDIO_FRAME_SAMPLES,
  AUDIO_SAMPLE_RATE,
  measureAudiblePcmOverlap,
} from "./audio.ts";
import { type ParsedPcm16Wav, parsePcm16Wav } from "./audio-analysis.ts";
import {
  type FxAuthorizedCodexSidecarBuildMetadata,
  loadSidecarBuildMetadata,
} from "./codex-fx-runner.ts";
import {
  commandVersion,
  type OracleResult,
  runOracle,
  validateOracleEvidence,
} from "./codex-runner.ts";
import { EventJournal, type EventRecord } from "./events.ts";
import { loadVerifiedFixtureAudio, type VerifiedFixtureAudio } from "./fixture-audio.ts";
import { type CodexFxRunValidationResult, validateCodexFxRunEvents } from "./run-validation.ts";
import { type LoadedScenario, type Scenario, scenarioSchema } from "./scenario.ts";
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
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const FULL_SHA_PATTERN = /^[a-f0-9]{40}$/;
const CANONICAL_FIXTURE_ROOT = resolve(import.meta.dir, "..", "fixtures", "compact-full-duplex");
const CANONICAL_SCENARIO_PATH = resolve(CANONICAL_FIXTURE_ROOT, "scenario.json");
const CANONICAL_WORKSPACE_PATH = resolve(CANONICAL_FIXTURE_ROOT, "workspace");
const CANONICAL_TTS_MANIFEST_PATH = resolve(CANONICAL_FIXTURE_ROOT, "audio", "tts.json");
const CANONICAL_TTS_RECEIPT_PATH = resolve(CANONICAL_FIXTURE_ROOT, "audio", "rendered.json");
const CANONICAL_ORACLE_SOURCE_PATH = resolve(CANONICAL_FIXTURE_ROOT, "oracle.py");
let canonicalFixtureAudioCache: Promise<VerifiedFixtureAudio> | null = null;

export type DeclaredEvidenceSha256 = Record<string, string | string[] | null>;

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
    declaredEvidenceSha256: DeclaredEvidenceSha256;
  };
}

interface LoadedFile {
  declaredPath: string;
  path: string;
  bytes: Buffer;
  sha256: string;
}

interface BoundEvidence {
  filesByKey: Map<string, LoadedFile[]>;
  sha256ByKey: DeclaredEvidenceSha256;
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
    3,
  ) as FxAuthorizedCodexSidecarBuildMetadata;

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
  const boundEvidence = bindDeclaredEvidenceFiles(artifactRoot, evidence);
  requiredDeclaredEvidenceFile(boundEvidence, "appServerStderr", "App-server stderr log");
  requiredDeclaredEvidenceFile(boundEvidence, "fxTerminal", "Fx terminal log");
  requiredDeclaredEvidenceFile(boundEvidence, "fxStderr", "Fx stderr log");
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
  const workspacePatch = requiredDeclaredEvidenceFile(
    boundEvidence,
    "workspacePatch",
    "workspace patch",
  );
  const workspaceAfter = await validateWorkspacePatch(artifactRoot, workspacePatch);

  const events = requiredDeclaredEvidenceFile(boundEvidence, "events", "events");
  const eventRecords = parseEventRecords(events.bytes, "events");
  const voiceThreadId = requiredString(runtime["voiceThreadId"], "manifest runtime voiceThreadId");
  const validation = validateCodexFxRunEvents(eventRecords, voiceThreadId, {
    steerInputId: "steer",
    implementationProfile: "native-voice-sidecar",
  });
  assertEqualJson("manifest validation", manifestJson["validation"], validation);
  assertConsumedWireContract(wireMessagesFromEvents(eventRecords));

  const scenario = requiredDeclaredEvidenceFile(boundEvidence, "scenario", "scenario");
  const parsedScenario = validateScenarioEvidence(manifestJson["scenario"], scenario);
  const fixtureAudioReceipt = requiredDeclaredEvidenceFile(
    boundEvidence,
    "fixtureAudioReceipt",
    "fixture audio receipt",
  );
  const canonicalFixtureAudio = await validateFixtureAudioReceipt(
    manifestJson["fixtureAudio"],
    fixtureAudioReceipt,
    parsedScenario,
  );

  const evaluationInputReceipt = requiredDeclaredEvidenceFile(
    boundEvidence,
    "evaluationInputReceipt",
    "evaluation input receipt",
  );
  const declaredOracleInputs = requiredDeclaredEvidenceFiles(
    boundEvidence,
    "oracleInputs",
    "oracle input",
  );
  const evaluationInputReceiptJson = validateEvaluationInputReceipt(
    manifestJson["evaluationInputs"],
    evaluationInputReceipt.bytes,
    scenario,
    parsedScenario,
    declaredOracleInputs,
  );

  const oracle = requiredDeclaredEvidenceFile(boundEvidence, "oracle", "oracle evidence");
  await validateOracleProof(
    workspaceAfter,
    scenario,
    parsedScenario,
    evaluationInputReceiptJson,
    oracle,
    declaredOracleInputs,
  );

  const comparisonWav = requiredDeclaredEvidenceFile(
    boundEvidence,
    "comparisonAudio",
    "comparison audio",
  );
  const inputWav = requiredDeclaredEvidenceFile(boundEvidence, "inputAudio", "input audio");
  const outputWav = requiredDeclaredEvidenceFile(boundEvidence, "outputAudio", "output audio");
  validateAudioProof(
    eventRecords,
    validation,
    manifestJson,
    parsedScenario,
    canonicalFixtureAudio,
    inputWav,
    outputWav,
    comparisonWav,
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
      declaredEvidenceSha256: boundEvidence.sha256ByKey,
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
  options: { allowEmpty?: boolean } = {},
): LoadedFile {
  const relativePath = requiredString(declaredPath, `${label} path`);
  const artifactRelativePath = normalizeArtifactPath(relativePath, `${label} path`);
  const declaredAbsolutePath = resolve(artifactRoot, artifactRelativePath);
  assertNoSymlinkPathComponents(artifactRoot, artifactRelativePath, label);
  const resolved = realpathSync(declaredAbsolutePath);
  assertWithin(artifactRoot, resolved, label);
  const fileStat = statSync(resolved);
  if (!fileStat.isFile())
    throw new Error(`${label} is not a regular file: ${artifactRelativePath}`);
  if (!options.allowEmpty && fileStat.size <= 0) {
    throw new Error(`${label} is empty: ${artifactRelativePath}`);
  }
  if (fileStat.size > maxBytes) {
    throw new Error(`${label} is ${fileStat.size} bytes, over the ${maxBytes}-byte limit`);
  }
  const bytes = readFileSync(resolved);
  return { declaredPath: artifactRelativePath, path: resolved, bytes, sha256: sha256(bytes) };
}

function bindDeclaredEvidenceFiles(
  artifactRoot: string,
  evidence: Record<string, unknown>,
): BoundEvidence {
  const filesByKey = new Map<string, LoadedFile[]>();
  const sha256ByKey: DeclaredEvidenceSha256 = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (value === null) {
      filesByKey.set(key, []);
      sha256ByKey[key] = null;
      continue;
    }
    const paths = Array.isArray(value)
      ? value.map((item, index) =>
          requiredString(item, `manifest evidence ${key} path ${index + 1}`),
        )
      : [requiredString(value, `manifest evidence ${key} path`)];
    const files = paths.map((path, index) =>
      readDeclaredArtifactFile(
        artifactRoot,
        path,
        evidenceMaxBytes(key),
        paths.length === 1 ? `manifest evidence ${key}` : `manifest evidence ${key} ${index + 1}`,
        { allowEmpty: evidenceAllowsEmpty(key) },
      ),
    );
    filesByKey.set(key, files);
    sha256ByKey[key] = Array.isArray(value)
      ? files.map((file) => file.sha256)
      : (files[0]?.sha256 ?? null);
  }
  return { filesByKey, sha256ByKey };
}

function evidenceMaxBytes(key: string): number {
  switch (key) {
    case "comparisonAudio":
    case "inputAudio":
    case "outputAudio":
      return MAX_AUDIO_BYTES;
    case "events":
      return MAX_EVENTS_BYTES;
    case "scenario":
      return MAX_SCENARIO_BYTES;
    case "evaluationInputReceipt":
    case "fixtureAudioReceipt":
    case "oracle":
    case "oracleInputs":
      return MAX_RECEIPT_BYTES;
    default:
      return MAX_EVIDENCE_BYTES;
  }
}

function evidenceAllowsEmpty(key: string): boolean {
  return (
    key === "workspacePatch" ||
    key === "appServerStderr" ||
    key === "fxTerminal" ||
    key === "fxStderr"
  );
}

function requiredDeclaredEvidenceFile(
  evidence: BoundEvidence,
  key: string,
  label: string,
): LoadedFile {
  const files = evidence.filesByKey.get(key) ?? [];
  if (files.length !== 1) {
    throw new Error(`manifest evidence ${key} must declare exactly one ${label} file`);
  }
  return files[0]!;
}

function requiredDeclaredEvidenceFiles(
  evidence: BoundEvidence,
  key: string,
  label: string,
): LoadedFile[] {
  const files = evidence.filesByKey.get(key) ?? [];
  if (files.length === 0) {
    throw new Error(`manifest evidence ${key} must declare at least one ${label} file`);
  }
  return files;
}

async function validateWorkspacePatch(
  artifactRoot: string,
  workspacePatch: LoadedFile,
): Promise<string> {
  const workspaceBefore = realArtifactDirectory(
    artifactRoot,
    "workspace-before",
    "workspace before",
  );
  const workspaceAfter = realArtifactDirectory(artifactRoot, "workspace-after", "workspace after");
  assertPlainDirectoryTree(workspaceBefore, "workspace-before");
  assertPlainDirectoryTree(workspaceAfter, "workspace-after");
  const initialDrift = await canonicalWorkspacePatch(CANONICAL_WORKSPACE_PATH, workspaceBefore);
  if (initialDrift.length > 0) {
    throw new Error("workspace-before did not match the canonical compact-full-duplex workspace");
  }
  const expectedPatch = await canonicalWorkspacePatch(workspaceBefore, workspaceAfter);
  if (!workspacePatch.bytes.equals(expectedPatch)) {
    throw new Error(
      "workspace patch did not match canonical diff between workspace-before and workspace-after",
    );
  }
  return workspaceAfter;
}

function realArtifactDirectory(artifactRoot: string, relativePath: string, label: string): string {
  const declaredAbsolutePath = resolve(artifactRoot, relativePath);
  if (!existsSync(declaredAbsolutePath)) throw new Error(`${label} does not exist`);
  const linkStat = lstatSync(declaredAbsolutePath);
  if (linkStat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  const resolved = realpathSync(declaredAbsolutePath);
  assertWithin(artifactRoot, resolved, label);
  if (!statSync(resolved).isDirectory()) throw new Error(`${label} is not a directory`);
  return resolved;
}

async function canonicalWorkspacePatch(before: string, after: string): Promise<Buffer> {
  const child = Bun.spawn(["diff", "-ruN", before, after], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdoutBuffer, stderrText, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode > 1) {
    throw new Error(`workspace diff failed: ${stderrText.trim() || `exit ${exitCode}`}`);
  }
  return Buffer.from(stdoutBuffer);
}

function validateScenarioEvidence(manifestScenario: unknown, scenarioFile: LoadedFile): Scenario {
  assertBufferEqual(
    "artifact scenario",
    scenarioFile.bytes,
    readFileSync(CANONICAL_SCENARIO_PATH),
    "canonical compact-full-duplex scenario",
  );
  const scenario = parseScenario(scenarioFile.bytes);
  const manifest = requiredRecord(manifestScenario, "manifest scenario");
  assertEqual("manifest scenario id", manifest["id"], scenario.id);
  assertEqual("manifest scenario description", manifest["description"], scenario.description);
  if (!scenario.oracle) throw new Error("scenario has no oracle");
  return scenario;
}

function parseScenario(bytes: Buffer): Scenario {
  try {
    return scenarioSchema.parse(parseJsonRecord(bytes, "scenario"));
  } catch (error) {
    throw new Error(`scenario failed schema validation: ${errorMessage(error)}`);
  }
}

async function validateFixtureAudioReceipt(
  manifestFixtureAudio: unknown,
  receiptFile: LoadedFile,
  scenario: Scenario,
): Promise<VerifiedFixtureAudio> {
  const canonicalFixtureAudio = await loadCanonicalFixtureAudio(scenario);
  assertEqual(
    "canonical fixtureAudio receipt path",
    canonicalFixtureAudio.provenance.receipt.path,
    relative(CANONICAL_FIXTURE_ROOT, CANONICAL_TTS_RECEIPT_PATH),
  );
  assertBufferEqual(
    "artifact fixture audio receipt",
    receiptFile.bytes,
    canonicalFixtureAudio.receiptBytes,
    "canonical compact-full-duplex TTS receipt",
  );
  const fixtureAudio = requiredRecord(manifestFixtureAudio, "manifest fixtureAudio");
  assertEqual(
    "manifest fixtureAudio receipt sha256",
    canonicalFixtureAudio.provenance.receipt.sha256,
    receiptFile.sha256,
  );
  assertEqualJson(
    "manifest fixtureAudio provenance",
    fixtureAudio["provenance"],
    canonicalFixtureAudio.provenance,
  );
  assertEqualJson(
    "manifest fixtureAudio utterances",
    fixtureAudio["utterances"],
    canonicalFixtureAudio.evidence,
  );
  return canonicalFixtureAudio;
}

function loadCanonicalFixtureAudio(scenario: Scenario): Promise<VerifiedFixtureAudio> {
  if (!canonicalFixtureAudioCache) {
    canonicalFixtureAudioCache = loadVerifiedFixtureAudio(
      {
        path: CANONICAL_SCENARIO_PATH,
        directory: CANONICAL_FIXTURE_ROOT,
        scenario,
        workspace: resolve(CANONICAL_FIXTURE_ROOT, "workspace"),
      },
      CANONICAL_TTS_MANIFEST_PATH,
    );
  }
  return canonicalFixtureAudioCache;
}

function validateEvaluationInputReceipt(
  manifestReceipt: unknown,
  receiptBytes: Buffer,
  scenario: LoadedFile,
  parsedScenario: Scenario,
  declaredOracleInputs: readonly LoadedFile[],
): Record<string, unknown> {
  const receipt = parseJsonRecord(receiptBytes, "evaluation input receipt");
  assertEqualJson("manifest evaluationInputs", manifestReceipt, receipt);
  const scenarioReceipt = requiredRecord(receipt["scenario"], "evaluation input scenario receipt");
  assertEqual("evaluation input scenario artifact", scenarioReceipt["artifact"], "scenario.json");
  assertEqual("evaluation input scenario sha256", scenarioReceipt["sha256"], scenario.sha256);
  assertEqual("evaluation input scenario bytes", scenarioReceipt["bytes"], scenario.bytes.length);

  const oracle = requiredRecord(receipt["oracle"], "evaluation input oracle receipt");
  const oracleCommand = requiredStringArray(oracle["command"], "evaluation input oracle command");
  assertEqualJson("evaluation input oracle command", oracleCommand, parsedScenario.oracle!.command);
  const oracleFiles = requiredArray(oracle["files"], "evaluation input oracle files");
  if (oracleFiles.length === 0) {
    throw new Error("evaluation input receipt has no oracle source files");
  }
  if (declaredOracleInputs.length !== oracleFiles.length) {
    throw new Error(
      `manifest evidence oracleInputs count ${declaredOracleInputs.length} did not match receipt ${oracleFiles.length}`,
    );
  }
  if (oracleFiles.length !== 1) {
    throw new Error(
      `canonical oracle source set must contain exactly 1 file; got ${oracleFiles.length}`,
    );
  }
  for (const [index, file] of oracleFiles.entries()) {
    const source = requiredRecord(file, `evaluation input oracle file ${index + 1}`);
    const argumentIndex = requiredNonnegativeInteger(
      source["argumentIndex"],
      `evaluation input oracle file ${index + 1} argumentIndex`,
    );
    const commandValue = requiredString(
      source["commandValue"],
      `evaluation input oracle file ${index + 1} commandValue`,
    );
    assertEqual(
      `evaluation input oracle file ${index + 1} commandValue`,
      commandValue,
      oracleCommand[argumentIndex],
    );
    const artifact = requiredString(
      source["artifact"],
      `evaluation input oracle file ${index + 1}`,
    );
    assertOracleCommandSourcePath(
      commandValue,
      artifact,
      `evaluation input oracle file ${index + 1}`,
    );
    const captured = declaredOracleInputs.find((input) => input.declaredPath === artifact);
    if (!captured) {
      throw new Error(`manifest evidence oracleInputs did not declare ${artifact}`);
    }
    assertBufferEqual(
      `evaluation input oracle file ${index + 1}`,
      captured.bytes,
      readFileSync(CANONICAL_ORACLE_SOURCE_PATH),
      "canonical compact-full-duplex oracle source",
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
  return receipt;
}

function assertOracleCommandSourcePath(
  commandValue: string,
  artifact: string,
  label: string,
): void {
  const normalizedCommand = normalizeArtifactPath(commandValue, `${label} commandValue`);
  const normalizedArtifact = normalizeArtifactPath(artifact, `${label} artifact`);
  if (normalizedCommand !== normalizedArtifact) {
    throw new Error(
      `${label} artifact ${artifact} did not preserve oracle command path ${commandValue}`,
    );
  }
}

function normalizeArtifactPath(path: string, label: string): string {
  if (isAbsolute(path)) throw new Error(`${label} must be artifact-relative`);
  if (path.split(sep).includes("..")) throw new Error(`${label} escapes artifact directory`);
  const normalized = normalize(path);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new Error(`${label} escapes artifact directory`);
  }
  return normalized;
}

function assertNoSymlinkPathComponents(
  artifactRoot: string,
  artifactRelativePath: string,
  label: string,
): void {
  let current = artifactRoot;
  const components = artifactRelativePath.split(sep).filter((component) => component.length > 0);
  for (const [index, component] of components.entries()) {
    current = resolve(current, component);
    if (!existsSync(current)) throw new Error(`${label} does not exist: ${artifactRelativePath}`);
    const linkStat = lstatSync(current);
    if (linkStat.isSymbolicLink()) {
      throw new Error(`${label} path component ${component} must not be a symbolic link`);
    }
    if (index < components.length - 1 && !linkStat.isDirectory()) {
      throw new Error(`${label} path component ${component} is not a directory`);
    }
  }
}

async function validateOracleProof(
  workspaceAfter: string,
  scenarioFile: LoadedFile,
  scenario: Scenario,
  evaluationInputReceipt: Record<string, unknown>,
  oracleEvidence: LoadedFile,
  oracleInputs: readonly LoadedFile[],
): Promise<void> {
  const scenarioOracle = scenario.oracle;
  if (!scenarioOracle) throw new Error("scenario has no oracle");
  const receiptOracle = requiredRecord(
    evaluationInputReceipt["oracle"],
    "evaluation input oracle receipt",
  );
  const receiptCommand = requiredStringArray(
    receiptOracle["command"],
    "evaluation input oracle command",
  );
  const oracleJson = parseJsonRecord(oracleEvidence.bytes, "oracle evidence");
  const storedCommand = requiredStringArray(oracleJson["command"], "oracle evidence command");
  assertEqualJson("oracle evidence command", storedCommand, scenarioOracle.command);
  assertEqualJson("oracle evidence command receipt binding", storedCommand, receiptCommand);

  const exitCode = requiredInteger(oracleJson["exitCode"], "oracle evidence exitCode");
  assertEqual("oracle evidence exitCode", exitCode, 0);
  const stdout = requiredString(oracleJson["stdout"], "oracle evidence stdout");
  const parsedStdout = parseJsonValue(stdout, "oracle evidence stdout");
  assertEqualJson("oracle evidence parsed stdout", oracleJson["parsed"], parsedStdout);
  const validated = validateOracleEvidence(parsedStdout, exitCode);
  if (oracleJson["valid"] !== true) throw new Error("oracle evidence valid must be true");
  if (oracleJson["score"] !== 1) throw new Error("oracle evidence score must be 1");
  assertEqual("oracle evidence validationError", oracleJson["validationError"], null);
  assertEqualJson(
    "oracle evidence validation",
    {
      valid: oracleJson["valid"],
      validationError: oracleJson["validationError"],
      score: oracleJson["score"],
    },
    validated,
  );
  if (!validated.valid || validated.score !== 1) {
    throw new Error(
      `oracle evidence did not validate with score 1: ${validated.validationError ?? validated.score}`,
    );
  }

  const rerun = await rerunCanonicalOracle(workspaceAfter, scenarioFile, scenario, oracleInputs);
  assertEqualJson("canonical oracle rerun command", rerun.command, scenarioOracle.command);
  if (!rerun.valid || rerun.score !== 1) {
    throw new Error(
      `canonical oracle rerun did not pass with score 1: ${rerun.validationError ?? rerun.score}`,
    );
  }
}

async function rerunCanonicalOracle(
  workspaceAfter: string,
  scenarioFile: LoadedFile,
  scenario: Scenario,
  oracleInputs: readonly LoadedFile[],
): Promise<OracleResult> {
  assertPlainDirectoryTree(workspaceAfter, "workspace-after");
  for (const input of oracleInputs) {
    const linkStat = lstatSync(input.path);
    if (linkStat.isSymbolicLink()) {
      throw new Error(`oracle input must not be a symbolic link: ${input.declaredPath}`);
    }
    if (!linkStat.isFile()) {
      throw new Error(`oracle input must be a regular file: ${input.declaredPath}`);
    }
  }
  const scratch = mkdtempSync(resolve(tmpdir(), "agentvoice-oracle-rerun-"));
  try {
    const tempWorkspace = resolve(scratch, "workspace-after");
    cpSync(workspaceAfter, tempWorkspace, { recursive: true });
    copyArtifactFileForRerun(scratch, scenarioFile, "scenario");
    for (const input of oracleInputs) copyArtifactFileForRerun(scratch, input, "oracle input");

    const loaded: LoadedScenario = {
      path: resolve(scratch, scenarioFile.declaredPath),
      directory: scratch,
      scenario,
      workspace: tempWorkspace,
    };
    const journal = new EventJournal();
    try {
      return await runOracle(loaded, tempWorkspace, journal);
    } finally {
      journal.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function copyArtifactFileForRerun(scratchRoot: string, file: LoadedFile, label: string): void {
  const destination = resolve(scratchRoot, file.declaredPath);
  assertWithin(scratchRoot, destination, label);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(file.path, destination);
}

function assertPlainDirectoryTree(directory: string, label: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name);
    const linkStat = lstatSync(entryPath);
    if (linkStat.isSymbolicLink()) {
      throw new Error(`${label} contains a symbolic link: ${entryPath}`);
    }
    if (linkStat.isDirectory()) {
      assertPlainDirectoryTree(entryPath, label);
      continue;
    }
    if (!linkStat.isFile()) {
      throw new Error(`${label} contains a non-regular file: ${entryPath}`);
    }
  }
}

function validateAudioProof(
  events: readonly EventRecord[],
  validation: CodexFxRunValidationResult,
  manifestJson: Record<string, unknown>,
  scenario: Scenario,
  canonicalFixtureAudio: VerifiedFixtureAudio,
  inputWav: LoadedFile,
  outputWav: LoadedFile,
  comparisonWav: LoadedFile,
): void {
  const input = parsePcm16WavFile(inputWav, "input audio");
  const output = parsePcm16WavFile(outputWav, "output audio");
  const comparison = parsePcm16WavFile(comparisonWav, "comparison audio");

  assertWavFormat("input audio", input, 1);
  assertWavFormat("output audio", output, 1);
  assertWavFormat("comparison audio", comparison, 2);
  assertEqual(
    "input/output WAV sample count",
    output.sampleCountPerChannel,
    input.sampleCountPerChannel,
  );
  assertEqual(
    "comparison/input WAV sample count",
    comparison.sampleCountPerChannel,
    input.sampleCountPerChannel,
  );
  assertPcmEqual(
    "comparison audio channel 1",
    comparison.tracks[0]!,
    input.tracks[0]!,
    "input audio track",
  );
  assertPcmEqual(
    "comparison audio channel 2",
    comparison.tracks[1]!,
    output.tracks[0]!,
    "output audio track",
  );

  const runtime = requiredRecord(manifestJson["runtime"], "manifest runtime");
  const recordingDurationMs = (input.sampleCountPerChannel / AUDIO_SAMPLE_RATE) * 1_000;
  assertEqual("manifest runtime audioDurationMs", runtime["audioDurationMs"], recordingDurationMs);
  validateRecordedInputFixtureAudio(events, scenario, canonicalFixtureAudio, input.tracks[0]!);

  const steerInputId = "steer";
  const start = exactEvent(
    events,
    "input.audio.started",
    (event) => event.data["id"] === steerInputId,
    `input.audio.started for ${steerInputId}`,
  );
  const finish = exactEvent(
    events,
    "input.audio.finished",
    (event) => event.data["id"] === steerInputId,
    `input.audio.finished for ${steerInputId}`,
  );
  const measurement = exactEvent(
    events,
    "audio.overlap.measured",
    (event) => event.data["inputId"] === steerInputId,
    `audio.overlap.measured for ${steerInputId}`,
  );
  const inputStartSample = requiredNonnegativeInteger(
    start.data["startSample"],
    "input.audio.started startSample",
  );
  const finishStartSample = requiredNonnegativeInteger(
    finish.data["startSample"],
    "input.audio.finished startSample",
  );
  const inputEndSample = requiredNonnegativeInteger(
    finish.data["endSample"],
    "input.audio.finished endSample",
  );
  assertEqual("input.audio.finished startSample", finishStartSample, inputStartSample);
  if (inputEndSample <= inputStartSample) {
    throw new Error("input.audio.finished endSample must be greater than startSample");
  }
  if (
    input.sampleCountPerChannel < inputEndSample ||
    output.sampleCountPerChannel < inputEndSample ||
    comparison.sampleCountPerChannel < inputEndSample
  ) {
    throw new Error("WAV recordings do not cover the complete steering input sample range");
  }

  const recomputed = measureAudiblePcmOverlap(
    input.tracks[0]!,
    output.tracks[0]!,
    inputStartSample,
    inputEndSample,
  );
  assertEqualJson("decoded PCM overlap measurement", measurement.data, {
    inputId: steerInputId,
    ...recomputed,
  });
  assertEqual("decoded PCM overlap sampleRate", recomputed.sampleRate, AUDIO_SAMPLE_RATE);
  assertEqual("decoded PCM overlap windowSamples", recomputed.windowSamples, AUDIO_FRAME_SAMPLES);
  assertEqual(
    "decoded PCM overlap resolutionSamples",
    recomputed.resolutionSamples,
    AUDIBLE_OVERLAP_RESOLUTION_SAMPLES,
  );
  assertEqual(
    "manifest validation pcmOverlapDurationMs",
    validation.pcmOverlapDurationMs,
    recomputed.overlapDurationMs,
  );
}

function validateRecordedInputFixtureAudio(
  events: readonly EventRecord[],
  scenario: Scenario,
  canonicalFixtureAudio: VerifiedFixtureAudio,
  inputTrack: Buffer,
): void {
  const expectedInputTrack = Buffer.alloc(inputTrack.length);
  const inputSampleCount = inputTrack.length / 2;
  const playSteps = scenario.steps.filter((step) => step.type === "play");
  const occupiedSpans: Array<{ id: string; startSample: number; endSample: number }> = [];
  for (const step of playSteps) {
    const canonicalPcm = canonicalFixtureAudio.pcmByStepId.get(step.id);
    if (!canonicalPcm) throw new Error(`canonical fixture audio missing PCM for ${step.id}`);
    const start = exactEvent(
      events,
      "input.audio.started",
      (event) => event.data["id"] === step.id,
      `input.audio.started for ${step.id}`,
    );
    const finish = exactEvent(
      events,
      "input.audio.finished",
      (event) => event.data["id"] === step.id,
      `input.audio.finished for ${step.id}`,
    );
    const startSample = requiredNonnegativeInteger(
      start.data["startSample"],
      `input.audio.started ${step.id} startSample`,
    );
    const finishStartSample = requiredNonnegativeInteger(
      finish.data["startSample"],
      `input.audio.finished ${step.id} startSample`,
    );
    const endSample = requiredNonnegativeInteger(
      finish.data["endSample"],
      `input.audio.finished ${step.id} endSample`,
    );
    assertEqual(`input.audio.finished ${step.id} startSample`, finishStartSample, startSample);

    const canonicalSamples = canonicalPcm.length / 2;
    const canonicalDurationMs = (canonicalSamples / AUDIO_SAMPLE_RATE) * 1_000;
    assertEqual(
      `input.audio.started ${step.id} durationMs`,
      start.data["durationMs"],
      canonicalDurationMs,
    );
    const expectedSpanSamples =
      Math.ceil(canonicalSamples / AUDIO_FRAME_SAMPLES) * AUDIO_FRAME_SAMPLES;
    if (endSample - startSample !== expectedSpanSamples) {
      throw new Error(
        `recorded input span for ${step.id} was ${endSample - startSample} samples; expected ` +
          `${expectedSpanSamples} samples including 20ms frame padding`,
      );
    }
    if (endSample > inputSampleCount) {
      throw new Error(`recorded input span for ${step.id} exceeds input.wav sample count`);
    }
    for (const occupied of occupiedSpans) {
      if (startSample < occupied.endSample && endSample > occupied.startSample) {
        throw new Error(
          `recorded input span for ${step.id} overlaps ${occupied.id}; fixture playback must be serialized`,
        );
      }
    }
    occupiedSpans.push({ id: step.id, startSample, endSample });
    canonicalPcm.copy(expectedInputTrack, startSample * 2);

    assertBufferEqual(
      `recorded input span for ${step.id}`,
      inputTrack.subarray(startSample * 2, startSample * 2 + canonicalPcm.length),
      canonicalPcm,
      `canonical normalized PCM for ${step.id}`,
    );
  }

  assertBufferEqual(
    "recorded input track",
    inputTrack,
    expectedInputTrack,
    "canonical fixture audio spans with 20ms frame-padding silence",
  );
}

function parsePcm16WavFile(file: LoadedFile, label: string): ParsedPcm16Wav {
  try {
    return parsePcm16Wav(file.bytes);
  } catch (error) {
    throw new Error(`${label} is not canonical PCM WAV: ${errorMessage(error)}`);
  }
}

function assertWavFormat(label: string, wav: ParsedPcm16Wav, channels: 1 | 2): void {
  assertEqual(`${label} sampleRate`, wav.sampleRate, AUDIO_SAMPLE_RATE);
  assertEqual(`${label} channels`, wav.channels, channels);
  assertEqual(`${label} bitsPerSample`, wav.bitsPerSample, 16);
}

function assertPcmEqual(
  label: string,
  actual: Buffer,
  expected: Buffer,
  expectedLabel: string,
): void {
  assertBufferEqual(label, actual, expected, expectedLabel);
}

function assertBufferEqual(
  label: string,
  actual: Buffer,
  expected: Buffer,
  expectedLabel: string,
): void {
  if (!actual.equals(expected)) {
    throw new Error(`${label} did not exactly match ${expectedLabel}`);
  }
}

function exactEvent(
  events: readonly EventRecord[],
  type: string,
  predicate: (event: EventRecord) => boolean,
  label: string,
): EventRecord {
  const matches = events.filter((event) => event.type === type && predicate(event));
  if (matches.length !== 1) {
    throw new Error(`expected exactly 1 ${label}; observed ${matches.length}`);
  }
  return matches[0]!;
}

function parseEventRecords(bytes: Buffer, label: string): EventRecord[] {
  const events: EventRecord[] = [];
  let previousAtMs = 0;
  for (const [index, line] of bytes.toString("utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    const value = parseJsonRecord(Buffer.from(line), `${label} line ${index + 1}`);
    const expectedSeq = events.length + 1;
    const seq = value["seq"];
    const atMs = value["atMs"];
    const source = value["source"];
    const type = value["type"];
    const data = value["data"];
    if (
      !Number.isInteger(seq) ||
      (seq as number) < 1 ||
      typeof atMs !== "number" ||
      !Number.isFinite(atMs) ||
      atMs < 0 ||
      typeof source !== "string" ||
      source.length === 0 ||
      typeof type !== "string" ||
      type.length === 0 ||
      !isRecord(data)
    ) {
      throw new Error(`${label} line ${index + 1} is not an AgentVoice event`);
    }
    if (seq !== expectedSeq) {
      throw new Error(
        `${label} line ${index + 1} seq ${String(seq)} did not match expected ${expectedSeq}`,
      );
    }
    if (atMs < previousAtMs) {
      throw new Error(
        `${label} line ${index + 1} atMs ${atMs} moved backward from ${previousAtMs}`,
      );
    }
    previousAtMs = atMs;
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
  const path = relative(root, candidate);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
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

function requiredStringArray(value: unknown, label: string): string[] {
  const items = requiredArray(value, label);
  return items.map((item, index) => requiredString(item, `${label} item ${index + 1}`));
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is not a non-empty string`);
  }
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value)) throw new Error(`${label} is not an integer`);
  return value as number;
}

function requiredNonnegativeInteger(value: unknown, label: string): number {
  const integer = requiredInteger(value, label);
  if (integer < 0) throw new Error(`${label} is negative`);
  return integer;
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

function parseJsonValue(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`);
  }
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
