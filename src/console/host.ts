/**
 * The one Console host: a control-attachment peer around the shared TUI.
 * With a media engine it is the Console — role `voice`, owning the duplex
 * audio device, the WebRTC peer, and both mute gates, applying every command
 * locally and publishing instrument state up. Without one it is a Remote
 * console — role `ui`, mirroring the Server's fan-out and sending commands.
 *
 * Mute authority lives with the media engine, never the link: local inputs
 * reach the gates with zero network hops, and a dropped link releases every
 * remote-sourced hold — a stranded hold must never outlive the ability of
 * anyone to release it. A `voice-superseded` frame demotes a running Console
 * in place: media stops, and the same host continues as a mirror.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CONTROL_PROTOCOL_VERSION,
  type ControlCommand,
  type ControlState,
  encodeControlFrame,
  parseServerFrame,
  type VoiceStateBody,
} from "../core/control-protocol.ts";
import { stateDirectory } from "../paths.ts";
import { type AudioTarget, MuteGate, type UnmuteHoldSource } from "./audio-control.ts";
// The media engine is imported lazily: the ui role (including the Android
// Remote console package) must never load werift or the native duplex device.
import type { DuplexVoiceAudio } from "./duplex-audio.ts";
import type { TransportPhase, VoiceTransport } from "./transport.ts";
import {
  createVoiceTui,
  type VoiceTui,
  type VoiceTuiInput,
  type VoiceTuiOptions,
  type VoiceTuiState,
} from "./tui.ts";

const RECONNECT_MS = 750;
/** Comfortably inside the Server's hold-releasing heartbeat deadline. */
const PING_INTERVAL_MS = 1_500;
/** Meter cadence for the voice-state stream; discrete changes publish now. */
const PUBLISH_INTERVAL_MS = 100;
const PREFLIGHT_TIMEOUT_MS = 500;

export class ConsoleError extends Error {}

/** A unix socket path on the Server's own machine, or a network Server. */
export type ConsoleTarget = string | NetworkTarget;

export interface NetworkTarget {
  host: string;
  port: number;
  token: string;
}

/** Present means this host is the Console: role `voice`, audio in-process. */
export interface MediaOptions {
  deviceIndex?: number;
  outputDeviceIndex?: number;
}

export interface ConsoleHostOptions {
  media?: MediaOptions;
  /** Abandon the persisted orchestrator agent once attached. */
  fresh?: boolean;
  debug?: boolean;
  tui?: VoiceTuiOptions;
}

/** One attachment attempt; the caller owns retrying it. */
interface ControlLink {
  send(frame: string): void;
  close(): void;
}

