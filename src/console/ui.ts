/** Console host: local audio, runtime, transport, Remote-console IPC, and the shared TUI. */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../core/config.ts";
import type { WatchedConfigSource } from "../core/config-watch.ts";
import { VoiceRuntime } from "../core/runtime.ts";
import { consoleControlSocketPath, stateDirectory } from "../paths.ts";
import { type AudioTarget, MuteGate, type UnmuteHoldSource } from "./audio-control.ts";
import { DuplexVoiceAudio } from "./duplex-audio.ts";
import { duplexAudioAvailabilityError } from "./duplex-device.ts";
import { ClientControlServer, type RemoteControlPeer } from "./remote-control.ts";
import { REMOTE_PROTOCOL_VERSION, type RemoteUnmuteInput } from "./remote-protocol.ts";
import { VOICE_TONES } from "./theme.ts";
import { type TransportPhase, VoiceTransport } from "./transport.ts";
import { createVoiceTui, type VoiceTui, type VoiceTuiInput, type VoiceTuiState } from "./tui.ts";

export interface ConsoleOptions {
  deviceIndex?: number;
  outputDeviceIndex?: number;
  debug: boolean;
  /** Abandon the persisted orchestrator agent and start a fresh thread. */
  fresh: boolean;
}

export class ConsoleError extends Error {}

const PALETTE = VOICE_TONES;

interface Meter {
  db: number;
}

const REMOTE_UNMUTE_INPUTS = [
  "pointer",
  "key",
  "space",
] as const satisfies readonly RemoteUnmuteInput[];

function remoteUnmuteSource(peer: RemoteControlPeer, input: RemoteUnmuteInput): string {
  return `remote:${peer.id}:${input}`;
}

