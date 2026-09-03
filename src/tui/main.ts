#!/usr/bin/env bun
/**
 * The bare-bones voice TUI: talk to an orchestrator agent through the
 * Codpiece voice sidecar, with the microphone opening muted and push-to-talk
 * as the way it goes live.
 *
 *   bun run tui -- --voice-sidecar PATH [--workspace DIR] [--backend fx-acp]
 */

import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Duplex } from "node:stream";
import { parseArgs } from "node:util";
import { CodexFxBridge } from "../codex-fx-bridge.ts";
import { EventJournal } from "../events.ts";
import { FxAcpAdapter } from "../fx-acp-adapter.ts";
import { FxHeadlessOrchestrator } from "../fx-orchestrator.ts";
import type { OrchestratorAdapter, OrchestratorAgentState } from "../orchestrator-adapter.ts";
import { CODEX_REFERENCE } from "../reference.ts";
import { createVoiceApp, type VoiceAppInput, type VoiceAppState } from "./app.ts";
import { DuplexVoiceAudio } from "./duplex-audio.ts";
import { duplexAudioAvailabilityError } from "./duplex-device.ts";
import { type AudioTarget, MuteGate } from "./mute-gate.ts";
import { describeSidecar, VoiceSession } from "./voice-session.ts";
import { type VoicePhase, VoiceTransport } from "./voice-transport.ts";

const FEED_LIMIT = 200;
const BACKENDS = ["fx-acp", "fx-work-control"] as const;
type Backend = (typeof BACKENDS)[number];

interface Options {
  sidecarPath: string;
  workspace: string;
  backend: Backend;
  model: string;
  reasoningEffort: string;
  voice: string;
  fxPath: string | undefined;
  micIndex: number | undefined;
  speakerIndex: number | undefined;
  startUnmuted: boolean;
  startupContext: boolean;
  debugLog: string | undefined;
}

function usage(): never {
  console.error(
    [
      "usage: bun run tui -- --voice-sidecar PATH [options]",
      "",
      "  --voice-sidecar PATH   Codpiece voice sidecar binary (metadata.json beside it)",
      "  --workspace DIR        directory the orchestrator agent works in (default: cwd)",
      `  --backend NAME         ${BACKENDS.join(" | ")} (default: fx-acp)`,
      `  --model ID             orchestrator model (default: ${CODEX_REFERENCE.orchestratorModel})`,
      `  --effort NAME          reasoning effort (default: ${CODEX_REFERENCE.reasoningEffort})`,
      `  --voice NAME           voice timbre (default: ${CODEX_REFERENCE.voice})`,
      "  --fx PATH              fx executable (default: fx on PATH)",
      "  --mic INDEX            capture device index (default: system default)",
      "  --speaker INDEX        playback device index (default: system default)",
      "  --unmuted              open the microphone live instead of muted",
      "  --no-startup-context   do not prime the voice agent with startup context",
      "  --debug-log PATH       write the event journal here on exit",
    ].join("\n"),
  );
  process.exit(64);
}

function parseOptions(argv: string[]): Options {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        "voice-sidecar": { type: "string" },
        workspace: { type: "string" },
        backend: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        voice: { type: "string" },
        fx: { type: "string" },
        mic: { type: "string" },
        speaker: { type: "string" },
        unmuted: { type: "boolean" },
        "no-startup-context": { type: "boolean" },
        "debug-log": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
  }
  const values = parsed.values as Record<string, string | boolean | undefined>;
  if (values["help"]) usage();
  const sidecarPath = values["voice-sidecar"];
  if (typeof sidecarPath !== "string") usage();
  const backend = values["backend"] ?? "fx-acp";
  if (!BACKENDS.includes(backend as Backend)) usage();
  return {
    sidecarPath,
    workspace: resolve(typeof values["workspace"] === "string" ? values["workspace"] : "."),
    backend: backend as Backend,
    model:
      typeof values["model"] === "string" ? values["model"] : CODEX_REFERENCE.orchestratorModel,
    reasoningEffort:
      typeof values["effort"] === "string" ? values["effort"] : CODEX_REFERENCE.reasoningEffort,
    voice: typeof values["voice"] === "string" ? values["voice"] : CODEX_REFERENCE.voice,
    fxPath: typeof values["fx"] === "string" ? values["fx"] : undefined,
    micIndex: deviceIndex(values["mic"]),
    speakerIndex: deviceIndex(values["speaker"]),
    startUnmuted: values["unmuted"] === true,
    startupContext: values["no-startup-context"] !== true,
    debugLog: typeof values["debug-log"] === "string" ? values["debug-log"] : undefined,
  };
}

