import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RoomAgentDispatch, RoomConfiguration } from "@livekit/protocol";
import {
  AudioSource,
  dispose,
  LocalAudioTrack,
  ParticipantKind,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";
import { AUDIO_SAMPLE_RATE, DuplexRecorder } from "./audio.ts";
import { validateOracleEvidence } from "./codex-runner.ts";
import { EventJournal } from "./events.ts";
import { loadVerifiedFixtureAudio } from "./fixture-audio.ts";
import {
  FX_ORCHESTRATOR_MODEL,
  FX_REASONING_EFFORT,
  LIVEKIT_AGENT_NAME,
  LIVEKIT_REASONING_EFFORT,
  LIVEKIT_VOICE,
  LIVEKIT_VOICE_MODEL,
} from "./livekit-agent.ts";
import { LiveKitContinuousUplink, LiveKitOutputMonitor } from "./livekit-media.ts";
import {
  LIVEKIT_JOB_SHUTDOWN_TIMEOUT_MS,
  LIVEKIT_NUM_IDLE_PROCESSES,
  LIVEKIT_POST_CLEANUP_CONTROL_TIMEOUT_MS,
  LIVEKIT_WORKER_CONTROL_TIMEOUT_MS,
  LiveKitAgentWorker,
  type LiveKitConnection,
  LocalLiveKitServer,
} from "./livekit-runtime.ts";
import {
  LIVEKIT_SHUTDOWN_PROBE_AGENT_NAME,
  LIVEKIT_SHUTDOWN_PROBE_DELAY_MS,
} from "./livekit-shutdown-probe-agent.ts";
import { type LiveKitTelemetryRecord, LiveKitTelemetryServer } from "./livekit-telemetry.ts";
import { environmentWithoutOpenAiApiKey } from "./local-env.ts";
import { type LiveKitRunValidationResult, validateLiveKitRunEvents } from "./run-validation.ts";
import { type LoadedScenario, loadScenario, type ScenarioStep } from "./scenario.ts";

const VERSION = "0.1.0";
const SESSION_START_TIMEOUT_MS = 90_000;
const AGENT_NAME_ATTRIBUTE = "lk.agent.name";

export interface LiveKitRunOptions {
  scenarioPath: string;
  openAiApiKey: string;
  artifactsRoot?: string;
  liveKitServerPath?: string;
  fxPath?: string;
  agentPath?: string;
  workerPath?: string;
  runtimePath?: string;
}

export interface LiveKitProbeOptions {
  liveKitServerPath?: string;
  workerPath?: string;
  runtimePath?: string;
}

export interface LiveKitJobMetadata {
  schemaVersion: 1;
  runId: string;
  workspace: string;
  orchestratorModel: typeof FX_ORCHESTRATOR_MODEL;
  reasoningEffort: typeof FX_REASONING_EFFORT;
}

interface OracleResult {
  command: string[];
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  parsed: unknown;
  valid: boolean;
  validationError: string | null;
  score: number | null;
}

interface FatalSignal {
  promise: Promise<never>;
  fail(error: Error): void;
}

export async function runLiveKitScenario(options: LiveKitRunOptions): Promise<string> {
  if (!options.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required for the LiveKit contender");
  }
  const loaded = await loadScenario(options.scenarioPath);
  assertLiveKitScenarioIdentity(loaded);
  const fixtureAudio = await loadVerifiedFixtureAudio(loaded);
  const artifactsRoot = resolve(options.artifactsRoot ?? "artifacts");
  const artifactDirectory = uniqueArtifactDirectory(artifactsRoot, loaded.scenario.id, "livekit");
  mkdirSync(artifactDirectory, { recursive: true });
  writeFileSync(join(artifactDirectory, "fixture-audio-receipt.json"), fixtureAudio.receiptBytes);

  const scratch = mkdtempSync(join(tmpdir(), "agentvoice-livekit-"));
  const workspace = join(scratch, "workspace");
  cpSync(loaded.workspace, workspace, { recursive: true });
  cpSync(workspace, join(artifactDirectory, "workspace-before"), { recursive: true });

  const runId = randomUUID();
  const roomName = `agentvoice-${runId}`;
  const evaluatorIdentity = `evaluator-${runId}`;
  const telemetrySocketPath = join(scratch, "t.sock");
  const journal = new EventJournal();
  const recorder = new DuplexRecorder();
  const telemetryFatal = createFatalSignal();
  const roomFatal = createFatalSignal();
  const startedAt = new Date();
  let stopping = false;
  let telemetry: LiveKitTelemetryServer | null = null;
  let server: LocalLiveKitServer | null = null;
  let worker: LiveKitAgentWorker | null = null;
  let room: Room | null = null;
  let source: AudioSource | null = null;
  let localTrack: LocalAudioTrack | null = null;
  let uplink: LiveKitContinuousUplink | null = null;
  let outputMonitor: LiveKitOutputMonitor | null = null;
  let rtcInitialized = false;
  let recordingStarted = false;
  let audioDurationMs = 0;
  let oracle: OracleResult | null = null;
  let validation: LiveKitRunValidationResult | null = null;
  let status: "completed" | "failed" = "completed";
  let failure: string | null = null;
  let fxIdentity: Record<string, unknown> | null = null;
  let subscribedAgentTrackSid: string | null = null;
  let jobCleanupConfirmed = false;

  const recordTelemetry = (record: LiveKitTelemetryRecord): void => {
    const data = redactUnknown(record.data, options.openAiApiKey) as Record<string, unknown>;
    const event = journal.record(record.source, record.type, {
      ...data,
      telemetrySequence: record.sequence,
      telemetryMonotonicNs: record.monotonicNs,
    });
    if (record.type === "fx.identity") fxIdentity = data;
    if (stopping) return;
    if (
      record.type === "voice.error" ||
      record.type === "voice.session.closed" ||
      record.type === "delegation.failed" ||
      record.type === "fx.ade.protocol-error" ||
      record.type === "fx.stop.error" ||
      record.type === "livekit.job.stopped"
    ) {
      telemetryFatal.fail(
        new Error(`unexpected ${record.type} at event ${event.seq}: ${JSON.stringify(data)}`),
      );
    }
  };

  try {
    journal.record("harness", "run.started", {
      scenario: loaded.scenario.id,
      contender: "livekit",
      runId,
    });
    telemetry = new LiveKitTelemetryServer({
      socketPath: telemetrySocketPath,
      runId,
      onRecord: recordTelemetry,
      onProtocolError(error) {
        const safe = safeError(error, options.openAiApiKey);
        journal.record("harness", "telemetry.protocol-error", { message: safe.message });
        if (!stopping) telemetryFatal.fail(safe);
      },
    });
    await telemetry.start();

    server = await LocalLiveKitServer.start(options.liveKitServerPath ?? "livekit-server");
    journal.record("harness", "livekit.server.started", {
      version: server.version,
      url: server.connection.url,
    });
    worker = await LiveKitAgentWorker.start({
      connection: server.connection,
      agentName: LIVEKIT_AGENT_NAME,
      openAiApiKey: options.openAiApiKey,
      telemetrySocketPath,
      telemetryRunId: runId,
      expectedWorkspace: workspace,
      fxTerminalLogPath: join(artifactDirectory, "fx-terminal.log"),
      fxStderrLogPath: join(artifactDirectory, "fx.stderr.log"),
      ...(options.fxPath ? { fxPath: options.fxPath } : {}),
      ...(options.agentPath ? { agentPath: options.agentPath } : {}),
      ...(options.workerPath ? { workerPath: options.workerPath } : {}),
      ...(options.runtimePath ? { runtimePath: options.runtimePath } : {}),
    });
    journal.record("harness", "livekit.worker.ready");

    outputMonitor = new LiveKitOutputMonitor({ recorder, journal });
    room = new Room();
    rtcInitialized = true;
    room.on(RoomEvent.ParticipantConnected, (participant) => {
      journal.record("media", "media.participant.connected", {
        identity: participant.identity,
        kind: participant.kind,
        agentName: participant.attributes[AGENT_NAME_ATTRIBUTE] ?? null,
      });
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      journal.record("media", "media.participant.disconnected", {
        identity: participant.identity,
        kind: participant.kind,
      });
    });
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      const agentName = participant.attributes[AGENT_NAME_ATTRIBUTE] ?? null;
      if (
        track.kind !== TrackKind.KIND_AUDIO ||
        participant.kind !== ParticipantKind.AGENT ||
        agentName !== LIVEKIT_AGENT_NAME
      ) {
        journal.record("media", "media.remote-track.ignored", {
          participantIdentity: participant.identity,
          participantKind: participant.kind,
          agentName,
          trackKind: track.kind ?? null,
          trackSid: publication.sid,
        });
        return;
      }
      const trackSid = publication.sid;
      if (!trackSid) {
        roomFatal.fail(new Error("LiveKit agent audio publication had no track SID"));
        return;
      }
      if (subscribedAgentTrackSid !== null && trackSid !== subscribedAgentTrackSid) {
        roomFatal.fail(
          new Error(
            `received a second LiveKit agent audio track (${trackSid}) after ` +
              subscribedAgentTrackSid,
          ),
        );
        return;
      }
      if (subscribedAgentTrackSid === trackSid) return;
      subscribedAgentTrackSid = trackSid;
      outputMonitor?.attach(track, {
        participantIdentity: participant.identity,
        participantKind: participant.kind,
        agentName,
        trackSid,
        trackName: track.name ?? null,
      });
    });
    room.on(RoomEvent.TrackSubscriptionFailed, (trackSid, participant, reason) => {
      const error = new Error(
        `LiveKit track subscription failed for ${participant.identity}/${trackSid}: ` +
          (reason ?? "unknown reason"),
      );
      journal.record("media", "media.track-subscription.failed", { message: error.message });
      if (!stopping) roomFatal.fail(error);
    });
    room.on(RoomEvent.EncryptionError, (error) => {
      journal.record("media", "media.encryption.error", { message: error.message });
      if (!stopping) roomFatal.fail(error);
    });
    room.on(RoomEvent.Disconnected, (reason) => {
      journal.record("media", "media.room.disconnected", { reason });
      if (!stopping) roomFatal.fail(new Error(`LiveKit room disconnected unexpectedly: ${reason}`));
    });

    const metadata: LiveKitJobMetadata = {
      schemaVersion: 1,
      runId,
      workspace,
      orchestratorModel: FX_ORCHESTRATOR_MODEL,
      reasoningEffort: FX_REASONING_EFFORT,
    };
    const token = await createLiveKitEvaluatorToken({
      connection: server.connection,
      roomName,
      evaluatorIdentity,
      jobMetadata: metadata,
    });
    const startupFatals = [server.fatal, worker.fatal, telemetryFatal.promise, roomFatal.promise];
    await raceFatals(
      room.connect(server.connection.url, token, { autoSubscribe: true, dynacast: false }),
      startupFatals,
    );

    source = new AudioSource(AUDIO_SAMPLE_RATE, 1);
    localTrack = LocalAudioTrack.createAudioTrack("evaluator-microphone", source);
    const publication = await raceFatals(
      room.localParticipant!.publishTrack(
        localTrack,
        new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
      ),
      startupFatals,
    );
    journal.record("media", "media.evaluator-track.published", {
      trackSid: publication.sid,
      source: "microphone",
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: 1,
    });

    await raceFatals(
      Promise.all([
        journal.waitFor("livekit.job.started", 1, SESSION_START_TIMEOUT_MS),
        journal.waitFor("fx.identity", 1, SESSION_START_TIMEOUT_MS),
        journal.waitFor("voice.session.started", 1, SESSION_START_TIMEOUT_MS),
        journal.waitFor("media.agent-track.subscribed", 1, SESSION_START_TIMEOUT_MS),
      ]),
      startupFatals,
    );

    uplink = new LiveKitContinuousUplink({ source, recorder, journal });
    uplink.start();
    recordingStarted = true;
    journal.record("harness", "session.connected", {
      roomName,
      roomSid: await room.getSid(),
      runId,
      voiceModel: LIVEKIT_VOICE_MODEL,
      voice: LIVEKIT_VOICE,
    });
    const activeFatals = [...startupFatals, uplink.fatal, outputMonitor.fatal];

    for (let index = 0; index < loaded.scenario.steps.length; index++) {
      const step = loaded.scenario.steps[index]!;
      await raceFatals(
        executeLiveKitStep(step, index, fixtureAudio.pcmByStepId, uplink, outputMonitor, journal),
        activeFatals,
      );
    }
    validation = validateLiveKitRunEvents(journal.snapshot());
    journal.record("harness", "run.validation.passed", { ...validation });
    journal.record("harness", "scenario.completed");
  } catch (error) {
    status = "failed";
    failure = safeError(error, options.openAiApiKey).message;
    journal.record("harness", "run.failed", { message: failure });
  } finally {
    stopping = true;
    const cleanupFailures: string[] = [];
    const cleanup = async (label: string, action: () => Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        const detail = `${label}: ${safeError(error, options.openAiApiKey).message}`;
        cleanupFailures.push(detail);
        journal.record("harness", "cleanup.failed", { label, message: detail });
      }
    };

    if (uplink) await cleanup("stop evaluator uplink", () => uplink!.stop());
    if (outputMonitor) await cleanup("stop output monitor", () => outputMonitor!.stop());
    if (room) await cleanup("disconnect evaluator room", () => room!.disconnect());
    if (localTrack) await cleanup("close evaluator track", () => localTrack!.close(true));
    if (recordingStarted) {
      await cleanup("write aligned audio", async () => {
        audioDurationMs = (await recorder.write(artifactDirectory)).durationMs;
      });
    }
    if (journal.count("livekit.job.started") > 0) {
      await cleanup("wait for LiveKit job resource cleanup", async () => {
        const event = await journal.waitFor(
          "livekit.job.stopped",
          journal.count("livekit.job.started"),
          15_000,
        );
        if (event.data["status"] !== "completed" || event.data["error"] !== null) {
          throw new Error(
            `job resource cleanup reported ${JSON.stringify({
              status: event.data["status"],
              error: event.data["error"],
            })}`,
          );
        }
        jobCleanupConfirmed = true;
      });
    }
    if (worker) {
      await cleanup("stop LiveKit worker", () =>
        worker!.stop({
          controlTimeoutMs: jobCleanupConfirmed
            ? LIVEKIT_POST_CLEANUP_CONTROL_TIMEOUT_MS
            : LIVEKIT_WORKER_CONTROL_TIMEOUT_MS,
        }),
      );
    }
    if (
      journal.count("livekit.job.started") > 0 &&
      journal.count("livekit.job.stopped") !== journal.count("livekit.job.started")
    ) {
      const detail =
        `worker shutdown telemetry: observed ${journal.count("livekit.job.started")} started ` +
        `job(s) and ${journal.count("livekit.job.stopped")} stopped job(s)`;
      cleanupFailures.push(detail);
      journal.record("harness", "cleanup.failed", {
        label: "verify worker shutdown telemetry",
        message: detail,
      });
    }
    if (server) await cleanup("stop LiveKit server", () => server!.stop());
    if (telemetry) await cleanup("close telemetry server", () => telemetry!.close());
    if (rtcInitialized) await cleanup("dispose LiveKit RTC FFI", async () => dispose());
    journal.record("harness", "session.closed");

    if (cleanupFailures.length > 0) {
      status = "failed";
      const detail = `cleanup failed: ${cleanupFailures.join("; ")}`;
      failure = failure ? `${failure}; ${detail}` : detail;
      journal.record("harness", "run.failed", { message: failure });
    }

    if (worker) {
      writeFileSync(
        join(artifactDirectory, "livekit-worker.log"),
        redactText(worker.logs(), options.openAiApiKey),
      );
    }
    if (server) {
      writeFileSync(join(artifactDirectory, "livekit-server.log"), server.logs());
    }

    cpSync(workspace, join(artifactDirectory, "workspace-after"), { recursive: true });
    await writeWorkspaceDiff(
      join(artifactDirectory, "workspace-before"),
      join(artifactDirectory, "workspace-after"),
      join(artifactDirectory, "workspace.patch"),
    );
    if (loaded.scenario.oracle) {
      oracle = await runOracle(loaded, workspace, journal).catch((error) => ({
        command: loaded.scenario.oracle!.command,
        exitCode: -1,
        durationMs: 0,
        stdout: "",
        stderr: safeError(error, options.openAiApiKey).message,
        parsed: null,
        valid: false,
        validationError: safeError(error, options.openAiApiKey).message,
        score: null,
      }));
      if (!oracle.valid) {
        status = "failed";
        const oracleFailure = `oracle evidence invalid: ${oracle.validationError}`;
        failure = failure ? `${failure}; ${oracleFailure}` : oracleFailure;
        journal.record("harness", "run.failed", { message: failure });
      }
    }
    journal.record("harness", "run.finished", { status });
    journal.close();

    writeFileSync(
      join(artifactDirectory, "events.ndjson"),
      `${journal
        .snapshot()
        .map((event) => JSON.stringify(redactUnknown(event, options.openAiApiKey)))
        .join("\n")}\n`,
    );
    if (oracle) {
      writeFileSync(
        join(artifactDirectory, "oracle.json"),
        `${JSON.stringify(redactUnknown(oracle, options.openAiApiKey), null, 2)}\n`,
      );
    }
    const packageVersions = dependencyVersions();
    const manifest = {
      schemaVersion: 1,
      contender: "livekit",
      status,
      failure,
      scenario: {
        id: loaded.scenario.id,
        path: loaded.path,
        description: loaded.scenario.description,
      },
      agent: {
        provider: "openai",
        voiceProtocol: "livekit-rtc",
        voiceModelSelection: "explicit-public-openai-api",
        requestedVoiceModel: LIVEKIT_VOICE_MODEL,
        voiceModel: LIVEKIT_VOICE_MODEL,
        voice: LIVEKIT_VOICE,
        voiceReasoningEffort: LIVEKIT_REASONING_EFFORT,
        turnDetection: "semantic_vad",
        interruptionEnabled: true,
        orchestrator: {
          model: FX_ORCHESTRATOR_MODEL,
          reasoningEffort: FX_REASONING_EFFORT,
          identity: fxIdentity,
        },
      },
      fixtureAudio: {
        provenance: fixtureAudio.provenance,
        utterances: fixtureAudio.evidence,
      },
      runtime: {
        harnessVersion: VERSION,
        liveKitServerVersion: server?.version ?? null,
        packages: packageVersions,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        audioDurationMs,
        runId,
        roomName,
        evaluatorIdentity,
        worker: {
          runtime: options.runtimePath ?? "bun",
          shutdownControl: "authenticated-stdin",
          numIdleProcesses: LIVEKIT_NUM_IDLE_PROCESSES,
          jobShutdownTimeoutMs: LIVEKIT_JOB_SHUTDOWN_TIMEOUT_MS,
          controlTimeoutMs: LIVEKIT_WORKER_CONTROL_TIMEOUT_MS,
          postCleanupControlTimeoutMs: LIVEKIT_POST_CLEANUP_CONTROL_TIMEOUT_MS,
          jobCleanupConfirmed,
        },
      },
      validation,
      quality: {
        workspaceScore: oracle?.score ?? null,
        workspacePassed: oracle ? oracle.valid && oracle.score === 1 : null,
      },
      evidence: {
        events: "events.ndjson",
        inputAudio: recordingStarted ? "input.wav" : null,
        outputAudio: recordingStarted ? "output.wav" : null,
        comparisonAudio: recordingStarted ? "comparison.wav" : null,
        fixtureAudioReceipt: "fixture-audio-receipt.json",
        workspacePatch: "workspace.patch",
        oracle: oracle ? "oracle.json" : null,
        liveKitWorkerLog: worker ? "livekit-worker.log" : null,
        liveKitServerLog: server ? "livekit-server.log" : null,
        fxTerminalLog: existsSync(join(artifactDirectory, "fx-terminal.log"))
          ? "fx-terminal.log"
          : null,
        fxStderrLog: existsSync(join(artifactDirectory, "fx.stderr.log")) ? "fx.stderr.log" : null,
      },
    };
    writeFileSync(
      join(artifactDirectory, "manifest.json"),
      `${JSON.stringify(redactUnknown(manifest, options.openAiApiKey), null, 2)}\n`,
    );

    if (cleanupFailures.length === 0) {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  if (status === "failed") {
    throw new Error(`LiveKit scenario failed: ${failure}; artifacts: ${artifactDirectory}`);
  }
  return artifactDirectory;
}