export async function runConsole(
  config: ServerConfig,
  options: ConsoleOptions,
  version: string,
  configSource?: WatchedConfigSource,
): Promise<void> {
  // Fail before taking over the terminal or touching the resident.
  const availabilityError = duplexAudioAvailabilityError();
  if (availabilityError) throw new ConsoleError(availabilityError);

  let debugLog: ((line: string) => void) | undefined;
  if (options.debug) {
    const stateDir = stateDirectory(process.env, homedir());
    mkdirSync(stateDir, { recursive: true });
    const path = join(stateDir, "console-debug.log");
    debugLog = (line: string) => {
      try {
        appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
      } catch {
        // Debug logging must never break the Console.
      }
    };
    debugLog("console start");
  }

  const mic: Meter = { db: -Infinity };
  const agent: Meter = { db: -Infinity };
  const microphone = new MuteGate();
  const speaker = new MuteGate();
  const localUnmuteSources: Record<VoiceTuiInput, Record<AudioTarget, symbol>> = {
    pointer: {
      mic: Symbol("console-mic-pointer"),
      speaker: Symbol("console-speaker-pointer"),
    },
    key: { mic: Symbol("console-mic-key"), speaker: Symbol("console-speaker-key") },
    space: { mic: Symbol("console-mic-space"), speaker: Symbol("console-speaker-space") },
  };
  let phase: TransportPhase = "waiting-ready";
  let transportForRemote: VoiceTransport | null = null;
  let runtimeForRemote: VoiceRuntime | null = null;
  let tui: VoiceTui | null = null;
  let shuttingDown = false;

  // Narrative events stay in the debug log; the TUI is the audio instrument.
  const feed = (text: string, _color: string = PALETTE.dim): void => {
    debugLog?.(`feed: ${text}`);
  };

  const audio = new DuplexVoiceAudio({
    deviceIndex: options.deviceIndex,
    outputDeviceIndex: options.outputDeviceIndex,
    sendFrame: (frame) => transport.sendOpusFrame(frame),
    onMicLevel: (db) => {
      mic.db = db;
    },
    onAgentLevel: (db) => {
      agent.db = db;
    },
    onWarning: (line) => feed(line, PALETTE.warn),
    debug: debugLog,
  });

  // Binding first makes console.sock the single-Console lock before shared state is touched.
  let remoteSequence = 0;
  const remoteControl = new ClientControlServer({
    socketPath: consoleControlSocketPath(process.env, homedir()),
    state: () => ({
      type: "state",
      protocol: REMOTE_PROTOCOL_VERSION,
      sequence: remoteSequence++,
      phase,
      liveForMs: transportForRemote?.liveForMs ?? null,
      mic: {
        muted: microphone.muted,
        effectiveMuted: microphone.effectiveMuted,
        db: Number.isFinite(mic.db) ? mic.db : null,
      },
      speaker: {
        muted: speaker.muted,
        effectiveMuted: speaker.effectiveMuted,
        db: Number.isFinite(agent.db) ? agent.db : null,
      },
    }),
    onCommand: (command, peer) => {
      if (command.type === "set-muted") {
        setMuted(command.target, command.muted);
      } else if (command.type === "hold-unmuted") {
        beginUnmute(command.target, remoteUnmuteSource(peer, command.input));
      } else if (command.type === "release-unmuted") {
        releaseUnmute(command.target, remoteUnmuteSource(peer, command.input), command.commit);
      } else if (command.type === "redial") {
        transportForRemote?.redial("manual");
      } else {
        void runtimeForRemote?.fresh();
      }
    },
    onPeerClose: (peer) => {
      for (const input of REMOTE_UNMUTE_INPUTS) {
        const source = remoteUnmuteSource(peer, input);
        releaseUnmute("mic", source);
        releaseUnmute("speaker", source);
      }
    },
  });
  try {
    await remoteControl.start();
  } catch (error) {
    throw new ConsoleError(
      `could not open the console control socket: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Runtime progress remains plain text until the alternate screen is ready.
  const sink: { transport: VoiceTransport | null } = { transport: null };
  const bufferedStatus: string[] = [];
  console.log("agentvoice: attaching to the resident app-server…");
  let runtime: VoiceRuntime;
  try {
    runtime = await VoiceRuntime.start(
      config,
      version,
      {
        onReady: (info) => sink.transport?.handleReady(info),
        onAnswer: (sdp) => void sink.transport?.handleAnswer(sdp),
        onClosed: (reason) => sink.transport?.handleClosed(reason),
        onRedial: (reason) => sink.transport?.handleRedial(reason),
        onError: (text, fatal) => sink.transport?.handleError(text, fatal),
        onWorker: (worker) => sink.transport?.handleWorker(worker),
        onStatus: (line) => {
          if (sink.transport) {
            feed(line);
          } else {
            console.log(`agentvoice: ${line}`);
            bufferedStatus.push(line);
          }
        },
        debug: debugLog,
      },
      { fresh: options.fresh, ...(configSource ? { configSource } : {}) },
    );
  } catch (error) {
    await remoteControl.close().catch(() => {});
    throw new ConsoleError(error instanceof Error ? error.message : String(error));
  }
  runtimeForRemote = runtime;

  const transport = new VoiceTransport({
    runtime,
    debug: debugLog,
    onPhase: (next) => {
      phase = next;
      tui?.refresh();
    },
    onReady: () => tui?.refresh(),
    onRemoteTrack: (track) => audio.attachRemote(track),
    onOaiEvent: (event) => {
      const type = typeof event["type"] === "string" ? event["type"] : "";
      debugLog?.(`oai-event: ${JSON.stringify(event).slice(0, 400)}`);
      if (type === "session.started" || type === "session.created") {
        const session = event["session"] as Record<string, unknown> | undefined;
        const model = typeof session?.["model"] === "string" ? ` · ${session["model"]}` : "";
        feed(`voice session started${model}`);
        return;
      }
      if (type === "turn.done") {
        const turn = event["turn"] as Record<string, unknown> | undefined;
        const transcript =
          typeof turn?.["transcript"] === "string" ? turn["transcript"].trim() : "";
        if (!transcript) return;
        const isUser = turn?.["role"] === "user";
        const line = `${isUser ? "you" : "agent"} · ${transcript.length > 70 ? `${transcript.slice(0, 69)}…` : transcript}`;
        feed(line, isUser ? PALETTE.you : PALETTE.agent);
        return;
      }
      if (type === "error") feed(`upstream: ${JSON.stringify(event).slice(0, 90)}`, PALETTE.err);
    },
    onWorker: (worker) => {
      const seconds =
        worker.finishedAt === undefined
          ? ""
          : ` (${Math.max(0, Math.round((worker.finishedAt - worker.startedAt) / 1000))}s)`;
      feed(
        `worker ${worker.id} · ${worker.title} — ${worker.status}${seconds}`,
        worker.status === "failed" || worker.status === "lost" ? PALETTE.warn : PALETTE.agent,
      );
    },
    onInfo: (line) => feed(line),
    onError: (line) => feed(line, PALETTE.err),
  });
  transportForRemote = transport;

  function voiceState(): VoiceTuiState {
    return {
      available: true,
      phase,
      liveForMs: transport.liveForMs,
      mic: { muted: microphone.muted, effectiveMuted: microphone.effectiveMuted, db: mic.db },
      speaker: { muted: speaker.muted, effectiveMuted: speaker.effectiveMuted, db: agent.db },
    };
  }

  function muteGate(target: AudioTarget): MuteGate {
    return target === "mic" ? microphone : speaker;
  }

  function setMuted(target: AudioTarget, muted: boolean): void {
    publishMuteChange(target, muteGate(target).setMuted(muted));
  }

  function beginUnmute(target: AudioTarget, source: UnmuteHoldSource): void {
    publishMuteChange(target, muteGate(target).beginUnmute(source));
  }

  function releaseUnmute(target: AudioTarget, source: UnmuteHoldSource, commit = false): void {
    publishMuteChange(target, muteGate(target).releaseUnmute(source, commit));
  }

  function publishMuteChange(target: AudioTarget, changed: boolean): void {
    if (!changed) return;
    const gate = muteGate(target);
    if (target === "mic") audio.micMuted = gate.effectiveMuted;
    else audio.speakerMuted = gate.effectiveMuted;
    const talking = target === "mic" && gate.muted && !gate.effectiveMuted;
    feed(
      `${target === "mic" ? "microphone" : "speaker"} ${talking ? "talking" : gate.effectiveMuted ? "muted" : "live"}`,
      target === "mic" ? PALETTE.you : PALETTE.agent,
    );
    tui?.refresh();
    remoteControl.publish();
  }

  async function shutdownConsole(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    audio.micMuted = true;
    debugLog?.("console shutdown");
    await remoteControl.close().catch(() => {});
    await audio.stop().catch(() => {});
    await transport.stop().catch(() => {});
    await runtime.shutdown().catch(() => {});
  }

  try {
    tui = await createVoiceTui({
      state: voiceState,
      setMuted,
      beginUnmute: (target, input) => beginUnmute(target, localUnmuteSources[input][target]),
      releaseUnmute: (target, input, commit) =>
        releaseUnmute(target, localUnmuteSources[input][target], commit),
      redial: () => transport.redial("manual"),
      fresh: () => {
        void runtime.fresh();
      },
      shutdown: shutdownConsole,
    });
  } catch (error) {
    await shutdownConsole();
    throw new ConsoleError(error instanceof Error ? error.message : String(error));
  }

  sink.transport = transport;
  for (const line of bufferedStatus) feed(line);
  bufferedStatus.length = 0;
  for (const worker of runtime.workerSnapshots()) transport.handleWorker(worker);

  try {
    await audio.start();
  } catch (error) {
    await tui.shutdown();
    throw new ConsoleError(error instanceof Error ? error.message : String(error));
  }
  transport.start();

  await tui.done;
}
