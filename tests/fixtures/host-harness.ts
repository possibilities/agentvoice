import type { VoiceAudioOptions } from "../../src/console/duplex-audio.ts";
import type { ConsoleHostOptions, HostAudio, HostTransport } from "../../src/console/host.ts";
import type { VoiceTransportOptions } from "../../src/console/transport.ts";
import { runtimeHarness } from "./runtime-harness.ts";

/** In-process fake media. It never imports the audio device or opens WebRTC. */
export function hostHarness() {
  const h = runtimeHarness();
  const calls: string[] = [];
  let audioOptions!: VoiceAudioOptions;
  let transportOptions!: VoiceTransportOptions;
  const audio: HostAudio = {
    micMuted: false,
    speakerMuted: false,
    async start() {
      calls.push("audio:start");
      audioOptions.onMicLevel(-42.4);
      audioOptions.onAgentLevel(-18.7);
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
    liveForMs: 4_250,
    sendOpusFrame() {},
    async stop() {
      calls.push("transport:stop");
    },
    redial() {
      calls.push("redial");
    },
    handleReady(info) {
      calls.push("ready");
      transportOptions.onReady?.(info);
      transportOptions.onPhase?.("live");
    },
    async handleAnswer() {},
    handleClosed() {},
    handleRedial() {},
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
  return { ...h, audio, transport, calls, mediaFactory };
}
