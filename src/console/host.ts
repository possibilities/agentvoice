/** One foreground host: TUI, media, and coordination share this process. */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../core/config.ts";
import { type RuntimeOptions, VoiceRuntime } from "../core/runtime.ts";
import { tierLabel } from "../core/service-tier.ts";
import { stateDirectory } from "../paths.ts";
import { type AudioTarget, MuteGate } from "./audio-control.ts";
import type { DuplexVoiceAudio, VoiceAudioOptions } from "./duplex-audio.ts";
import type { TransportPhase, VoiceTransport, VoiceTransportOptions } from "./transport.ts";
import {
  createVoiceTui,
  type VoiceTui,
  type VoiceTuiInput,
  type VoiceTuiOptions,
  type VoiceTuiState,
} from "./tui.ts";

export class ConsoleError extends Error {}
export interface MediaOptions {
  deviceIndex?: number;
  outputDeviceIndex?: number;
}
export type HostAudio = Pick<
  DuplexVoiceAudio,
  "start" | "stop" | "attachRemote" | "detachRemote" | "micMuted" | "speakerMuted"
>;
export type HostTransport = Pick<
  VoiceTransport,
  | "sendOpusFrame"
  | "stop"
  | "redial"
  | "handleReady"
  | "handleAnswer"
  | "handleClosed"
  | "handleRedial"
  | "handleSignalLost"
  | "handleError"
  | "liveForMs"
>;
export interface ConsoleHostOptions {
  media?: MediaOptions;
  runtime?: RuntimeOptions;
  debug?: boolean;
  tui?: VoiceTuiOptions;
  /** Injectable media boundary for tests that must not capture a microphone. */
  mediaFactory?: {
    check(): void;
    audio(options: VoiceAudioOptions): HostAudio;
    transport(options: VoiceTransportOptions): HostTransport;
  };
}