/** Dispatches a local no-inference job and proves its shutdown callback completes. */
export async function probeLiveKit(options: LiveKitProbeOptions): Promise<Record<string, unknown>> {
  const scratch = mkdtempSync(join(tmpdir(), "agentvoice-livekit-probe-"));
  const markerPath = join(scratch, "shutdown-lifecycle.txt");
  const roomName = `agentvoice-shutdown-probe-${randomUUID()}`;
  let server: LocalLiveKitServer | null = null;
  let worker: LiveKitAgentWorker | null = null;
  let room: Room | null = null;
  let rtcInitialized = false;
  let result: Record<string, unknown> | null = null;
  let probeError: Error | null = null;
  try {
    server = await LocalLiveKitServer.start(options.liveKitServerPath ?? "livekit-server");
    worker = await LiveKitAgentWorker.start({
      connection: server.connection,
      agentName: LIVEKIT_SHUTDOWN_PROBE_AGENT_NAME,
      agentPath: resolve("src/livekit-shutdown-probe-agent.ts"),
      shutdownProbePath: markerPath,
      ...(options.workerPath ? { workerPath: options.workerPath } : {}),
      ...(options.runtimePath ? { runtimePath: options.runtimePath } : {}),
    });
    room = new Room();
    rtcInitialized = true;
    const token = await createShutdownProbeToken({
      connection: server.connection,
      roomName,
      evaluatorIdentity: `shutdown-probe-${randomUUID()}`,
    });
    await raceFatals(
      room.connect(server.connection.url, token, { autoSubscribe: false, dynacast: false }),
      [server.fatal, worker.fatal],
    );
    await raceFatals(waitForFileContains(markerPath, "ready\n", SESSION_START_TIMEOUT_MS), [
      server.fatal,
      worker.fatal,
    ]);
    const resourceStopStarted = performance.now();
    await room.disconnect();
    await raceFatals(
      waitForFileContains(markerPath, "telemetry-flushed\n", SESSION_START_TIMEOUT_MS),
      [server.fatal, worker.fatal],
    );
    const resourceStopElapsedMs = performance.now() - resourceStopStarted;
    if (resourceStopElapsedMs < LIVEKIT_SHUTDOWN_PROBE_DELAY_MS) {
      throw new Error(
        `LiveKit resource cleanup completed in ${resourceStopElapsedMs.toFixed(1)}ms before its ` +
          `${LIVEKIT_SHUTDOWN_PROBE_DELAY_MS}ms delayed stop could have completed`,
      );
    }
    const stopStarted = performance.now();
    await worker.stop({ controlTimeoutMs: LIVEKIT_POST_CLEANUP_CONTROL_TIMEOUT_MS });
    const workerStopElapsedMs = performance.now() - stopStarted;
    const shutdownLifecycle = readFileSync(markerPath, "utf8");
    const expectedLifecycle =
      "ready\n" +
      "resource-stop-started\n" +
      "resource-stop-finished\n" +
      "job-stopped:completed\n" +
      "telemetry-flushed\n" +
      "callback-started\n" +
      "callback-finished\n";
    if (shutdownLifecycle !== expectedLifecycle) {
      throw new Error(
        `LiveKit shutdown probe expected resource and framework cleanup; observed ` +
          JSON.stringify(shutdownLifecycle),
      );
    }
    result = {
      ok: true,
      openAiApiKeyConfigured: false,
      paidModelRequestsDispatched: false,
      localShutdownProbeJobDispatched: true,
      resourceCleanupFinishedBeforeWorkerStop: true,
      shutdownCallbackFinishedBeforeWorkerStop: true,
      shutdownCallbackDelayMs: LIVEKIT_SHUTDOWN_PROBE_DELAY_MS,
      resourceStopElapsedMs,
      workerStopElapsedMs,
      shutdownLifecycle: shutdownLifecycle.trim().split("\n"),
      liveKitServerVersion: server.version,
      workerReady: true,
      workerRuntime: options.runtimePath ?? "bun",
      workerShutdownControl: "authenticated-stdin",
      workerNumIdleProcesses: LIVEKIT_NUM_IDLE_PROCESSES,
      workerJobShutdownTimeoutMs: LIVEKIT_JOB_SHUTDOWN_TIMEOUT_MS,
      workerControlTimeoutMs: LIVEKIT_WORKER_CONTROL_TIMEOUT_MS,
      workerPostCleanupControlTimeoutMs: LIVEKIT_POST_CLEANUP_CONTROL_TIMEOUT_MS,
      probeAgentName: LIVEKIT_SHUTDOWN_PROBE_AGENT_NAME,
      contenderAgentName: LIVEKIT_AGENT_NAME,
      voiceModel: LIVEKIT_VOICE_MODEL,
      voice: LIVEKIT_VOICE,
      voiceReasoningEffort: LIVEKIT_REASONING_EFFORT,
      orchestratorModel: FX_ORCHESTRATOR_MODEL,
      orchestratorReasoningEffort: FX_REASONING_EFFORT,
      packages: dependencyVersions(),
    };
  } catch (error) {
    probeError = safeError(error, "");
  }
  const cleanupErrors: string[] = [];
  try {
    await room?.disconnect();
  } catch (error) {
    cleanupErrors.push(`room: ${safeError(error, "").message}`);
  }
  try {
    await worker?.stop();
  } catch (error) {
    cleanupErrors.push(`worker: ${safeError(error, "").message}`);
  }
  try {
    await server?.stop();
  } catch (error) {
    cleanupErrors.push(`server: ${safeError(error, "").message}`);
  }
  if (rtcInitialized) {
    try {
      await dispose();
    } catch (error) {
      cleanupErrors.push(`RTC: ${safeError(error, "").message}`);
    }
  }
  if (cleanupErrors.length === 0) rmSync(scratch, { recursive: true, force: true });
  if (probeError) throw probeError;
  if (cleanupErrors.length > 0) {
    throw new Error(`LiveKit probe cleanup failed: ${cleanupErrors.join("; ")}`);
  }
  if (!result) throw new Error("LiveKit probe produced no result");
  return result;
}