export async function runConsoleHost(
  target: ConsoleTarget,
  options: ConsoleHostOptions = {},
): Promise<void> {
  const media = options.media ?? null;
  if (media) {
    // Fail before taking over the terminal or touching the Server.
    const { duplexAudioAvailabilityError } = await import("./duplex-device.ts");
    const availabilityError = duplexAudioAvailabilityError();
    if (availabilityError) throw new ConsoleError(availabilityError);
    if (typeof target === "string" && !(await socketReachable(target))) {
      throw new ConsoleError(
        `cannot reach the Server at ${target}\n` +
          `Install the daemon pair with: agentvoice server install\n` +
          `Inspect it with: agentvoice server status`,
      );
    }
  }

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
    debugLog(`console start (${media ? "voice" : "ui"} role)`);
  }
  const feed = (line: string): void => debugLog?.(`feed: ${line}`);

  let latest: ControlState | null = null;
  let link: ControlLink | null = null;
  let connected = false;
  let closed = false;
  let fatal: string | null = null;
  let freshQueued = options.fresh === true;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let tui: VoiceTui | null = null;

  const send = (command: ControlCommand): void => {
    if (!connected || !link) return;
    link.send(encodeControlFrame(command));
  };

  // ---- the media engine (Console role only) --------------------------------

  let mediaActive = media !== null;
  const meters = { mic: -Infinity, agent: -Infinity };
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
  /** Remote-sourced holds now open, released wholesale when the link drops. */
  const remoteHolds: Record<AudioTarget, Set<string>> = {
    mic: new Set(),
    speaker: new Set(),
  };
  let phase: TransportPhase = "waiting-ready";
  let publishTimer: ReturnType<typeof setInterval> | null = null;

  let audio: DuplexVoiceAudio | null = null;
  let transport: VoiceTransport | null = null;
  if (media) {
    const [duplexAudio, voiceTransport] = await Promise.all([
      import("./duplex-audio.ts"),
      import("./transport.ts"),
    ]);
    audio = new duplexAudio.DuplexVoiceAudio({
      deviceIndex: media.deviceIndex,
      outputDeviceIndex: media.outputDeviceIndex,
      sendFrame: (frame) => transport?.sendOpusFrame(frame),
      onMicLevel: (db) => {
        meters.mic = db;
      },
      onAgentLevel: (db) => {
        meters.agent = db;
      },
      onWarning: (line) => feed(line),
      debug: debugLog,
    });
    transport = new voiceTransport.VoiceTransport({
      signal: { offer: (sdp) => send({ type: "offer", sdp }) },
      debug: debugLog,
      onPhase: (next) => {
        phase = next;
        tui?.refresh();
        // Phase is discrete: ui peers should not wait out the meter tick.
        publishVoiceState();
      },
      onReady: () => tui?.refresh(),
      onRemoteTrack: (track) => audio?.attachRemote(track),
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
          feed(line);
          return;
        }
        if (type === "error") feed(`upstream: ${JSON.stringify(event).slice(0, 90)}`);
      },
      onInfo: feed,
      onError: feed,
    });
  }

  function voiceBody(): VoiceStateBody {
    return {
      phase,
      liveForMs: transport?.liveForMs ?? null,
      mic: {
        muted: microphone.muted,
        effectiveMuted: microphone.effectiveMuted,
        db: Number.isFinite(meters.mic) ? meters.mic : null,
      },
      speaker: {
        muted: speaker.muted,
        effectiveMuted: speaker.effectiveMuted,
        db: Number.isFinite(meters.agent) ? meters.agent : null,
      },
    };
  }

  function publishVoiceState(): void {
    if (!mediaActive) return;
    send({ type: "voice-state", voice: voiceBody() });
  }

  function muteGate(target: AudioTarget): MuteGate {
    return target === "mic" ? microphone : speaker;
  }

  function setMutedLocal(target: AudioTarget, muted: boolean): void {
    publishMuteChange(target, muteGate(target).setMuted(muted));
  }

  function beginUnmuteLocal(target: AudioTarget, source: UnmuteHoldSource): void {
    publishMuteChange(target, muteGate(target).beginUnmute(source));
  }

  function releaseUnmuteLocal(target: AudioTarget, source: UnmuteHoldSource, commit = false): void {
    publishMuteChange(target, muteGate(target).releaseUnmute(source, commit));
  }

  function publishMuteChange(target: AudioTarget, changed: boolean): void {
    if (!changed || !audio) return;
    const gate = muteGate(target);
    if (target === "mic") audio.micMuted = gate.effectiveMuted;
    else audio.speakerMuted = gate.effectiveMuted;
    const talking = target === "mic" && gate.muted && !gate.effectiveMuted;
    feed(
      `${target === "mic" ? "microphone" : "speaker"} ${talking ? "talking" : gate.effectiveMuted ? "muted" : "live"}`,
    );
    tui?.refresh();
    publishVoiceState();
  }

  function releaseRemoteHolds(): void {
    for (const target of ["mic", "speaker"] as const) {
      for (const source of [...remoteHolds[target]]) {
        releaseUnmuteLocal(target, source, false);
      }
      remoteHolds[target].clear();
    }
  }

  /** Another Console took the voice role; carry on as a mirror. */
  function demote(): void {
    if (!mediaActive) return;
    tui?.cancelInputs();
    mediaActive = false;
    if (publishTimer) clearInterval(publishTimer);
    publishTimer = null;
    releaseRemoteHolds();
    void transport?.stop();
    void audio?.stop();
    feed("superseded: another Console owns the audio; mirroring from here");
    tui?.refresh();
  }

  // ---- the shared TUI ------------------------------------------------------

  function state(): VoiceTuiState {
    if (mediaActive) {
      return {
        available: true,
        phase,
        liveForMs: transport?.liveForMs ?? null,
        mic: {
          muted: microphone.muted,
          effectiveMuted: microphone.effectiveMuted,
          db: meters.mic,
        },
        speaker: {
          muted: speaker.muted,
          effectiveMuted: speaker.effectiveMuted,
          db: meters.agent,
        },
      };
    }
    const voice = connected ? (latest?.voice ?? null) : null;
    return {
      available: voice !== null,
      phase: voice?.phase ?? "waiting-ready",
      liveForMs: voice?.liveForMs ?? null,
      mic: {
        muted: voice?.mic.muted ?? false,
        effectiveMuted: voice?.mic.effectiveMuted ?? false,
        db: voice?.mic.db ?? -Infinity,
      },
      speaker: {
        muted: voice?.speaker.muted ?? false,
        effectiveMuted: voice?.speaker.effectiveMuted ?? false,
        db: voice?.speaker.db ?? -Infinity,
      },
    };
  }

  async function shutdownHost(): Promise<void> {
    if (closed) return;
    closed = true;
    debugLog?.("console shutdown");
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (pingTimer) clearInterval(pingTimer);
    if (publishTimer) clearInterval(publishTimer);
    reconnectTimer = null;
    pingTimer = null;
    publishTimer = null;
    if (audio) audio.micMuted = true;
    link?.close();
    link = null;
    connected = false;
    await audio?.stop().catch(() => {});
    await transport?.stop().catch(() => {});
  }

  tui = await createVoiceTui(
    {
      state,
      setMuted: (target, muted) => {
        if (mediaActive) setMutedLocal(target, muted);
        else send({ type: "set-muted", target, muted });
      },
      beginUnmute: (target, input) => {
        if (mediaActive) beginUnmuteLocal(target, localUnmuteSources[input][target]);
        else send({ type: "hold-unmuted", target, input });
      },
      releaseUnmute: (target, input, commit) => {
        if (mediaActive) releaseUnmuteLocal(target, localUnmuteSources[input][target], commit);
        else send({ type: "release-unmuted", target, input, commit });
      },
      redial: () => {
        if (mediaActive) transport?.redial("manual");
        else send({ type: "redial" });
      },
      fresh: () => send({ type: "fresh" }),
      shutdown: shutdownHost,
    },
    options.tui ?? {},
  );

  // ---- the control link ----------------------------------------------------

  /** Applies one decoded frame; a refusal ends the session rather than retrying. */
  const receive = (line: string): void => {
    const frame = parseServerFrame(line);
    if (!frame) return;
    switch (frame.type) {
      case "state":
        latest = frame;
        return;
      case "reject": {
        if (closed) return;
        fatal = `the Server refused this console: ${frame.reason}`;
        void shutdownHost();
        void tui?.shutdown();
        return;
      }
      default:
        break;
    }
    if (!mediaActive || !transport) return;
    switch (frame.type) {
      case "session-ready":
        transport.handleReady(frame.info);
        return;
      case "session-answer":
        void transport.handleAnswer(frame.sdp);
        return;
      case "session-closed":
        transport.handleClosed(frame.reason);
        return;
      case "session-redial":
        transport.handleRedial(frame.reason);
        return;
      case "session-error":
        transport.handleError(frame.message, frame.fatal);
        return;
      case "voice-superseded":
        demote();
        return;
      case "route-set-muted":
        setMutedLocal(frame.target, frame.muted);
        return;
      case "route-hold":
        remoteHolds[frame.target].add(frame.source);
        beginUnmuteLocal(frame.target, frame.source);
        return;
      case "route-release":
        remoteHolds[frame.target].delete(frame.source);
        releaseUnmuteLocal(frame.target, frame.source, frame.commit);
        return;
      case "route-redial":
        transport.redial("remote");
        return;
      default:
        return;
    }
  };

  const onBatch = (): void => {
    tui?.refresh();
  };

  const onOpen = (): void => {
    connected = true;
    link?.send(
      encodeControlFrame({
        type: "hello",
        protocol: CONTROL_PROTOCOL_VERSION,
        role: mediaActive ? "voice" : "ui",
        ...(typeof target === "string" ? {} : { token: target.token }),
      }),
    );
    if (typeof target !== "string") {
      pingTimer = setInterval(() => send({ type: "ping" }), PING_INTERVAL_MS);
      pingTimer.unref?.();
    }
    if (freshQueued) {
      freshQueued = false;
      send({ type: "fresh" });
    }
    if (mediaActive) {
      publishVoiceState();
      publishTimer = setInterval(publishVoiceState, PUBLISH_INTERVAL_MS);
      publishTimer.unref?.();
    }
    tui?.refresh();
  };

  const onClose = (): void => {
    if (pingTimer) clearInterval(pingTimer);
    if (publishTimer) clearInterval(publishTimer);
    pingTimer = null;
    publishTimer = null;
    link = null;
    connected = false;
    latest = null;
    tui?.cancelInputs();
    if (mediaActive) {
      // Fail safe: with the Server gone, nobody can release a remote hold.
      releaseRemoteHolds();
      transport?.handleSignalLost();
    }
    tui?.refresh();
    if (!closed) reconnectTimer = setTimeout(connect, RECONNECT_MS);
  };

  function connect(): void {
    if (closed) return;
    link =
      typeof target === "string"
        ? connectSocket(target, { onOpen, onFrame: receive, onBatch, onClose })
        : connectWebSocket(target, { onOpen, onFrame: receive, onBatch, onClose });
  }

  if (audio) {
    try {
      await audio.start();
    } catch (error) {
      await tui.shutdown();
      throw new ConsoleError(error instanceof Error ? error.message : String(error));
    }
  }
  connect();
  await tui.done;
  if (fatal) throw new ConsoleError(fatal);
}