export async function runConsoleHost(
  config: ServerConfig,
  version: string,
  options: ConsoleHostOptions = {},
): Promise<void> {
  const factory = options.mediaFactory ?? (await nativeMediaFactory());
  factory.check();
  let debugLog: ((line: string) => void) | undefined;
  if (options.debug) {
    const directory = join(stateDirectory(process.env, homedir()), "runs");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${Date.now()}-${process.pid}.log`);
    debugLog = (line) => {
      try {
        appendFileSync(path, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
      } catch {
        /* logging is best effort */
      }
    };
  }
  const feed = (line: string) => debugLog?.(line);
  let tui: VoiceTui | null = null;
  let runtime: VoiceRuntime | null = null;
  let closed = false;
  let fatal: string | null = null;
  let notice: string | undefined;
  let shutdownPromise: Promise<void> | null = null;
  const meters = { mic: -Infinity, agent: -Infinity };
  const microphone = new MuteGate();
  const speaker = new MuteGate();
  let phase: TransportPhase = "waiting-ready";
  let transport: HostTransport | null = null;
  const sources: Record<VoiceTuiInput, Record<AudioTarget, symbol>> = {
    pointer: { mic: Symbol("mic-pointer"), speaker: Symbol("speaker-pointer") },
    key: { mic: Symbol("mic-key"), speaker: Symbol("speaker-key") },
    space: { mic: Symbol("mic-space"), speaker: Symbol("speaker-space") },
  };
  const audio = factory.audio({
    ...options.media,
    sendFrame: (frame) => transport?.sendOpusFrame(frame),
    onMicLevel: (db) => {
      meters.mic = db;
    },
    onAgentLevel: (db) => {
      meters.agent = db;
    },
    onWarning: feed,
    debug: debugLog,
  });
  transport = factory.transport({
    signal: { offer: (sdp) => runtime?.offer(sdp) },
    debug: debugLog,
    onPhase: (next) => {
      phase = next;
      tui?.refresh();
    },
    onReady: (info) => {
      feed(`workspace ${info.workspace} · conversation ${info.threadId}`);
      tui?.refresh();
    },
    onRemoteTrack: (track) => audio.attachRemote(track),
    onOaiEvent: (event) => debugLog?.(`oai-event: ${JSON.stringify(event).slice(0, 400)}`),
    onInfo: feed,
    onError: feed,
  });

  const fail = (message: string) => {
    if (closed) return;
    fatal = message;
    void tui?.shutdown();
  };
  runtime = new VoiceRuntime(
    config,
    version,
    {
      onReady: (info) => transport?.handleReady(info),
      onAnswer: (sdp) => {
        void transport?.handleAnswer(sdp);
      },
      onClosed: (reason) => {
        if (reason === "fresh-thread") {
          transport?.handleSignalLost();
          audio.detachRemote();
        } else transport?.handleClosed(reason);
      },
      onRedial: (reason) => transport?.handleRedial(reason),
      onError: (message, isFatal) => {
        notice = message;
        tui?.refresh();
        transport?.handleError(message, isFatal);
      },
      onFatal: fail,
      onStatus: feed,
      debug: debugLog,
    },
    options.runtime,
  );

  function gate(target: AudioTarget): MuteGate {
    return target === "mic" ? microphone : speaker;
  }
  function syncMute(target: AudioTarget): void {
    if (target === "mic") audio.micMuted = microphone.effectiveMuted;
    else audio.speakerMuted = speaker.effectiveMuted;
    tui?.refresh();
  }
  function state(): VoiceTuiState {
    return {
      available: !closed,
      notice,
      phase,
      liveForMs: transport?.liveForMs ?? null,
      workTier: tierLabel(
        runtime?.currentReady ?? {
          requestedServiceTier:
            options.runtime?.fast === undefined
              ? undefined
              : options.runtime.fast
                ? "priority"
                : "default",
        },
      ),
      mic: { muted: microphone.muted, effectiveMuted: microphone.effectiveMuted, db: meters.mic },
      speaker: { muted: speaker.muted, effectiveMuted: speaker.effectiveMuted, db: meters.agent },
    };
  }
  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    closed = true;
    audio.micMuted = true;
    shutdownPromise = (async () => {
      await Promise.allSettled([audio.stop(), transport?.stop(), runtime?.shutdown()]);
    })();
    return shutdownPromise;
  }

  try {
    tui = await createVoiceTui(
      {
        state,
        setMuted: (target, muted) => {
          gate(target).setMuted(muted);
          syncMute(target);
        },
        beginUnmute: (target, input) => {
          gate(target).beginUnmute(sources[input][target]);
          syncMute(target);
        },
        releaseUnmute: (target, input, commit) => {
          gate(target).releaseUnmute(sources[input][target], commit);
          syncMute(target);
        },
        redial: () => transport?.redial("manual"),
        fresh: () => {
          void runtime?.fresh();
        },
        shutdown,
      },
      options.tui,
    );
    // Handlers exist before asynchronous startup, so quitting during initialization works too.
    const boot = (async () => {
      try {
        await audio.start();
        if (!closed) await runtime!.start();
      } catch (error) {
        if (!closed) fail(error instanceof Error ? error.message : String(error));
      } finally {
        // A device may finish opening after the initial quit cleanup.
        if (closed) {
          await audio.stop();
          await shutdown();
        }
      }
    })();
    await tui.done;
    await boot;
  } finally {
    await shutdown();
    await tui?.shutdown();
  }
  if (fatal) throw new ConsoleError(fatal);
}

async function nativeMediaFactory(): Promise<NonNullable<ConsoleHostOptions["mediaFactory"]>> {
  const [device, audio, transport] = await Promise.all([
    import("./duplex-device.ts"),
    import("./duplex-audio.ts"),
    import("./transport.ts"),
  ]);
  return {
    check() {
      const error = device.duplexAudioAvailabilityError();
      if (error) throw new ConsoleError(error);
    },
    audio: (options) => new audio.DuplexVoiceAudio(options),
    transport: (options) => new transport.VoiceTransport(options),
  };
}
