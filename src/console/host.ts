/** Disposable media host; the production TUI lives in its parent controller. */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../core/config.ts";
import { type HandoffRequest, type HandoffResult, handoffFailure } from "../core/handoff.ts";
import { type RuntimeOptions, VoiceRuntime } from "../core/runtime.ts";
import { tierLabel } from "../core/service-tier.ts";
import { stateDirectory } from "../paths.ts";
import { type AudioTarget, MuteGate } from "./audio-control.ts";
import type { DuplexVoiceAudio, VoiceAudioOptions } from "./duplex-audio.ts";
import type { TransportPhase, VoiceTransport, VoiceTransportOptions } from "./transport.ts";
import type {
  VoiceTui,
  VoiceTuiHost,
  VoiceTuiInput,
  VoiceTuiOptions,
  VoiceTuiState,
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
  | "redialAndWait"
  | "handleReady"
  | "handleAnswer"
  | "handleClosed"
  | "handleSignalLost"
  | "handleError"
  | "liveForMs"
>;
export interface ConsoleHostOptions {
  media?: MediaOptions;
  createTui?: (host: VoiceTuiHost) => Promise<VoiceTui>;
  onStarted?: () => void;
  /** Private controller delivery, separate from interactive UI commands. */
  onHandoffReady?: (submit: (request: HandoffRequest) => Promise<HandoffResult>) => void;
  initialMute?: { mic: boolean; speaker: boolean };
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
        for (const secret of Object.values(options.runtime?.controlMcp?.env ?? {})) {
          if (secret) line = line.replaceAll(secret, "[redacted]");
        }
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
  const microphone = new MuteGate(options.initialMute?.mic);
  const speaker = new MuteGate(options.initialMute?.speaker);
  let phase: TransportPhase = "waiting-ready";
  let transport: HostTransport | null = null;
  let audioReady = false;
  const showNotice = (message: string) => {
    if (closed) return;
    feed(message);
    notice = message;
    tui?.refresh();
  };
  const sources: Record<VoiceTuiInput, Record<AudioTarget, symbol>> = {
    pointer: { mic: Symbol("mic-pointer"), speaker: Symbol("speaker-pointer") },
    space: { mic: Symbol("mic-space"), speaker: Symbol("speaker-space") },
  };
  const audio = factory.audio({
    ...options.media,
    sendFrame: (frame) => {
      if (!closed) transport?.sendOpusFrame(frame);
    },
    onMicLevel: (db) => {
      if (!closed) meters.mic = db;
    },
    onAgentLevel: (db) => {
      if (!closed) meters.agent = db;
    },
    onWarning: (message) => showNotice(`Audio: ${message}`),
    debug: debugLog,
  });
  audio.micMuted = microphone.effectiveMuted;
  audio.speakerMuted = speaker.effectiveMuted;
  transport = factory.transport({
    signal: { offer: (sdp) => runtime?.offer(sdp) },
    debug: debugLog,
    onPhase: (next) => {
      if (closed) return;
      phase = next;
      tui?.refresh();
    },
    onReady: (info) => {
      feed(`workspace ${info.workspace} · conversation ${info.threadId}`);
      tui?.refresh();
    },
    onRemoteTrack: (track) => {
      if (!closed) audio.attachRemote(track);
    },
    onOaiEvent: debugLog
      ? (event) => debugLog(`oai-event: ${JSON.stringify(event).slice(0, 400)}`)
      : undefined,
    onInfo: feed,
    onError: (message) => showNotice(`Voice: ${message}`),
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
      onReady: (info) => {
        if (audioReady && !closed) transport?.handleReady(info);
        tui?.refresh();
      },
      onAnswer: (sdp) => {
        if (!closed) void transport?.handleAnswer(sdp);
      },
      onClosed: (reason) => {
        if (reason === "fresh-thread") {
          transport?.handleSignalLost();
          audio.detachRemote();
        } else transport?.handleClosed(reason);
      },
      onError: (message, isFatal) => {
        showNotice(message);
        transport?.handleError(message, isFatal);
      },
      onFatal: fail,
      onStatus: feed,
      onWarning: showNotice,
      debug: debugLog,
    },
    options.runtime,
  );
  options.onHandoffReady?.(async (request) => {
    if (closed || fatal || !audioReady || phase !== "live" || !runtime)
      return handoffFailure("not_ready");
    return runtime.submitHandoff(request);
  });

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
      workspace: config.orchestrator.workspace,
      conversation: runtime?.currentReady ?? undefined,
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
      audio.detachRemote();
      await Promise.allSettled([audio.stop(), transport?.stop()]);
      await runtime?.shutdown();
    })();
    return shutdownPromise;
  }

  try {
    const createTui =
      options.createTui ??
      ((host: VoiceTuiHost) =>
        import("./tui.ts").then(({ createVoiceTui }) => createVoiceTui(host, options.tui)));
    tui = await createTui({
      state,
      setMuted: (target, muted) => {
        gate(target).setMuted(muted);
        syncMute(target);
      },
      beginUnmute: (target, input) => {
        gate(target).beginUnmute(sources[input][target]);
        syncMute(target);
      },
      releaseUnmute: (target, input) => {
        gate(target).releaseUnmute(sources[input][target]);
        syncMute(target);
      },
      redial: () => transport?.redialAndWait("manual"),
      fresh: () => runtime?.fresh(),
      shutdown,
    });
    // Handlers exist before asynchronous startup, so quitting during initialization works too.
    const boot = (async () => {
      try {
        await runtime!.start();
        if (closed) return;
        // Permission/model/prompt/history failures must not open the microphone.
        // Readiness reaches transport only after audio can receive remote tracks.
        await audio.start();
        if (closed) return;
        audioReady = true;
        const ready = runtime!.currentReady;
        if (ready) transport?.handleReady(ready);
        options.onStarted?.();
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

export async function nativeMediaFactory(): Promise<
  NonNullable<ConsoleHostOptions["mediaFactory"]>
> {
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