function deviceIndex(value: string | boolean | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) usage();
  return index;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const audioError = duplexAudioAvailabilityError();
  if (audioError) {
    console.error(audioError);
    process.exit(1);
  }
  const sidecar = describeSidecar(options.sidecarPath);

  const fxPath = resolveFx(options.fxPath);

  const journal = new EventJournal();
  const feed: string[] = [];
  const say = (line: string): void => {
    feed.push(line);
    if (feed.length > FEED_LIMIT) feed.splice(0, feed.length - FEED_LIMIT);
    journal.record("harness", "feed", { line });
  };

  console.error(
    `starting ${options.backend} orchestrator (${options.model}, ${options.reasoningEffort})…`,
  );
  const adapter: OrchestratorAdapter =
    options.backend === "fx-acp"
      ? new FxAcpAdapter({
          workspace: options.workspace,
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          fxPath,
          ...(sidecar.requiresFxCredentialAuthority ? { credentialBroker: true } : {}),
        })
      : new FxHeadlessOrchestrator({
          workspace: options.workspace,
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          fxPath,
          ...(sidecar.requiresFxCredentialAuthority
            ? { credentialBroker: { proofMode: "none" as const } }
            : {}),
        });
  let backendState: OrchestratorAgentState | "stopped" = "idle";
  let backendDetail: string | null = null;
  adapter.onLifecycle((event) => {
    backendState = event.type === "orchestrator.stopped" ? "stopped" : event.agentState;
    switch (event.type) {
      case "turn.started": {
        const text = typeof event.data["text"] === "string" ? event.data["text"] : null;
        backendDetail = `turn ${event.turnId ?? "?"}`;
        say(`fx · working${text ? ` · ${clip(text, 60)}` : ""}`);
        break;
      }
      case "turn.ended":
        backendDetail = null;
        say(`fx · ${String(event.data["outcome"] ?? "ended")}`);
        break;
      case "attention.raised":
        backendDetail = `needs ${event.attentionKind ?? "attention"}`;
        say(`fx · blocked on ${event.attentionKind ?? "attention"}`);
        break;
      case "attention.cleared":
        backendDetail = null;
        break;
      case "orchestrator.stopped":
        backendDetail = String(event.data["reason"] ?? "");
        say("fx · stopped");
        break;
      default:
        break;
    }
  });
  const startupCleanups: Array<() => Promise<unknown>> = [() => adapter.stop()];
  const identity = await adapter.start();
  const backendName = `${identity.backend} · ${identity.model}/${identity.reasoningEffort}`;

  console.error(`launching voice sidecar ${sidecar.sourceRevision ?? "(unknown revision)"}…`);
  let bridge: CodexFxBridge | null = null;
  const earlyNotifications: [string, Record<string, unknown>][] = [];
  let transport: VoiceTransport | null = null;
  const session = await startupStep(startupCleanups, () =>
    VoiceSession.start({
      sidecarPath: sidecar.binaryPath,
      workspace: options.workspace,
      voice: options.voice,
      orchestratorModel: options.model,
      reasoningEffort: options.reasoningEffort,
      includeStartupContext: options.startupContext,
      journal,
      ...(sidecar.requiresFxCredentialAuthority
        ? { credentialAuthority: acquireCredentialChannel(adapter) }
        : {}),
      onNotification(method, params) {
        if (bridge) bridge.handleNotification(method, params);
        else earlyNotifications.push([method, params]);
      },
      onClosed: (reason) => transport?.handleClosed(reason),
      onError: (message) => say(`sidecar · ${message}`),
    }),
  );
  startupCleanups.unshift(() => session.close());
  bridge = new CodexFxBridge({
    appServer: session.appServer,
    threadId: session.threadId,
    orchestrator: adapter,
    journal,
  });
  for (const [method, params] of earlyNotifications.splice(0)) {
    bridge.handleNotification(method, params);
  }

  const meters = { mic: -Infinity, agent: -Infinity };
  const microphone = new MuteGate(!options.startUnmuted);
  const speaker = new MuteGate(false);
  const holdSources: Record<VoiceAppInput, Record<AudioTarget, symbol>> = {
    key: { mic: Symbol("mic-key"), speaker: Symbol("speaker-key") },
    space: { mic: Symbol("mic-space"), speaker: Symbol("speaker-space") },
  };
  const audio = new DuplexVoiceAudio({
    ...(options.micIndex !== undefined ? { deviceIndex: options.micIndex } : {}),
    ...(options.speakerIndex !== undefined ? { outputDeviceIndex: options.speakerIndex } : {}),
    sendFrame: (frame) => transport?.sendOpusFrame(frame),
    onMicLevel: (db) => {
      meters.mic = db;
    },
    onAgentLevel: (db) => {
      meters.agent = db;
    },
    onWarning: say,
    debug: (line) => journal.record("media", "audio.debug", { line }),
  });
  audio.micMuted = microphone.effectiveMuted;

  let phase: VoicePhase = "idle";
  transport = new VoiceTransport({
    signal: {
      start: (offer) => session.startRealtime(offer),
      stop: () => session.stopRealtime(),
    },
    onPhase: (next) => {
      phase = next;
    },
    onRemoteTrack: (track) => audio.attachRemote(track),
    onOaiEvent: (event) => describeOaiEvent(event, say),
    onInfo: say,
    onError: say,
    debug: (line) => journal.record("realtime", "transport.debug", { line }),
  });

  function gate(target: AudioTarget): MuteGate {
    return target === "mic" ? microphone : speaker;
  }

  function applyMute(target: AudioTarget, changed: boolean): void {
    if (!changed) return;
    const current = gate(target);
    if (target === "mic") audio.micMuted = current.effectiveMuted;
    else audio.speakerMuted = current.effectiveMuted;
    const talking = target === "mic" && current.muted && !current.effectiveMuted;
    say(
      `${target === "mic" ? "microphone" : "speaker"} ${talking ? "talking" : current.effectiveMuted ? "muted" : "live"}`,
    );
  }

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    await transport?.stop().catch(() => {});
    await audio.stop().catch(() => {});
    bridge?.close();
    await session.close().catch(() => {});
    await adapter.stop().catch(() => {});
    if (options.debugLog) {
      writeFileSync(
        options.debugLog,
        `${journal
          .snapshot()
          .map((event) => JSON.stringify(event))
          .join("\n")}\n`,
      );
    }
  }

  say(
    `sidecar ${sidecar.sourceRevision?.slice(0, 10) ?? "unknown"} · schema ${sidecar.schemaVersion}`,
  );
  say(`backend ${backendName} · ${identity.auth ?? "auth unknown"}`);
  say(microphone.muted ? "microphone opens muted · hold space to talk" : "microphone is live");

  await startupStep(startupCleanups, () => audio.start());
  startupCleanups.unshift(() => audio.stop());
  const app = await startupStep(startupCleanups, () =>
    createVoiceApp({
      state: (): VoiceAppState => ({
        title: "codpiece",
        phase,
        liveForMs: transport?.liveForMs ?? null,
        backend: { name: backendName, state: backendState, detail: backendDetail },
        mic: { muted: microphone.muted, effectiveMuted: microphone.effectiveMuted, db: meters.mic },
        speaker: {
          muted: speaker.muted,
          effectiveMuted: speaker.effectiveMuted,
          db: meters.agent,
        },
        feed,
      }),
      setMuted: (target, muted) => applyMute(target, gate(target).setMuted(muted)),
      beginUnmute: (target, input) =>
        applyMute(target, gate(target).beginUnmute(holdSources[input][target])),
      releaseUnmute: (target, input, commit) =>
        applyMute(target, gate(target).releaseUnmute(holdSources[input][target], commit)),
      redial: () => void transport?.redial("manual"),
      shutdown,
    }),
  );

  say("dialing the voice agent…");
  void transport.connect().catch((error) => say(`voice · ${message(error)}`));
  await app.done;
}