// ---------------------------------------------------------------------------

interface LinkHandlers {
  onOpen(): void;
  onFrame(line: string): void;
  /** One redraw per arrival, not per frame in it. */
  onBatch(): void;
  onClose(): void;
}

function connectSocket(socketPath: string, handlers: LinkHandlers): ControlLink {
  const socket: Socket = createConnection(socketPath);
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("connect", handlers.onOpen);
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline === -1) break;
      handlers.onFrame(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
    }
    handlers.onBatch();
  });
  socket.on("error", () => {});
  socket.on("close", handlers.onClose);
  return {
    send: (frame) => {
      if (!socket.destroyed) socket.write(frame);
    },
    close: () => socket.destroy(),
  };
}

/**
 * Cross-machine attachment. The Server binds a tailnet address, so WireGuard
 * — not an app-level TLS session — is what carries the encryption and machine
 * identity here; the token is the Server's own admission check on top.
 */
function connectWebSocket(target: NetworkTarget, handlers: LinkHandlers): ControlLink {
  const socket = new WebSocket(`ws://${formatHost(target.host)}:${target.port}`);
  let settled = false;
  socket.addEventListener("open", handlers.onOpen);
  socket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    handlers.onFrame(event.data);
    handlers.onBatch();
  });
  socket.addEventListener("error", () => {
    if (settled) return;
    settled = true;
    handlers.onClose();
  });
  socket.addEventListener("close", () => {
    if (settled) return;
    settled = true;
    handlers.onClose();
  });
  return {
    send: (frame) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(frame);
    },
    close: () => socket.close(),
  };
}

/** Bare IPv6 literals need brackets in a URL authority. */
function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function socketReachable(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, PREFLIGHT_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