async function createShutdownProbeToken(options: {
  connection: LiveKitConnection;
  roomName: string;
  evaluatorIdentity: string;
}): Promise<string> {
  const token = new AccessToken(options.connection.apiKey, options.connection.apiSecret, {
    identity: options.evaluatorIdentity,
    name: "AgentVoice shutdown probe",
    ttl: "5m",
  });
  token.addGrant({
    roomCreate: true,
    roomJoin: true,
    room: options.roomName,
    canPublish: false,
    canSubscribe: false,
    canPublishData: false,
  });
  token.roomConfig = new RoomConfiguration({
    name: options.roomName,
    emptyTimeout: 30,
    departureTimeout: 10,
    maxParticipants: 2,
    agents: [new RoomAgentDispatch({ agentName: LIVEKIT_SHUTDOWN_PROBE_AGENT_NAME })],
  });
  return token.toJwt();
}

async function waitForFileContains(
  path: string,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (existsSync(path) && readFileSync(path, "utf8").includes(expected)) return;
    await Bun.sleep(25);
  }
  const observed = existsSync(path) ? readFileSync(path, "utf8") : "<missing>";
  throw new Error(
    `file ${path} did not contain ${JSON.stringify(expected)} within ${timeoutMs}ms; ` +
      `observed ${JSON.stringify(observed)}`,
  );
}

