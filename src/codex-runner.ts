import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppServerClient } from "./app-server.ts";
import { ContinuousUplink, DuplexRecorder, normalizeAudioToMonoPcm } from "./audio.ts";
import { EventJournal } from "./events.ts";
import { RealtimePeer } from "./realtime-peer.ts";
import {
  assertCodexReferenceVersion,
  assertCodexReferenceVoiceModel,
  CODEX_REFERENCE,
} from "./reference.ts";
import { type LoadedScenario, loadScenario, type ScenarioStep, stepAudioPath } from "./scenario.ts";

const VERSION = "0.1.0";
const START_TIMEOUT_MS = 60_000;

export interface RunOptions {
  scenarioPath: string;
  artifactsRoot?: string;
  codexPath?: string;
}

interface OracleResult {
  command: string[];
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  parsed: unknown;
}

interface OpenSessionOptions {
  workspace: string;
  voiceModel: string;
  voice: string;
  orchestratorModel: string;
  reasoningEffort: string;
  includeStartupContext: boolean;
  codexPath?: string;
  journal: EventJournal;
  stderr: string[];
}

interface OpenSession {
  appServer: AppServerClient;
  peer: RealtimePeer;
  recorder: DuplexRecorder;
  uplink: ContinuousUplink;
  threadId: string;
  realtimeSessionId: string;
  voices: unknown;
  appServerCwd: string;
}

export async function runCodexScenario(options: RunOptions): Promise<string> {
  const loaded = await loadScenario(options.scenarioPath);
  assertCodexReferenceVoiceModel(loaded.scenario.agent.voiceModel);
  const audio = await preloadScenarioAudio(loaded);
  const artifactsRoot = resolve(options.artifactsRoot ?? "artifacts");
  const artifactDirectory = uniqueArtifactDirectory(artifactsRoot, loaded.scenario.id, "codex");
  mkdirSync(artifactDirectory, { recursive: true });

  const scratch = mkdtempSync(join(tmpdir(), "agentvoice-eval-"));
  const workspace = join(scratch, "workspace");
  cpSync(loaded.workspace, workspace, { recursive: true });
  cpSync(workspace, join(artifactDirectory, "workspace-before"), { recursive: true });

  const journal = new EventJournal();
  const stderr: string[] = [];
  const startedAt = new Date();
  const codexVersion = await commandVersion(options.codexPath ?? "codex");
  assertCodexReferenceVersion(codexVersion);
  let session: OpenSession | null = null;
  let oracle: OracleResult | null = null;
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
      await executeStep(step, index, audio, session.uplink, journal);
    }
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
    if (loaded.scenario.oracle) {
      oracle = await runOracle(loaded, workspace, journal).catch((error) => ({
        command: loaded.scenario.oracle!.command,
        exitCode: -1,
        durationMs: 0,
        stdout: "",
        stderr: message(error),
        parsed: null,
      }));
    }
    cpSync(workspace, join(artifactDirectory, "workspace-after"), { recursive: true });
    await writeWorkspaceDiff(
      join(artifactDirectory, "workspace-before"),
      join(artifactDirectory, "workspace-after"),
      join(artifactDirectory, "workspace.patch"),
    );
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
      evidence: {
        events: "events.ndjson",
        inputAudio: session ? "input.wav" : null,
        outputAudio: session ? "output.wav" : null,
        comparisonAudio: session ? "comparison.wav" : null,
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

async function openSession(options: OpenSessionOptions): Promise<OpenSession> {
  const appServerCwd = mkdtempSync(join(tmpdir(), "agentvoice-app-server-"));
  const recorder = new DuplexRecorder();
  const peer = new RealtimePeer(options.journal, recorder);
  let appServer: AppServerClient | null = null;
  let uplink: ContinuousUplink | null = null;
  let realtimeStartFailure: ((params: Record<string, unknown>) => void) | null = null;

  try {
    appServer = await AppServerClient.start({
      ...(options.codexPath ? { codexPath: options.codexPath } : {}),
      cwd: appServerCwd,
      clientVersion: VERSION,
      onNotification(method, params) {
        options.journal.record("app-server", `appserver.${method}`, sanitize(params));
        if (method === "turn/started") {
          options.journal.record("app-server", "orchestrator.turn.started", turnSummary(params));
        } else if (method === "turn/completed") {
          options.journal.record("app-server", "orchestrator.turn.completed", turnSummary(params));
        } else if (method === "thread/realtime/error") {
          options.journal.record("app-server", "voice.error", sanitize(params));
          realtimeStartFailure?.(params);
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
    options.journal.record("app-server", "orchestrator.thread.started", { threadId });

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
    const ready = Promise.race([Promise.all([started, answer]), failed]).finally(() => {
      realtimeStartFailure = null;
    });
    await appServer.request(
      "thread/realtime/start",
      {
        threadId,
        realtimeSessionId,
        version: "v3",
        voice: options.voice,
        outputModality: "audio",
        includeStartupContext: options.includeStartupContext,
        transport: { type: "webrtc", sdp: offer },
      },
      START_TIMEOUT_MS,
    );
    const [, answerParams] = await ready;
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

async function stopSession(session: OpenSession, journal: EventJournal): Promise<void> {
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

async function executeStep(
  step: ScenarioStep,
  index: number,
  audio: Map<string, Buffer>,
  uplink: ContinuousUplink,
  journal: EventJournal,
): Promise<void> {
  journal.record("harness", "scenario.step.started", { index, step });
  switch (step.type) {
    case "play": {
      const pcm = audio.get(step.id);
      if (!pcm) throw new Error(`no preloaded audio for step ${step.id}`);
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
  }
  journal.record("harness", "scenario.step.completed", { index, type: step.type });
}

async function preloadScenarioAudio(loaded: LoadedScenario): Promise<Map<string, Buffer>> {
  const audio = new Map<string, Buffer>();
  for (const step of loaded.scenario.steps) {
    if (step.type !== "play") continue;
    if (audio.has(step.id)) throw new Error(`duplicate play step id: ${step.id}`);
    audio.set(step.id, await normalizeAudioToMonoPcm(stepAudioPath(loaded, step)));
  }
  return audio;
}

async function runOracle(
  loaded: LoadedScenario,
  workspace: string,
  journal: EventJournal,
): Promise<OracleResult> {
  const oracle = loaded.scenario.oracle;
  if (!oracle) throw new Error("scenario has no oracle");
  const started = performance.now();
  const child = Bun.spawn(oracle.command, {
    cwd: loaded.directory,
    env: { ...process.env, AGENTVOICE_EVAL_WORKSPACE: workspace },
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
  const result: OracleResult = {
    command: oracle.command,
    exitCode,
    durationMs: performance.now() - started,
    stdout,
    stderr,
    parsed: parseJson(stdout),
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
  while (existsSync(candidate)) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
}

async function commandVersion(command: string): Promise<string> {
  const child = Bun.spawn([command, "--version"], {
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

async function writeWorkspaceDiff(
  before: string,
  after: string,
  destination: string,
): Promise<void> {
  const child = Bun.spawn(["diff", "-ruN", before, after], {
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
