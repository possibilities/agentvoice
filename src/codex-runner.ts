import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppServerClient, type AppServerExecutionProfile } from "./app-server.ts";
import { ContinuousUplink, DuplexRecorder } from "./audio.ts";
import { EventJournal } from "./events.ts";
import { loadVerifiedFixtureAudio } from "./fixture-audio.ts";
import { environmentWithoutOpenAiApiKey } from "./local-env.ts";
import { RealtimePeer } from "./realtime-peer.ts";
import {
  assertCodexReferenceVersion,
  assertCodexReferenceVoiceModel,
  CODEX_REFERENCE,
} from "./reference.ts";
import { type CodexRunValidationResult, validateCodexRunEvents } from "./run-validation.ts";
import { type LoadedScenario, loadScenario, type ScenarioStep } from "./scenario.ts";

const VERSION = "0.1.0";
const START_TIMEOUT_MS = 60_000;

export interface RunOptions {
  scenarioPath: string;
  artifactsRoot?: string;
  codexPath?: string;
}

export interface OracleResult {
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

export interface OpenSessionOptions {
  workspace: string;
  voiceModel: string;
  voice: string;
  orchestratorModel: string;
  reasoningEffort: string;
  includeStartupContext: boolean;
  codexPath?: string;
  appServerCommand?: readonly string[];
  appServerExecutionProfile?: AppServerExecutionProfile;
  clientManagedHandoffs?: boolean;
  delegationAckFiller?: boolean;
  recordCanonicalCodexTurns?: boolean;
  onNotification?(method: string, params: Record<string, unknown>): void;
  journal: EventJournal;
  stderr: string[];
}

export interface OpenSession {
  appServer: AppServerClient;
  peer: RealtimePeer;
  recorder: DuplexRecorder;
  uplink: ContinuousUplink;
  threadId: string;
  realtimeSessionId: string;
  voices: unknown;
  appServerCwd: string;
  fatal: Promise<never>;
}

export async function runCodexScenario(options: RunOptions): Promise<string> {
  const loaded = await loadScenario(options.scenarioPath);
  assertCodexReferenceVoiceModel(loaded.scenario.agent.voiceModel);
  const fixtureAudio = await loadVerifiedFixtureAudio(loaded);
  const audio = fixtureAudio.pcmByStepId;
  const codexVersion = await commandVersion(options.codexPath ?? "codex");
  assertCodexReferenceVersion(codexVersion);
  const artifactsRoot = resolve(options.artifactsRoot ?? "artifacts");
  const artifactDirectory = uniqueArtifactDirectory(artifactsRoot, loaded.scenario.id, "codex");
  mkdirSync(artifactDirectory, { recursive: true });
  writeFileSync(join(artifactDirectory, "fixture-audio-receipt.json"), fixtureAudio.receiptBytes);

  const scratch = mkdtempSync(join(tmpdir(), "agentvoice-eval-"));
  const workspace = join(scratch, "workspace");
  cpSync(loaded.workspace, workspace, { recursive: true });
  cpSync(workspace, join(artifactDirectory, "workspace-before"), { recursive: true });

  const journal = new EventJournal();
  const stderr: string[] = [];
  const startedAt = new Date();
  let session: OpenSession | null = null;
  let oracle: OracleResult | null = null;
  let validation: CodexRunValidationResult | null = null;
  let status: "completed" | "failed" = "completed";
  let failure: string | null = null;
  let audioDurationMs = 0;

  try {
    journal.record("harness", "run.started", {
      scenario: loaded.scenario.id,
      contender: "codex",
    });
    session = await openSession({
      workspace,
      ...loaded.scenario.agent,
      ...(options.codexPath ? { codexPath: options.codexPath } : {}),
      journal,
      stderr,
    });

    for (let index = 0; index < loaded.scenario.steps.length; index++) {
      const step = loaded.scenario.steps[index]!;
      await Promise.race([
        executeStep(step, index, audio, session.uplink, session.peer, journal),
        session.fatal,
      ]);
    }
    validation = validateCodexRunEvents(journal.snapshot(), { rootThreadId: session.threadId });
    journal.record("harness", "run.validation.passed", { ...validation });
    journal.record("harness", "scenario.completed");
  } catch (error) {
    status = "failed";
    failure = message(error);
    journal.record("harness", "run.failed", { message: failure });
  } finally {
    if (session) {
      await stopSession(session, journal);
      audioDurationMs = (await session.recorder.write(artifactDirectory)).durationMs;
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
        stderr: message(error),
        parsed: null,
        valid: false,
        validationError: message(error),
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
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`,
    );
    writeFileSync(join(artifactDirectory, "app-server.stderr.log"), stderr.join(""));
    if (oracle) {
      writeFileSync(join(artifactDirectory, "oracle.json"), `${JSON.stringify(oracle, null, 2)}\n`);
    }
    const manifest = {
      schemaVersion: 1,
      contender: "codex",
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
      },
      fixtureAudio: {
        provenance: fixtureAudio.provenance,
        utterances: fixtureAudio.evidence,
      },
      runtime: {
        harnessVersion: VERSION,
        codexVersion,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        audioDurationMs,
        threadId: session?.threadId ?? null,
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
        workspacePatch: "workspace.patch",
        oracle: oracle ? "oracle.json" : null,
      },
    };
    writeFileSync(
      join(artifactDirectory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    rmSync(scratch, { recursive: true, force: true });
  }

  if (status === "failed") {
    throw new Error(`Codex scenario failed: ${failure}; artifacts: ${artifactDirectory}`);
  }
  return artifactDirectory;
}

export async function probeCodexVoice(codexPath = "codex"): Promise<Record<string, unknown>> {
  const scratch = mkdtempSync(join(tmpdir(), "agentvoice-probe-"));
  const workspace = join(scratch, "workspace");
  mkdirSync(workspace);
  const journal = new EventJournal();
  const stderr: string[] = [];
  let session: OpenSession | null = null;
  try {
    const codexVersion = await commandVersion(codexPath);
    assertCodexReferenceVersion(codexVersion);
    session = await openSession({
      workspace,
      voiceModel: CODEX_REFERENCE.voiceModel,
      voice: CODEX_REFERENCE.voice,
      orchestratorModel: CODEX_REFERENCE.orchestratorModel,
      reasoningEffort: CODEX_REFERENCE.reasoningEffort,
      includeStartupContext: CODEX_REFERENCE.includeStartupContext,
      codexPath,
      journal,
      stderr,
    });
    const voiceSession = await journal.waitFor("voice.session.started", 1, 10_000);
    return {
      ok: true,
      codexVersion,
      voiceModel: CODEX_REFERENCE.voiceModel,
      voiceModelSelection: CODEX_REFERENCE.voiceModelSelection,
      requestedVoiceModel: null,
      observedVoiceModel: voiceSession.data["model"] ?? null,
      voice: CODEX_REFERENCE.voice,
      voiceProtocol: CODEX_REFERENCE.voiceProtocol,
      orchestratorModel: CODEX_REFERENCE.orchestratorModel,
      reasoningEffort: CODEX_REFERENCE.reasoningEffort,
      voices: session.voices,
      events: journal.snapshot().map((event) => event.type),
    };
  } finally {
    if (session) await stopSession(session, journal);
    journal.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function openSession(options: OpenSessionOptions): Promise<OpenSession> {
  const appServerCwd = mkdtempSync(join(tmpdir(), "agentvoice-app-server-"));
  const recorder = new DuplexRecorder();
  const peer = new RealtimePeer(options.journal, recorder);
  let appServer: AppServerClient | null = null;
  let uplink: ContinuousUplink | null = null;
  let realtimeStartFailure: ((params: Record<string, unknown>) => void) | null = null;
  let rootThreadId: string | null = null;
  let rejectFatalSession: ((error: Error) => void) | null = null;
  const fatal = new Promise<never>((_resolve, reject) => {
    rejectFatalSession = reject;
  });
  // Startup races the same error independently. Keep this long-lived signal
  // observed if a failure arrives before openSession can return it.
  void fatal.catch(() => {});

  try {
    appServer = await AppServerClient.start({
      ...(options.codexPath ? { codexPath: options.codexPath } : {}),
      ...(options.appServerCommand ? { command: options.appServerCommand } : {}),
      ...(options.appServerExecutionProfile
        ? {
            executionProfile: options.appServerExecutionProfile,
            onIsolationEvent(event, evidence) {
              const type =
                event === "child-observed"
                  ? "sidecar.child.observed"
                  : event === "observation-error"
                    ? "sidecar.child-observation.error"
                    : `sidecar.isolation.${event}`;
              options.journal.record("app-server", type, { ...evidence });
            },
          }
        : {}),
      cwd: appServerCwd,
      clientVersion: VERSION,
      onNotification(method, params) {
        options.journal.record("app-server", `appserver.${method}`, sanitize(params));
        if (rootThreadId !== null && options.recordCanonicalCodexTurns !== false) {
          recordRootTurnNotification(options.journal, method, params, rootThreadId);
        }
        options.onNotification?.(method, params);
        if (method === "thread/realtime/error") {
          options.journal.record("app-server", "voice.error", sanitize(params));
          realtimeStartFailure?.(params);
          rejectFatalSession?.(new Error(`thread/realtime/error: ${notificationMessage(params)}`));
          rejectFatalSession = null;
        }
      },
      onProtocolMessage(direction, message) {
        options.journal.record("app-server", `appserver.rpc.${direction}`, sanitize(message));
      },
      onStderr(text) {
        options.stderr.push(text);
      },
    });
    const voices = await appServer.request("thread/realtime/listVoices", {});
    options.journal.record("app-server", "voice.listed", {
      response: sanitizeUnknown(voices),
    });
    const thread = await appServer.request("thread/start", {
      cwd: options.workspace,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      model: options.orchestratorModel,
      ephemeral: true,
      config: { model_reasoning_effort: options.reasoningEffort },
    });
    const threadId = extractThreadId(thread);
    rootThreadId = threadId;
    options.journal.record(
      "app-server",
      options.recordCanonicalCodexTurns === false
        ? "voice.thread.started"
        : "orchestrator.thread.started",
      { threadId },
    );

    const offer = await peer.createOffer();
    const realtimeSessionId = crypto.randomUUID();
    const started = appServer.waitForNotification(
      "thread/realtime/started",
      (params) => params["realtimeSessionId"] === realtimeSessionId,
      START_TIMEOUT_MS,
    );
    const answer = appServer.waitForNotification(
      "thread/realtime/sdp",
      (params) => typeof params["sdp"] === "string",
      START_TIMEOUT_MS,
    );
    const failed = new Promise<never>((_resolve, reject) => {
      realtimeStartFailure = (params) => {
        reject(new Error(`thread/realtime/error: ${notificationMessage(params)}`));
      };
    });
    const startRequest = appServer.request(
      "thread/realtime/start",
      {
        threadId,
        realtimeSessionId,
        version: "v3",
        voice: options.voice,
        outputModality: "audio",
        includeStartupContext: options.includeStartupContext,
        ...(options.clientManagedHandoffs !== undefined
          ? { clientManagedHandoffs: options.clientManagedHandoffs }
          : {}),
        ...(options.delegationAckFiller !== undefined
          ? { delegationAckFiller: options.delegationAckFiller }
          : {}),
        transport: { type: "webrtc", sdp: offer },
      },
      START_TIMEOUT_MS,
    );
    const [, , answerParams] = await Promise.race([
      Promise.all([startRequest, started, answer]),
      failed,
    ]).finally(() => {
      realtimeStartFailure = null;
    });
    const sdp = answerParams["sdp"];
    if (typeof sdp !== "string") throw new Error("App-server SDP notification had no SDP");
    uplink = new ContinuousUplink({
      sendOpus: (payload) => peer.sendOpus(payload),
      recorder,
      journal: options.journal,
    });
    // Start the recording clock before applying the answer so both channels
    // share one origin even if downlink audio arrives immediately.
    uplink.start();
    await peer.applyAnswer(sdp);
    await peer.waitConnected(START_TIMEOUT_MS);
    options.journal.record("harness", "session.connected", {
      threadId,
      realtimeSessionId,
      voiceModel: options.voiceModel,
      voice: options.voice,
    });

    return {
      appServer,
      peer,
      recorder,
      uplink,
      threadId,
      realtimeSessionId,
      voices,
      appServerCwd,
      fatal,
    };
  } catch (error) {
    uplink?.stop();
    await peer.close().catch(() => {});
    await appServer?.close().catch(() => {});
    rmSync(appServerCwd, { recursive: true, force: true });
    const stderr = options.stderr.join("").trim();
    throw new Error(`${message(error)}${stderr ? `\nApp-server stderr:\n${stderr}` : ""}`);
  }
}

export async function stopSession(session: OpenSession, journal: EventJournal): Promise<void> {
  session.uplink.stop();
  try {
    const closed = session.appServer.waitForNotification(
      "thread/realtime/closed",
      () => true,
      15_000,
    );
    await session.appServer.request("thread/realtime/stop", { threadId: session.threadId }, 15_000);
    await closed;
  } catch (error) {
    journal.record("harness", "session.stop-error", { message: message(error) });
  }
  await session.peer.close().catch(() => {});
  await session.appServer
    .request("thread/delete", { threadId: session.threadId }, 10_000)
    .catch(() => {});
  await session.appServer.close().catch(() => {});
  rmSync(session.appServerCwd, { recursive: true, force: true });
  journal.record("harness", "session.closed");
}

export async function executeStep(
  step: ScenarioStep,
  index: number,
  audio: Map<string, Buffer>,
  uplink: ContinuousUplink,
  peer: RealtimePeer,
  journal: EventJournal,
): Promise<void> {
  journal.record("harness", "scenario.step.started", { index, step });
  switch (step.type) {
    case "play": {
      const pcm = audio.get(step.id);
      if (!pcm) throw new Error(`no preloaded audio for step ${step.id}`);
      if (step.requireOutputActive && !peer.isOutputActive()) {
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
      await peer.waitForOutputIdle(step.timeoutMs);
      break;
    case "wait-output-active":
      await peer.waitForOutputActive(step.timeoutMs);
      break;
  }
  journal.record("harness", "scenario.step.completed", { index, type: step.type });
}

export async function runOracle(
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

export function uniqueArtifactDirectory(root: string, scenario: string, contender: string): string {
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const base = join(root, `${stamp}-${scenario}-${contender}`);
  let candidate = base;
  let suffix = 1;
  while (existsSync(candidate)) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
}

export async function commandVersion(command: string): Promise<string> {
  const child = Bun.spawn([command, "--version"], {
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
  if (code !== 0) throw new Error(`${command} --version failed: ${stderr.trim()}`);
  return stdout.trim();
}

export async function writeWorkspaceDiff(
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

function extractThreadId(result: unknown): string {
  if (!isRecord(result) || !isRecord(result["thread"])) {
    throw new Error("thread/start returned no thread");
  }
  const id = result["thread"]["id"];
  if (typeof id !== "string") throw new Error("thread/start returned no thread id");
  return id;
}

function turnSummary(params: Record<string, unknown>): Record<string, unknown> {
  const turn = isRecord(params["turn"]) ? params["turn"] : {};
  return {
    threadId: typeof params["threadId"] === "string" ? params["threadId"] : null,
    turnId: typeof turn["id"] === "string" ? turn["id"] : null,
    status: typeof turn["status"] === "string" ? turn["status"] : null,
    error: sanitizeUnknown(turn["error"]),
  };
}

export function recordRootTurnNotification(
  journal: EventJournal,
  method: string,
  params: Record<string, unknown>,
  rootThreadId: string,
): boolean {
  if (params["threadId"] !== rootThreadId) return false;
  if (method === "turn/started") {
    journal.record("app-server", "orchestrator.turn.started", turnSummary(params));
    return true;
  }
  if (method === "turn/completed") {
    journal.record("app-server", "orchestrator.turn.completed", turnSummary(params));
    return true;
  }
  return false;
}

function sanitize(params: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(params);
  redactLargeBase64(copy);
  return copy;
}

function sanitizeUnknown(value: unknown): unknown {
  if (!isRecord(value) && !Array.isArray(value)) return value ?? null;
  const copy = structuredClone(value);
  redactLargeBase64(copy);
  return copy;
}

function redactLargeBase64(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) redactLargeBase64(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (
      typeof child === "string" &&
      child.length > 1_000 &&
      (key.toLowerCase().includes("audio") || key.toLowerCase().includes("data"))
    ) {
      value[key] = `[omitted ${child.length} chars]`;
    } else {
      redactLargeBase64(child);
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function validateOracleEvidence(
  parsed: unknown,
  exitCode: number,
): Pick<OracleResult, "valid" | "validationError" | "score"> {
  const issues: string[] = [];
  if (exitCode !== 0) issues.push(`oracle exited with code ${exitCode}`);
  if (!isRecord(parsed)) {
    issues.push("oracle stdout was not a JSON object");
    return { valid: false, validationError: issues.join("; "), score: null };
  }
  const score = parsed["score"];
  const passed = parsed["passed"];
  const total = parsed["total"];
  const checks = parsed["checks"];
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
    issues.push("score must be a finite number from 0 through 1");
  }
  if (typeof passed !== "number" || !Number.isInteger(passed) || passed < 0) {
    issues.push("passed must be a non-negative integer");
  }
  if (typeof total !== "number" || !Number.isInteger(total) || total < 1) {
    issues.push("total must be a positive integer");
  }
  if (!Array.isArray(checks)) {
    issues.push("checks must be an array");
  } else if (typeof total === "number" && checks.length !== total) {
    issues.push(`checks length ${checks.length} did not match total ${total}`);
  }
  if (
    typeof passed === "number" &&
    typeof total === "number" &&
    Number.isInteger(passed) &&
    Number.isInteger(total) &&
    total > 0 &&
    passed > total
  ) {
    issues.push(`passed ${passed} exceeded total ${total}`);
  }
  if (
    typeof score === "number" &&
    typeof passed === "number" &&
    typeof total === "number" &&
    total > 0 &&
    Math.abs(score - passed / total) > 1e-9
  ) {
    issues.push("score did not equal passed / total");
  }
  return {
    valid: issues.length === 0,
    validationError: issues.length > 0 ? issues.join("; ") : null,
    score: typeof score === "number" && Number.isFinite(score) ? score : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notificationMessage(params: Record<string, unknown>): string {
  if (typeof params["message"] === "string") return params["message"];
  return JSON.stringify(sanitize(params));
}