export async function createLiveKitEvaluatorToken(options: {
  connection: LiveKitConnection;
  roomName: string;
  evaluatorIdentity: string;
  jobMetadata: LiveKitJobMetadata;
}): Promise<string> {
  const token = new AccessToken(options.connection.apiKey, options.connection.apiSecret, {
    identity: options.evaluatorIdentity,
    name: "AgentVoice evaluator",
    ttl: "10m",
  });
  token.addGrant({
    roomCreate: true,
    roomJoin: true,
    room: options.roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
  });
  token.roomConfig = new RoomConfiguration({
    name: options.roomName,
    emptyTimeout: 60,
    departureTimeout: 30,
    maxParticipants: 2,
    agents: [
      new RoomAgentDispatch({
        agentName: LIVEKIT_AGENT_NAME,
        metadata: JSON.stringify(options.jobMetadata),
      }),
    ],
  });
  return token.toJwt();
}

async function executeLiveKitStep(
  step: ScenarioStep,
  index: number,
  audio: Map<string, Buffer>,
  uplink: LiveKitContinuousUplink,
  outputMonitor: LiveKitOutputMonitor,
  journal: EventJournal,
): Promise<void> {
  journal.record("harness", "scenario.step.started", { index, step });
  switch (step.type) {
    case "play": {
      const pcm = audio.get(step.id);
      if (!pcm) throw new Error(`no preloaded audio for step ${step.id}`);
      if (step.requireOutputActive && !outputMonitor.isOutputActive()) {
        throw new Error(`fixture utterance ${step.id} requires active output audio`);
      }
      journal.record("harness", "fixture.utterance", {
        id: step.id,
        transcript: step.transcript,
      });
      await uplink.play(step.id, pcm);
      break;
    }
    case "wait":
      if (step.after) {
        const anchor = await journal.waitFor(
          step.after.event,
          step.after.occurrence,
          step.timeoutMs,
        );
        await journal.waitForNext(step.event, anchor.seq, step.timeoutMs);
      } else {
        await journal.waitFor(step.event, step.occurrence!, step.timeoutMs);
      }
      break;
    case "sleep":
      await Bun.sleep(step.ms);
      break;
    case "drain":
      await outputMonitor.waitForOutputIdle(step.timeoutMs);
      break;
    case "wait-output-active":
      await outputMonitor.waitForOutputActive(step.timeoutMs);
      break;
  }
  journal.record("harness", "scenario.step.completed", { index, type: step.type });
}