/** Both backends serve Fx's credential broker; the sidecar only sees descriptor 3. */
function acquireCredentialChannel(adapter: OrchestratorAdapter): Duplex {
  if (adapter instanceof FxAcpAdapter || adapter instanceof FxHeadlessOrchestrator) {
    return adapter.acquireCredentialBrokerChannel();
  }
  throw new Error(`backend ${adapter.backend} cannot serve Fx credential authority`);
}

/** Runs one startup step; on failure, unwinds every earlier step before rethrowing. */
async function startupStep<T>(
  cleanups: Array<() => Promise<unknown>>,
  step: () => Promise<T>,
): Promise<T> {
  try {
    return await step();
  } catch (error) {
    for (const cleanup of cleanups) await cleanup().catch(() => {});
    throw error;
  }
}

/** `fx` on PATH, else the user-local install, else a message that says where to put it. */
function resolveFx(explicit: string | undefined): string {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`fx not found at ${explicit}`);
    return explicit;
  }
  const onPath = Bun.which("fx");
  if (onPath) return onPath;
  const userLocal = resolve(homedir(), ".local", "bin", "fx");
  if (existsSync(userLocal)) return userLocal;
  throw new Error("fx not found on PATH or at ~/.local/bin/fx; install Fx or pass --fx PATH");
}

/** Turns the voice agent's data-channel events into feed lines. */
export function describeOaiEvent(
  event: Record<string, unknown>,
  say: (line: string) => void,
): void {
  const type = typeof event["type"] === "string" ? event["type"] : "";
  if (type === "session.started" || type === "session.created" || type === "session.updated") {
    const session = isRecord(event["session"]) ? event["session"] : {};
    const model = typeof session["model"] === "string" ? ` · ${session["model"]}` : "";
    if (type !== "session.updated") say(`voice session started${model}`);
    return;
  }
  if (type === "turn.done") {
    const turn = isRecord(event["turn"]) ? event["turn"] : {};
    const transcript = typeof turn["transcript"] === "string" ? turn["transcript"].trim() : "";
    if (!transcript) return;
    say(`${turn["role"] === "user" ? "you" : "agent"} · ${clip(transcript, 90)}`);
    return;
  }
  if (type === "delegation.created") {
    const item = isRecord(event["item"]) ? event["item"] : {};
    const content = Array.isArray(item["content"]) ? item["content"] : [];
    const text = content
      .filter(isRecord)
      .map((part) => (typeof part["text"] === "string" ? part["text"] : ""))
      .join("");
    say(`delegation · ${clip(text, 80)}`);
    return;
  }
  if (type === "error") say(`upstream · ${clip(JSON.stringify(event), 90)}`);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(message(error));
    process.exit(1);
  });
}
