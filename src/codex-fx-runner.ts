import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import type { AppServerExecutionProfile } from "./app-server.ts";
import { CodexFxBridge } from "./codex-fx-bridge.ts";
import {
  commandVersion,
  executeStep,
  type OpenSession,
  type OracleResult,
  openSession,
  runOracle,
  stopSession,
  uniqueArtifactDirectory,
  writeWorkspaceDiff,
} from "./codex-runner.ts";
import { EventJournal } from "./events.ts";
import { loadVerifiedFixtureAudio } from "./fixture-audio.ts";
import {
  type FxAdeEvent,
  type FxCredentialBrokerProofMode,
  FxHeadlessOrchestrator,
  type FxIdentity,
} from "./fx-orchestrator.ts";
import { assertCodexReferenceVoiceModel, CODEX_REFERENCE } from "./reference.ts";
import {
  type CodexFxRunValidationResult,
  FX_CREDENTIAL_AUTHORITY_LIFECYCLE_EVENT,
  validateCodexFxRunEvents,
  validateFxCredentialAuthorityLifecycle,
} from "./run-validation.ts";
import { type LoadedScenario, loadScenario, scenarioSchema } from "./scenario.ts";
import {
  VOICE_SIDECAR_WIRE_CONTRACT_VERSION,
  voiceSidecarWireContractSha256,
} from "./voice-sidecar-contract.ts";

const VERSION = "0.1.0";
export const CODEX_SIDECAR_SOURCE_REVISION = "430d26b543b219049192de559987b8cf506efacf";
export const CODEX_SIDECAR_PATCH_PATH = resolve(
  import.meta.dir,
  "..",
  "patches",
  "codex-client-managed-handoffs.patch",
);

export interface CodexFxRunOptions {
  scenarioPath: string;
  artifactsRoot?: string;
  appServerPath?: string;
  voiceSidecarPath?: string;
  fxPath?: string;
}

export interface LegacyCodexSidecarBuildMetadata {
  schemaVersion: 1;
  sourceRevision: string;
  patchSha256: string;
  builtAt: string;
  binarySha256: string;
  binaryVersion: string;
}

export interface NativeCodexSidecarBuildMetadata {
  schemaVersion: 2;
  implementation: "codex-voice-sidecar";
  sourceRepository: "possibilities/codex";
  sourceRevision: string;
  upstreamRevision: string;
  wireContractVersion: typeof VOICE_SIDECAR_WIRE_CONTRACT_VERSION;
  wireContractSha256: string;
  builtAt: string;
  binarySha256: string;
  binaryVersion: string;
}

export interface FxAuthorizedCodexSidecarBuildMetadata {
  schemaVersion: 3;
  implementation: "codex-voice-sidecar";
  sourceRepository: "possibilities/codex";
  sourceRevision: string;
  upstreamRevision: string;
  wireContractVersion: typeof VOICE_SIDECAR_WIRE_CONTRACT_VERSION;
  wireContractSha256: string;
  builtAt: string;
  binarySha256: string;
  binaryVersion: string;
  credentialAuthority: {
    owner: "fx";
    provider: "codex";
    transport: "inherited-fd";
    descriptor: 3;
    protocolVersion: 1;
    maxFrameBytes: 65_536;
  };
}

export type CodexSidecarBuildMetadata =
  | LegacyCodexSidecarBuildMetadata
  | NativeCodexSidecarBuildMetadata
  | FxAuthorizedCodexSidecarBuildMetadata;

export type CodexSidecarMetadataSchemaVersion = 1 | 2 | 3;

export interface CodexFxCredentialAuthorityProof {
  mode: FxCredentialBrokerProofMode;
  lifecycleEvent: typeof FX_CREDENTIAL_AUTHORITY_LIFECYCLE_EVENT;
}

export function codexFxCredentialAuthorityProof(
  mode: FxCredentialBrokerProofMode,
): CodexFxCredentialAuthorityProof {
  return { mode, lifecycleEvent: FX_CREDENTIAL_AUTHORITY_LIFECYCLE_EVENT };
}

export function sidecarRequiresFxCredentialAuthority(
  metadata: CodexSidecarBuildMetadata,
): metadata is FxAuthorizedCodexSidecarBuildMetadata {
  return metadata.schemaVersion === 3;
}

export type CodexFxImplementationProfile = "legacy-app-server" | "native-voice-sidecar";

export interface CodexFxProbeOptions {
  appServerPath?: string;
  voiceSidecarPath?: string;
  fxPath?: string;
}

