import type { VoiceAudioOptions } from "../../src/console/duplex-audio.ts";
import type {
  ConsoleHostOptions,
  HostAudio,
  HostTransport,
  VoiceTransportOptions,
} from "../../src/console/host.ts";
import type { ConfigValues } from "../../src/core/config.ts";
import type { RuntimeOptions } from "../../src/core/runtime.ts";
import { runtimeHarness } from "./runtime-harness.ts";

/** In-process fake media. It never imports the audio device or opens WebRTC. */
export function hostHarness(values: ConfigValues = {}, runtimeOptions: RuntimeOptions = {}) {
  const h = runtimeHarness(values, runtimeOptions);
  const calls: string[] = [];
  let audioOptions!: VoiceAudioOptions;
  let transportOptions!: VoiceTransportOptions;
  const audio: HostAudio = {
    micMuted: false,
    speakerMuted: false,
    async start() {
      calls.push("audio:start");
    },
    async stop() {
      calls.push("audio:stop");
    },
    attachRemote() {
      calls.push("audio:attach");
    },
    detachRemote() {
      calls.push("audio:detach");
    },
  };
  const transport: HostTransport = {
    async redialAndWait() {
      calls.push("redial");
    },
    sendOpusFrame() {},
    async stop() {
      calls.push("transport:stop");
    },
    handleReady(info) {
      calls.push("ready");
      transportOptions.onReady?.(info);
      transportOptions.onPhase?.("live");
    },
    async handleAnswer() {},
    handleClosed() {},
    handleError() {},
    handleSignalLost() {
      calls.push("signal:lost");
    },
  };
  const mediaFactory: NonNullable<ConsoleHostOptions["mediaFactory"]> = {
    check() {},
    audio(options) {
      audioOptions = options;
      return audio;
    },
    transport(options) {
      transportOptions = options;
      return transport;
    },
  };
  return {
    ...h,
    audio,
    transport,
    calls,
    mediaFactory,
    warnAudio: (message: string) => audioOptions.onWarning(message),
    failTransport: (message: string) => {
      transportOptions.onError(message);
      transportOptions.onPhase("failed");
    },
  };
}