function assertLiveKitScenarioIdentity(loaded: LoadedScenario): void {
  if (loaded.scenario.agent.orchestratorModel !== FX_ORCHESTRATOR_MODEL) {
    throw new Error(
      `LiveKit scenario requires orchestrator ${FX_ORCHESTRATOR_MODEL}; observed ` +
        loaded.scenario.agent.orchestratorModel,
    );
  }
  if (loaded.scenario.agent.reasoningEffort !== FX_REASONING_EFFORT) {
    throw new Error(
      `LiveKit scenario requires orchestrator effort ${FX_REASONING_EFFORT}; observed ` +
        loaded.scenario.agent.reasoningEffort,
    );
  }
}

async function runOracle(
  loaded: LoadedScenario,
  workspace: string,
  journal: EventJournal,
): Promise<OracleResult> {
  const oracle = loaded.scenario.oracle;
  if (!oracle) throw new Error("scenario has no oracle");
  const started = performance.now();
  const environment: NodeJS.ProcessEnv = {
    ...environmentWithoutOpenAiApiKey(),
    AGENTVOICE_EVAL_WORKSPACE: workspace,
  };
  const child = Bun.spawn(oracle.command, {
    cwd: loaded.directory,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timedOut = Bun.sleep(oracle.timeoutMs).then(() => "timeout" as const);
  const completed = child.exited.then((exitCode) => ({ exitCode }));
  const outcome = await Promise.race([completed, timedOut]);
  if (outcome === "timeout") {
    child.kill("SIGKILL");
    await child.exited;
  }
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const exitCode = outcome === "timeout" ? 124 : outcome.exitCode;
  const parsed = parseJson(stdout);
  const evidence = validateOracleEvidence(parsed, exitCode);
  const result: OracleResult = {
    command: oracle.command,
    exitCode,
    durationMs: performance.now() - started,
    stdout,
    stderr,
    parsed,
    ...evidence,
  };
  journal.record("oracle", "oracle.completed", {
    exitCode,
    durationMs: result.durationMs,
  });
  return result;
}

function uniqueArtifactDirectory(root: string, scenario: string, contender: string): string {
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const base = join(root, `${stamp}-${scenario}-${contender}`);
  let candidate = base;
  let suffix = 1;
  while (existsSync(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

async function writeWorkspaceDiff(
  before: string,
  after: string,
  destination: string,
): Promise<void> {
  const child = Bun.spawn(["diff", "-ruN", before, after], {
    env: environmentWithoutOpenAiApiKey(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code > 1) throw new Error(`workspace diff failed: ${stderr.trim()}`);
  writeFileSync(destination, stdout);
}

function createFatalSignal(): FatalSignal {
  let rejectFatal: ((error: Error) => void) | null = null;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectFatal = reject;
  });
  void promise.catch(() => {});
  return {
    promise,
    fail(error) {
      rejectFatal?.(error);
      rejectFatal = null;
    },
  };
}

function raceFatals<T>(operation: Promise<T>, fatals: readonly Promise<never>[]): Promise<T> {
  return Promise.race([operation, ...fatals]);
}

function dependencyVersions(): Record<string, string | null> {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  const dependencies = isRecord(manifest["dependencies"]) ? manifest["dependencies"] : {};
  return {
    livekitAgents: stringOrNull(dependencies["@livekit/agents"]),
    livekitOpenAI: stringOrNull(dependencies["@livekit/agents-plugin-openai"]),
    livekitProtocol: stringOrNull(dependencies["@livekit/protocol"]),
    livekitRtcNode: stringOrNull(dependencies["@livekit/rtc-node"]),
    livekitServerSdk: stringOrNull(dependencies["livekit-server-sdk"]),
  };
}

function redactUnknown(value: unknown, secret: string): unknown {
  if (typeof value === "string") return redactText(value, secret);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, secret));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, redactUnknown(child, secret)]),
  );
}

function redactText(value: string, secret: string): string {
  let redacted = secret.length >= 6 ? value.split(secret).join("[REDACTED_OPENAI_KEY]") : value;
  redacted = redacted.replace(
    /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}\b/g,
    "[REDACTED_OPENAI_KEY]",
  );
  return redacted;
}

function safeError(error: unknown, secret: string): Error {
  return new Error(redactText(error instanceof Error ? error.message : String(error), secret));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
