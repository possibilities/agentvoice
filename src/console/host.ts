/** Disposable media host observed by its server controller over private IPC. */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MediaStreamTrack } from "werift";
import type { ServerConfig } from "../core/config.ts";
import { type HandoffRequest, type HandoffResult, handoffFailure } from "../core/handoff.ts";
import { type RuntimeOptions, VoiceRuntime } from "../core/runtime.ts";
import type {
  ConversationReadMethod,
  ConversationReadParams,
  ConversationReadResult,
} from "../events/conversation.ts";
import { stateDirectory } from "../paths.ts";
import { type AudioTarget, MuteGate } from "./audio-control.ts";
import type {
  ClientMediaSession,
  ClientSessionOptions,
  ClientSessionPhase,
} from "./client-session.ts";
import type { DuplexVoiceAudio, VoiceAudioOptions } from "./duplex-audio.ts";
import type { VoiceHost, VoiceInput, VoiceState, VoiceView } from "./state.ts";

export type VoiceTransportOptions = Omit<ClientSessionOptions, "send"> & {
  onRemoteTrack(track: MediaStreamTrack): void;
  onOaiEvent?(event: Record<string, unknown>): void;
};

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
  ClientMediaSession,
  | "redialAndWait"
  | "sendOpusFrame"
  | "stop"
  | "handleReady"
  | "handleAnswer"
  | "handleClosed"
  | "handleSignalLost"
  | "handleError"
>;
export interface ConsoleHostOptions {
  media?: MediaOptions;
  observe: (host: VoiceHost & { redial(): Promise<void> }) => Promise<VoiceView>;
  onStarted?: () => void;
  onHandoffReady?: (submit: (request: HandoffRequest) => Promise<HandoffResult>) => void;
  onObservationReady?: (
    read: (
      method: ConversationReadMethod,
      params: ConversationReadParams,
    ) => Promise<ConversationReadResult>,
  ) => void;
  initialMute?: { mic: boolean; speaker: boolean };
  runtime?: RuntimeOptions;
  debug?: boolean;
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
  options: ConsoleHostOptions,
): Promise<void> {
  const factory = options.mediaFactory;
  if (!factory) throw new ConsoleError("Server requires client-owned media signaling");
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
  let observer: VoiceView | null = null;
  let runtime: VoiceRuntime | null = null;
  let closed = false;
  let fatal: string | null = null;
  let notice: string | undefined;
  let shutdownPromise: Promise<void> | null = null;
  const microphone = new MuteGate(options.initialMute?.mic);
  const speaker = new MuteGate(options.initialMute?.speaker);
  let phase: ClientSessionPhase = "waiting-ready";
  let transport: HostTransport | null = null;
  let audioReady = false;
  const showNotice = (message: string) => {
    if (closed) return;
    feed(message);
    notice = message;
    observer?.refresh();
  };
  const sources: Record<VoiceInput, Record<AudioTarget, symbol>> = {
    pointer: { mic: Symbol("mic-pointer"), speaker: Symbol("speaker-pointer") },
  };
  const audio = factory.audio({
    ...options.media,
    sendFrame: (frame) => {
      if (!closed) transport?.sendOpusFrame(frame);
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
      observer?.refresh();
    },
    onReady: (info) => {
      feed(`workspace ${info.workspace} · conversation ${info.threadId}`);
      observer?.refresh();
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
    void observer?.shutdown();
  };
  runtime = new VoiceRuntime(
    config,
    version,
    {
      onReady: (info) => {
        if (audioReady && !closed) transport?.handleReady(info);
        observer?.refresh();
      },
      onAnswer: (sdp) => {
        if (!closed) void transport?.handleAnswer(sdp);
      },
      onClosed: (reason) => {
        transport?.handleClosed(reason);
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
  options.onObservationReady?.((method, params) => runtime!.readConversation(method, params));

  function gate(target: AudioTarget): MuteGate {
    return target === "mic" ? microphone : speaker;
  }
  function syncMute(target: AudioTarget): void {
    if (target === "mic") audio.micMuted = microphone.effectiveMuted;
    else audio.speakerMuted = speaker.effectiveMuted;
    observer?.refresh();
  }
  function state(): VoiceState {
    return {
      available: !closed,
      notice,
      workspace: config.orchestrator.workspace,
      conversation: runtime?.currentReady ?? undefined,
      phase,
      mic: { muted: microphone.muted, effectiveMuted: microphone.effectiveMuted },
      speaker: { muted: speaker.muted, effectiveMuted: speaker.effectiveMuted },
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
    observer = await options.observe({
      redial: () => transport.redialAndWait("control"),
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
    await observer.done;
    await boot;
  } finally {
    await shutdown();
    await observer?.shutdown();
  }
  if (fatal) throw new ConsoleError(fatal);
}