export interface ResolvedCodexFxExecutionProfile {
  implementationProfile: CodexFxImplementationProfile;
  binaryPath: string;
  command: [string, "-c", "features.realtime_conversation=true", "--listen", "stdio://"];
  appServerExecutionProfile?: AppServerExecutionProfile;
  requiredMetadataSchemaVersions: readonly CodexSidecarMetadataSchemaVersion[];
}

interface EvaluationInputFileReceipt {
  artifact: string;
  sha256: string;
  bytes: number;
}

export interface CapturedEvaluationInputs {
  receipt: {
    scenario: EvaluationInputFileReceipt;
    oracle: {
      command: string[];
      files: Array<
        EvaluationInputFileReceipt & {
          argumentIndex: number;
          commandValue: string;
        }
      >;
    };
  };
  sources: Array<{ path: string; sha256: string }>;
}

export async function teardownCodexFxRuntime(steps: {
  closeBridge(): void;
  stopSidecar(): Promise<void>;
  destroyCredentialAuthority(): void;
  stopFx(): Promise<void>;
}): Promise<void> {
  const errors: Error[] = [];
  try {
    steps.closeBridge();
  } catch (error) {
    errors.push(asError(error));
  }
  try {
    await steps.stopSidecar();
  } catch (error) {
    errors.push(asError(error));
  }
  try {
    steps.destroyCredentialAuthority();
  } catch (error) {
    errors.push(asError(error));
  }
  try {
    await steps.stopFx();
  } catch (error) {
    errors.push(asError(error));
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Codex-Fx runtime teardown failed");
}

/** Probes the voice sidecar; schema 3 starts Fx only to supply its credential authority. */
export async function probeCodexFxVoice(
  configured: string | CodexFxProbeOptions = {},
): Promise<Record<string, unknown>> {
  const execution = resolveCodexFxExecutionProfile(
    typeof configured === "string" ? { appServerPath: configured } : configured,
  );
  const appServerPath = execution.binaryPath;
  assertSidecarBinaryExists(appServerPath);
  const appServerVersion = await commandVersion(appServerPath);
  const sidecarBuild = loadSidecarBuildMetadata(
    appServerPath,
    appServerVersion,
    CODEX_SIDECAR_PATCH_PATH,
    execution.requiredMetadataSchemaVersions,
  );
  const scratch = mkdtempSync(join(tmpdir(), "agentvoice-codex-fx-probe-"));
  const workspace = join(scratch, "workspace");
  mkdirSync(workspace);
  const journal = new EventJournal();
  const stderr: string[] = [];
  let session: OpenSession | null = null;
  let orchestrator: FxHeadlessOrchestrator | null = null;
  let fxIdentity: FxIdentity | null = null;
  let credentialAuthority: Duplex | null = null;
  let voiceSession: { data: Record<string, unknown> } | null = null;
  let credentialAuthorityLifecycle: ReturnType<
    typeof validateFxCredentialAuthorityLifecycle
  > | null = null;
  let sessionStopped = false;

  try {
    if (sidecarRequiresFxCredentialAuthority(sidecarBuild)) {
      orchestrator = new FxHeadlessOrchestrator({
        workspace,
        ...(typeof configured !== "string" && configured.fxPath
          ? { fxPath: configured.fxPath }
          : {}),
        model: CODEX_REFERENCE.orchestratorModel,
        reasoningEffort: CODEX_REFERENCE.reasoningEffort,
        credentialBroker: { proofMode: "none" },
      });
      fxIdentity = await orchestrator.start();
      credentialAuthority = orchestrator.acquireCredentialBrokerChannel();
    }
    session = await openSession({
      workspace,
      voiceModel: CODEX_REFERENCE.voiceModel,
      voice: CODEX_REFERENCE.voice,
      orchestratorModel: CODEX_REFERENCE.orchestratorModel,
      reasoningEffort: CODEX_REFERENCE.reasoningEffort,
      includeStartupContext: CODEX_REFERENCE.includeStartupContext,
      appServerCommand: execution.command,
      ...(execution.appServerExecutionProfile
        ? { appServerExecutionProfile: execution.appServerExecutionProfile }
        : {}),
      ...(credentialAuthority ? { credentialAuthority } : {}),
      clientManagedHandoffs: true,
      delegationAckFiller: false,
      recordCanonicalCodexTurns: false,
      journal,
      stderr,
    });
    voiceSession = await journal.waitFor("voice.session.started", 1, 10_000);
    await stopSession(session, journal);
    sessionStopped = true;
    const stopErrors = journal.count("session.stop-error");
    if (stopErrors > 0) {
      throw new Error(`voice-sidecar probe had ${stopErrors} session stop error(s)`);
    }
    if (sidecarRequiresFxCredentialAuthority(sidecarBuild)) {
      credentialAuthorityLifecycle = validateFxCredentialAuthorityLifecycle(
        journal.snapshot(),
        "none",
      );
    }
    const codexWorkTurnCount = journal.count("appserver.turn/started");
    if (codexWorkTurnCount !== 0) {
      throw new Error(
        `voice-sidecar probe unexpectedly started ${codexWorkTurnCount} Codex turn(s)`,
      );
    }
    return {
      ok: true,
      appServerVersion,
      sidecarBuild,
      ...(fxIdentity ? { fxIdentity } : {}),
      ...(credentialAuthorityLifecycle
        ? {
            credentialAuthorityProof: codexFxCredentialAuthorityProof("none"),
            credentialAuthorityLifecycle,
          }
        : {}),
      implementationProfile: execution.implementationProfile,
      isolation: session.appServer.isolationEvidence(),
      voiceModel: CODEX_REFERENCE.voiceModel,
      voiceModelSelection: CODEX_REFERENCE.voiceModelSelection,
      observedVoiceModel: voiceSession?.data["model"] ?? null,
      voice: CODEX_REFERENCE.voice,
      voiceProtocol: CODEX_REFERENCE.voiceProtocol,
      clientManagedHandoffs: true,
      delegationAckFiller: false,
      codexWorkTurnCount,
      voices: session.voices,
      events: journal.snapshot().map((event) => event.type),
    };
  } finally {
    try {
      await teardownCodexFxRuntime({
        closeBridge() {},
        async stopSidecar() {
          if (session && !sessionStopped) await stopSession(session, journal);
        },
        destroyCredentialAuthority() {
          credentialAuthority?.destroy();
          credentialAuthority = null;
        },
        async stopFx() {
          await orchestrator?.stop();
        },
      });
    } finally {
      journal.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

export async function runCodexFxScenario(options: CodexFxRunOptions): Promise<string> {
  const loaded = await loadScenario(options.scenarioPath);
  assertCodexReferenceVoiceModel(loaded.scenario.agent.voiceModel);
  assertScenarioIdentity(loaded.scenario.agent);
  const oracleConfig = loaded.scenario.oracle;
  if (!oracleConfig) {
    throw new Error("Codex-Fx evaluation requires a workspace oracle");
  }
  const fixtureAudio = await loadVerifiedFixtureAudio(loaded);
  const execution = resolveCodexFxExecutionProfile(options);
  const appServerPath = execution.binaryPath;
  assertSidecarBinaryExists(appServerPath);
  const appServerVersion = await commandVersion(appServerPath);
  const sidecarBuild = loadSidecarBuildMetadata(
    appServerPath,
    appServerVersion,
    CODEX_SIDECAR_PATCH_PATH,
    execution.requiredMetadataSchemaVersions,
  );
  const artifactsRoot = resolve(options.artifactsRoot ?? "artifacts");
  const artifactDirectory = uniqueArtifactDirectory(artifactsRoot, loaded.scenario.id, "codex-fx");
  mkdirSync(artifactDirectory, { recursive: true });
  writeFileSync(join(artifactDirectory, "fixture-audio-receipt.json"), fixtureAudio.receiptBytes);
  const evaluationInputs = captureEvaluationInputs(loaded, artifactDirectory);

  const scratch = mkdtempSync(join(tmpdir(), "agentvoice-codex-fx-eval-"));
  const workspace = join(scratch, "workspace");
  cpSync(loaded.workspace, workspace, { recursive: true });
  cpSync(workspace, join(artifactDirectory, "workspace-before"), { recursive: true });

  const journal = new EventJournal();
  const stderr: string[] = [];
  const startedAt = new Date();
  let session: OpenSession | null = null;
  let bridge: CodexFxBridge | null = null;
  let orchestrator: FxHeadlessOrchestrator | null = null;
  let credentialAuthority: Duplex | null = null;
  let fxIdentity: FxIdentity | null = null;
  let oracle: OracleResult | null = null;
  let validation: CodexFxRunValidationResult | null = null;
  let status: "completed" | "failed" = "completed";
  let failure: string | null = null;
  let audioDurationMs = 0;
  const earlyNotifications: Array<[string, Record<string, unknown>]> = [];
  const failRun = (message: string): void => {
    status = "failed";
    failure = failure ? `${failure}; ${message}` : message;
    journal.record("harness", "run.failed", { message });
  };
  const runFailed = (): boolean => status === "failed";

  try {
    journal.record("harness", "run.started", {
      scenario: loaded.scenario.id,
      contender: "codex-fx",
    });
    const activeOrchestrator = new FxHeadlessOrchestrator({
      workspace,
      ...(options.fxPath ? { fxPath: options.fxPath } : {}),
      model: loaded.scenario.agent.orchestratorModel,
      reasoningEffort: loaded.scenario.agent.reasoningEffort,
      ...(sidecarRequiresFxCredentialAuthority(sidecarBuild)
        ? {
            credentialBroker: {
              proofMode: "first-call-401-renewal" as const,
            },
          }
        : {}),
      terminalLogPath: join(artifactDirectory, "fx-terminal.log"),
      stderrLogPath: join(artifactDirectory, "fx-stderr.log"),
      onAdeEvent: (event) => recordFxEvent(event, journal),
      onProtocolError: (error) =>
        journal.record("fx", "fx.ade.protocol-error", { message: error.message }),
    });
    orchestrator = activeOrchestrator;
    fxIdentity = await activeOrchestrator.start();
    journal.record("fx", "fx.identity", { ...fxIdentity });
    if (sidecarRequiresFxCredentialAuthority(sidecarBuild)) {
      credentialAuthority = activeOrchestrator.acquireCredentialBrokerChannel();
    }

    session = await openSession({
      workspace,
      ...loaded.scenario.agent,
      appServerCommand: execution.command,
      ...(execution.appServerExecutionProfile
        ? { appServerExecutionProfile: execution.appServerExecutionProfile }
        : {}),
      ...(credentialAuthority ? { credentialAuthority } : {}),
      clientManagedHandoffs: true,
      delegationAckFiller: false,
      recordCanonicalCodexTurns: false,
      onNotification(method, params) {
        if (bridge) bridge.handleNotification(method, params);
        else earlyNotifications.push([method, params]);
      },
      journal,
      stderr,
    });
    bridge = new CodexFxBridge({
      appServer: session.appServer,
      threadId: session.threadId,
      orchestrator: activeOrchestrator,
      journal,
    });
    for (const [method, params] of earlyNotifications.splice(0)) {
      bridge.handleNotification(method, params);
    }
    journal.record("bridge", "bridge.started", {
      voiceThreadId: session.threadId,
      clientManagedHandoffs: true,
      delegationAckFiller: false,
      sourceRevision: sidecarBuild.sourceRevision,
    });

    for (let index = 0; index < loaded.scenario.steps.length; index++) {
      const step = loaded.scenario.steps[index]!;
      await Promise.race([
        executeStep(step, index, fixtureAudio.pcmByStepId, session.uplink, session.peer, journal),
        session.fatal,
        bridge.fatal,
        activeOrchestrator.fatal,
      ]);
    }
    await Promise.race([bridge.drain(), session.fatal, bridge.fatal, activeOrchestrator.fatal]);
    journal.record("harness", "scenario.completed");
  } catch (error) {
    failRun(errorMessage(error));
  } finally {
    await teardownCodexFxRuntime({
      closeBridge() {
        bridge?.close();
      },
      async stopSidecar() {
        if (session) {
          await stopSession(session, journal);
          await session.recorder
            .write(artifactDirectory)
            .then((result) => {
              audioDurationMs = result.durationMs;
              recordSteerPcmOverlap(session!.recorder, journal);
            })
            .catch((error) =>
              failRun(`audio artifact finalization failed: ${errorMessage(error)}`),
            );
        }
        await bridge?.drain().catch((error) => {
          journal.record("bridge", "bridge.drain-error", { message: errorMessage(error) });
          failRun(`bridge drain failed: ${errorMessage(error)}`);
        });
      },
      destroyCredentialAuthority() {
        credentialAuthority?.destroy();
        credentialAuthority = null;
      },
      async stopFx() {
        if (!orchestrator) return;
        await orchestrator.stop().then(
          () => journal.record("fx", "fx.stopped"),
          (error) => {
            journal.record("fx", "fx.stop.error", { message: errorMessage(error) });
            failRun(`Fx cleanup failed: ${errorMessage(error)}`);
          },
        );
      },
    }).catch((error) => failRun(`runtime teardown failed: ${errorMessage(error)}`));

    cpSync(workspace, join(artifactDirectory, "workspace-after"), { recursive: true });
    await writeWorkspaceDiff(
      join(artifactDirectory, "workspace-before"),
      join(artifactDirectory, "workspace-after"),
      join(artifactDirectory, "workspace.patch"),
    );
    try {
      assertCapturedEvaluationInputsUnchanged(evaluationInputs);
    } catch (error) {
      failRun(errorMessage(error));
    }
    oracle = await runOracle(loaded, workspace, journal).catch((error) => ({
      command: oracleConfig.command,
      exitCode: -1,
      durationMs: 0,
      stdout: "",
      stderr: errorMessage(error),
      parsed: null,
      valid: false,
      validationError: errorMessage(error),
      score: null,
    }));
    try {
      assertCapturedEvaluationInputsUnchanged(evaluationInputs);
    } catch (error) {
      failRun(errorMessage(error));
    }
    if (!oracle.valid || oracle.score !== 1) {
      failRun(
        oracle.valid
          ? `workspace oracle required score 1; observed ${String(oracle.score)}`
          : `oracle evidence invalid: ${oracle.validationError}`,
      );
    }

    if (!runFailed() && session) {
      try {
        validation = validateCodexFxRunEvents(journal.snapshot(), session.threadId, {
          steerInputId: "steer",
          implementationProfile: execution.implementationProfile,
          ...(sidecarRequiresFxCredentialAuthority(sidecarBuild)
            ? { credentialAuthorityProofMode: "first-call-401-renewal" as const }
            : {}),
        });
        journal.record("harness", "run.validation.passed", { ...validation });
      } catch (error) {
        failRun(errorMessage(error));
      }
    } else if (!runFailed()) {
      failRun("Codex-Fx run completed without a recorded voice session");
    }
    journal.record("harness", "run.finished", { status });
    journal.close();

    writeFileSync(
      join(artifactDirectory, "events.ndjson"),
      `${journal
        .snapshot()
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`,
    );
    writeFileSync(join(artifactDirectory, "app-server.stderr.log"), stderr.join(""));
    if (oracle) {
      writeFileSync(join(artifactDirectory, "oracle.json"), `${JSON.stringify(oracle, null, 2)}\n`);
    }
    const manifest = {
      schemaVersion: 1,
      contender: "codex-fx",
      status,
      failure,
      scenario: {
        id: loaded.scenario.id,
        path: loaded.path,
        description: loaded.scenario.description,
      },
      agent: {
        voiceProtocol: CODEX_REFERENCE.voiceProtocol,
        voiceModelSelection: CODEX_REFERENCE.voiceModelSelection,
        requestedVoiceModel: null,
        ...loaded.scenario.agent,
        orchestratorImplementation: "fx-work-control",
      },
      ...(execution.implementationProfile === "native-voice-sidecar"
        ? {
            implementationProfile: execution.implementationProfile,
            isolation: session?.appServer.isolationEvidence() ?? null,
          }
        : {}),
      sidecarBuild,
      ...(sidecarRequiresFxCredentialAuthority(sidecarBuild)
        ? {
            credentialAuthorityProof: codexFxCredentialAuthorityProof("first-call-401-renewal"),
          }
        : {}),
      fxIdentity,
      fixtureAudio: {
        provenance: fixtureAudio.provenance,
        utterances: fixtureAudio.evidence,
      },
      evaluationInputs: evaluationInputs.receipt,
      runtime: {
        harnessVersion: VERSION,
        appServerVersion,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        audioDurationMs,
        voiceThreadId: session?.threadId ?? null,
        realtimeSessionId: session?.realtimeSessionId ?? null,
        advertisedVoices: session?.voices ?? null,
      },
      validation,
      quality: {
        workspaceScore: oracle?.score ?? null,
        workspacePassed: oracle ? oracle.valid && oracle.score === 1 : null,
      },
      evidence: {
        events: "events.ndjson",
        inputAudio: session ? "input.wav" : null,
        outputAudio: session ? "output.wav" : null,
        comparisonAudio: session ? "comparison.wav" : null,
        fixtureAudioReceipt: "fixture-audio-receipt.json",
        evaluationInputReceipt: "evaluation-input-receipt.json",
        scenario: evaluationInputs.receipt.scenario.artifact,
        oracleInputs: evaluationInputs.receipt.oracle.files.map((file) => file.artifact),
        workspacePatch: "workspace.patch",
        oracle: oracle ? "oracle.json" : null,
        appServerStderr: "app-server.stderr.log",
        fxTerminal: "fx-terminal.log",
        fxStderr: "fx-stderr.log",
      },
    };
    writeFileSync(
      join(artifactDirectory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    rmSync(scratch, { recursive: true, force: true });
  }

  if (runFailed()) {
    throw new Error(`Codex-Fx scenario failed: ${failure}; artifacts: ${artifactDirectory}`);
  }
  return artifactDirectory;
}

export function captureEvaluationInputs(
  loaded: LoadedScenario,
  artifactDirectory: string,
): CapturedEvaluationInputs {
  const scenarioBytes = readFileSync(loaded.path);
  const capturedScenario = scenarioSchema.parse(JSON.parse(scenarioBytes.toString("utf8")));
  if (JSON.stringify(capturedScenario) !== JSON.stringify(loaded.scenario)) {
    throw new Error("scenario changed after it was loaded");
  }
  const scenarioArtifact = "scenario.json";
  writeFileSync(join(artifactDirectory, scenarioArtifact), scenarioBytes);
  const sources = [{ path: loaded.path, sha256: sha256(scenarioBytes) }];

  const oracle = loaded.scenario.oracle;
  if (!oracle) throw new Error("Codex-Fx evaluation requires a workspace oracle");
  const usedArtifactNames = new Set([scenarioArtifact]);
  const oracleFiles: CapturedEvaluationInputs["receipt"]["oracle"]["files"] = [];
  for (const [argumentIndex, commandValue] of oracle.command.entries()) {
    const sourcePath = resolve(loaded.directory, commandValue);
    if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) continue;
    const bytes = readFileSync(sourcePath);
    const requestedName = basename(sourcePath);
    let artifact = requestedName;
    if (usedArtifactNames.has(artifact)) artifact = `oracle-${argumentIndex}-${requestedName}`;
    usedArtifactNames.add(artifact);
    writeFileSync(join(artifactDirectory, artifact), bytes);
    const sourceSha256 = sha256(bytes);
    sources.push({ path: sourcePath, sha256: sourceSha256 });
    oracleFiles.push({
      argumentIndex,
      commandValue,
      artifact,
      sha256: sourceSha256,
      bytes: bytes.length,
    });
  }
  if (oracleFiles.length === 0) {
    throw new Error("Codex-Fx oracle command had no auditable source-file argument");
  }

  const receipt: CapturedEvaluationInputs["receipt"] = {
    scenario: {
      artifact: scenarioArtifact,
      sha256: sources[0]!.sha256,
      bytes: scenarioBytes.length,
    },
    oracle: { command: [...oracle.command], files: oracleFiles },
  };
  writeFileSync(
    join(artifactDirectory, "evaluation-input-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  return { receipt, sources };
}

export function assertCapturedEvaluationInputsUnchanged(captured: CapturedEvaluationInputs): void {
  for (const source of captured.sources) {
    if (!existsSync(source.path) || sha256(readFileSync(source.path)) !== source.sha256) {
      throw new Error(`evaluation input changed during the run: ${source.path}`);
    }
  }
}

export function defaultAppServerPath(): string {
  return join(".cache", "codex-app-server", CODEX_SIDECAR_SOURCE_REVISION, "codex-app-server");
}

export function resolveCodexFxExecutionProfile(
  options: CodexFxRunOptions | CodexFxProbeOptions,
): ResolvedCodexFxExecutionProfile {
  if (options.appServerPath && options.voiceSidecarPath) {
    throw new Error("--app-server and --voice-sidecar are mutually exclusive");
  }
  if (options.voiceSidecarPath) {
    const binaryPath = resolve(options.voiceSidecarPath);
    return {
      implementationProfile: "native-voice-sidecar",
      binaryPath,
      command: sidecarCommand(binaryPath),
      appServerExecutionProfile: "native-voice-sidecar",
      requiredMetadataSchemaVersions: [2, 3],
    };
  }
  const binaryPath = resolve(options.appServerPath ?? defaultAppServerPath());
  return {
    implementationProfile: "legacy-app-server",
    binaryPath,
    command: sidecarCommand(binaryPath),
    requiredMetadataSchemaVersions: [1],
  };
}

export function loadSidecarBuildMetadata(
  appServerPath: string,
  binaryVersion: string,
  patchPath = CODEX_SIDECAR_PATCH_PATH,
  requiredMetadataSchemaVersions?:
    | CodexSidecarMetadataSchemaVersion
    | readonly CodexSidecarMetadataSchemaVersion[],
): CodexSidecarBuildMetadata {
  assertSidecarBinaryExists(appServerPath);
  const metadataPath = join(dirname(appServerPath), "metadata.json");
  if (!existsSync(metadataPath))
    throw new Error(`sidecar build metadata not found at ${metadataPath}`);
  const value = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  const schemaVersion = metadataSchemaVersion(value["schemaVersion"]);
  const requiredVersions =
    typeof requiredMetadataSchemaVersions === "number"
      ? [requiredMetadataSchemaVersions]
      : requiredMetadataSchemaVersions;
  if (requiredVersions !== undefined && !requiredVersions.includes(schemaVersion)) {
    throw new Error(
      `sidecar build metadata schemaVersion ${schemaVersion} did not match required ` +
        `${requiredVersions.join(" or ")}`,
    );
  }
  const metadata =
    schemaVersion === 1
      ? legacySidecarBuildMetadata(value, patchPath)
      : nativeSidecarBuildMetadata(value, schemaVersion);
  if (metadata.binaryVersion !== binaryVersion) {
    throw new Error(
      `sidecar metadata version ${metadata.binaryVersion} did not match binary ${binaryVersion}`,
    );
  }
  const actualHash = createHash("sha256").update(readFileSync(appServerPath)).digest("hex");
  if (metadata.binarySha256 !== actualHash) {
    throw new Error("sidecar binary SHA-256 did not match its build metadata");
  }
  return metadata;
}

function sidecarCommand(
  binaryPath: string,
): [string, "-c", "features.realtime_conversation=true", "--listen", "stdio://"] {
  return [binaryPath, "-c", "features.realtime_conversation=true", "--listen", "stdio://"];
}

function legacySidecarBuildMetadata(
  value: Record<string, unknown>,
  patchPath: string,
): LegacyCodexSidecarBuildMetadata {
  if (!existsSync(patchPath)) throw new Error(`sidecar source patch not found at ${patchPath}`);
  const metadata: LegacyCodexSidecarBuildMetadata = {
    schemaVersion: 1,
    sourceRevision: stringField(value, "sourceRevision"),
    patchSha256: sha256Field(value, "patchSha256"),
    builtAt: stringField(value, "builtAt"),
    binarySha256: sha256Field(value, "binarySha256"),
    binaryVersion: stringField(value, "binaryVersion"),
  };
  if (metadata.sourceRevision !== CODEX_SIDECAR_SOURCE_REVISION) {
    throw new Error(
      `sidecar source revision ${metadata.sourceRevision} did not match ${CODEX_SIDECAR_SOURCE_REVISION}`,
    );
  }
  const actualPatchHash = createHash("sha256").update(readFileSync(patchPath)).digest("hex");
  if (metadata.patchSha256 !== actualPatchHash) {
    throw new Error("sidecar source patch SHA-256 did not match its build metadata");
  }
  return metadata;
}

function nativeSidecarBuildMetadata(
  value: Record<string, unknown>,
  schemaVersion: 2 | 3,
): NativeCodexSidecarBuildMetadata | FxAuthorizedCodexSidecarBuildMetadata {
  const common = {
    implementation:
      value["implementation"] === "codex-voice-sidecar"
        ? "codex-voice-sidecar"
        : invalid("implementation"),
    sourceRepository:
      value["sourceRepository"] === "possibilities/codex"
        ? "possibilities/codex"
        : invalid("sourceRepository"),
    sourceRevision: shaLikeField(value, "sourceRevision"),
    upstreamRevision: shaLikeField(value, "upstreamRevision"),
    wireContractVersion:
      value["wireContractVersion"] === VOICE_SIDECAR_WIRE_CONTRACT_VERSION
        ? VOICE_SIDECAR_WIRE_CONTRACT_VERSION
        : invalid("wireContractVersion"),
    wireContractSha256: sha256Field(value, "wireContractSha256"),
    builtAt: stringField(value, "builtAt"),
    binarySha256: sha256Field(value, "binarySha256"),
    binaryVersion: stringField(value, "binaryVersion"),
  } as const;
  const expectedWireContractSha256 = voiceSidecarWireContractSha256();
  if (common.wireContractSha256 !== expectedWireContractSha256) {
    throw new Error(
      `sidecar wire contract SHA-256 ${common.wireContractSha256} did not match ` +
        expectedWireContractSha256,
    );
  }
  if (schemaVersion === 2) return { schemaVersion, ...common };

  const credentialAuthority = recordField(value, "credentialAuthority");
  assertExactKeys(
    credentialAuthority,
    ["owner", "provider", "transport", "descriptor", "protocolVersion", "maxFrameBytes"],
    "credentialAuthority",
  );
  return {
    schemaVersion,
    ...common,
    credentialAuthority: {
      owner: literalField(credentialAuthority, "owner", "fx"),
      provider: literalField(credentialAuthority, "provider", "codex"),
      transport: literalField(credentialAuthority, "transport", "inherited-fd"),
      descriptor: literalField(credentialAuthority, "descriptor", 3),
      protocolVersion: literalField(credentialAuthority, "protocolVersion", 1),
      maxFrameBytes: literalField(credentialAuthority, "maxFrameBytes", 65_536),
    },
  };
}

function metadataSchemaVersion(value: unknown): CodexSidecarMetadataSchemaVersion {
  if (value === 1 || value === 2 || value === 3) return value;
  return invalid("metadata schemaVersion");
}

function assertSidecarBinaryExists(appServerPath: string): void {
  if (!existsSync(appServerPath)) {
    throw new Error(
      `Codex voice sidecar binary not found at ${appServerPath}; ` +
        `build the legacy App-server with bun run build:codex-app-server or pass ` +
        `a Codpiece native binary with --voice-sidecar`,
    );
  }
}

function recordFxEvent(event: FxAdeEvent, journal: EventJournal): void {
  const data = {
    adeSequence: event.sequence,
    event: event.event,
    context: event.context,
    payload: event.payload,
  };
  journal.record("fx", `fx.ade.${event.event.toLowerCase()}`, data);
  if (event.context.agent_role !== "main" || event.context.turn_id === null) return;
  if (event.event === "TurnStarted") {
    journal.record("fx", "orchestrator.turn.started", {
      turnId: String(event.context.turn_id),
      status: "inProgress",
      adeSequence: event.sequence,
    });
  } else if (event.event === "PostTurnEnd") {
    const outcome = event.payload["outcome"] ?? null;
    journal.record("fx", "orchestrator.turn.completed", {
      turnId: String(event.context.turn_id),
      status: outcome === "completed" ? "completed" : outcome,
      error: outcome === "completed" ? null : `Fx turn ended ${String(outcome)}`,
      outcome,
      providerDisposition: event.payload["provider_disposition"] ?? null,
      adeSequence: event.sequence,
    });
  }
}

function recordSteerPcmOverlap(
  recorder: OpenSession["recorder"],
  journal: EventJournal,
  inputId = "steer",
): void {
  const events = journal.snapshot();
  const starts = events.filter(
    (event) => event.type === "input.audio.started" && event.data["id"] === inputId,
  );
  const finishes = events.filter(
    (event) => event.type === "input.audio.finished" && event.data["id"] === inputId,
  );
  if (starts.length !== 1 || finishes.length !== 1) {
    throw new Error(
      `cannot measure ${inputId} PCM overlap: observed ${starts.length} starts and ` +
        `${finishes.length} finishes`,
    );
  }
  const startSample = starts[0]!.data["startSample"];
  const finishStartSample = finishes[0]!.data["startSample"];
  const endSample = finishes[0]!.data["endSample"];
  if (
    !Number.isInteger(startSample) ||
    (startSample as number) < 0 ||
    finishStartSample !== startSample ||
    !Number.isInteger(endSample) ||
    (endSample as number) <= (startSample as number)
  ) {
    throw new Error(`cannot measure ${inputId} PCM overlap: invalid recorded sample span`);
  }
  const measurement = recorder.measureAudibleOverlap(startSample as number, endSample as number);
  journal.record("media", "audio.overlap.measured", { inputId, ...measurement });
}

function assertScenarioIdentity(agent: {
  voice: string;
  orchestratorModel: string;
  reasoningEffort: string;
  includeStartupContext: boolean;
}): void {
  if (agent.voice !== CODEX_REFERENCE.voice) {
    throw new Error(
      `Codex-Fx scenario requires voice ${CODEX_REFERENCE.voice}; got ${agent.voice}`,
    );
  }
  if (agent.orchestratorModel !== CODEX_REFERENCE.orchestratorModel) {
    throw new Error(
      `Codex-Fx scenario requires Fx model ${CODEX_REFERENCE.orchestratorModel}; got ${agent.orchestratorModel}`,
    );
  }
  if (agent.reasoningEffort !== CODEX_REFERENCE.reasoningEffort) {
    throw new Error(
      `Codex-Fx scenario requires effort ${CODEX_REFERENCE.reasoningEffort}; got ${agent.reasoningEffort}`,
    );
  }
  if (agent.includeStartupContext !== CODEX_REFERENCE.includeStartupContext) {
    throw new Error(
      `Codex-Fx scenario requires includeStartupContext ` +
        `${CODEX_REFERENCE.includeStartupContext}; got ${agent.includeStartupContext}`,
    );
  }
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) throw new Error(`invalid ${key}`);
  return field;
}

function sha256Field(value: Record<string, unknown>, key: string): string {
  const field = stringField(value, key);
  if (!/^[a-f0-9]{64}$/.test(field)) throw new Error(`invalid ${key}`);
  return field;
}

function shaLikeField(value: Record<string, unknown>, key: string): string {
  const field = stringField(value, key);
  if (!/^[a-f0-9]{40}$/.test(field)) throw new Error(`invalid ${key}`);
  return field;
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  if (typeof field !== "object" || field === null || Array.isArray(field)) {
    throw new Error(`invalid ${key}`);
  }
  return field as Record<string, unknown>;
}

function literalField<const T extends string | number>(
  value: Record<string, unknown>,
  key: string,
  expected: T,
): T {
  if (value[key] !== expected) throw new Error(`invalid credentialAuthority.${key}`);
  return expected;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`invalid ${label} fields`);
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function invalid(label: string): never {
  throw new Error(`invalid ${label}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
