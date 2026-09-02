/**
 * Frontend audio over one native miniaudio duplex device. Opus and WebRTC stay
 * in TypeScript; the real-time callback and bounded PCM rings stay native.
 *
 * There is no acoustic echo cancellation here. The archive shipped without it
 * and worked because of the mute doctrine: the microphone opens muted and is
 * held open deliberately. A muted microphone still sends silence frames — the
 * remote service suspends downlink RTP when the uplink cadence stops.
 */

import OpusScript from "opusscript";
import type { MediaStreamTrack } from "werift";
import { FRAME_SAMPLES, rmsDbS16 } from "./dsp.ts";
import {
  DUPLEX_PLAYBACK_CHANNELS,
  DUPLEX_SAMPLE_RATE,
  type DuplexDeviceInfo,
  NativeDuplexDevice,
} from "./duplex-device.ts";

export interface DuplexVoiceAudioOptions {
  deviceIndex?: number;
  outputDeviceIndex?: number;
  sendFrame(frame: Buffer): void;
  onMicLevel(db: number): void;
  onAgentLevel(db: number): void;
  onWarning(line: string): void;
  debug?(line: string): void;
}

const SILENCE_WARN_CHUNKS = 50;
const CAPTURE_POLL_MS = 5;
const MAX_CAPTURE_CHUNKS_PER_POLL = 32;
const MUTED_CAPTURE_FRAME = Buffer.alloc(FRAME_SAMPLES * 2);

interface FrameEncoder {
  encode(frame: Buffer, frameSize: number): Buffer;
}

/** Muting must preserve uplink cadence, so a muted frame is silence, not absence. */
export function sendCapturedFrame(
  encoder: FrameEncoder,
  capturedFrame: Buffer,
  micMuted: boolean,
  sendFrame: (frame: Buffer) => void,
): void {
  const input = micMuted ? MUTED_CAPTURE_FRAME : capturedFrame;
  sendFrame(Buffer.from(encoder.encode(input, FRAME_SAMPLES)));
}

export class DuplexVoiceAudio {
  micMuted = false;

  private device: NativeDuplexDevice | null = null;
  private encoder: OpusScript | null = null;
  private decoder: OpusScript | null = null;
  private captureTimer: ReturnType<typeof setInterval> | null = null;
  private readonly captureFrame = Buffer.allocUnsafe(FRAME_SAMPLES * 2);
  private remoteSubscription: { unSubscribe(): void } | null = null;
  private remoteGeneration = 0;
  private silentChunks = 0;
  private warnedSilence = false;
  private warnedDecode = false;
  private warnedPlaybackDrop = false;
  private stopped = false;
  private speakerMutedValue = false;

  constructor(private readonly options: DuplexVoiceAudioOptions) {}

  get speakerMuted(): boolean {
    return this.speakerMutedValue;
  }

  set speakerMuted(muted: boolean) {
    if (muted === this.speakerMutedValue) return;
    this.speakerMutedValue = muted;
    if (muted) this.device?.clearPlayback();
  }

  captureDevices(): DuplexDeviceInfo[] {
    return this.device?.captureDevices() ?? [];
  }

  async start(): Promise<void> {
    this.stopped = false;
    const device = new NativeDuplexDevice();
    try {
      const captureDevices = device.captureDevices();
      const playbackDevices = device.playbackDevices();
      validateDeviceIndex("capture", this.options.deviceIndex, captureDevices);
      validateDeviceIndex("playback", this.options.outputDeviceIndex, playbackDevices);
      this.encoder = new OpusScript(DUPLEX_SAMPLE_RATE, 1, OpusScript.Application.VOIP);
      this.decoder = new OpusScript(
        DUPLEX_SAMPLE_RATE,
        DUPLEX_PLAYBACK_CHANNELS,
        OpusScript.Application.VOIP,
      );
      device.start(this.options.deviceIndex, this.options.outputDeviceIndex);
      this.device = device;
      const negotiated = device.negotiatedFormat();
      this.options.debug?.(
        `duplex opened miniaudio=${device.miniaudioVersion} backend=${negotiated.backend} ` +
          `capture=${JSON.stringify({ device: negotiated.captureDevice, ...negotiated.capture })} ` +
          `playback=${JSON.stringify({ device: negotiated.playbackDevice, ...negotiated.playback })}`,
      );
      this.captureTimer = setInterval(() => this.pumpCapture(device), CAPTURE_POLL_MS);
      this.captureTimer.unref?.();
    } catch (error) {
      device.close();
      this.encoder?.delete();
      this.decoder?.delete();
      this.encoder = null;
      this.decoder = null;
      throw error;
    }
  }

  attachRemote(track: MediaStreamTrack): void {
    const replacingTrack = this.remoteSubscription !== null;
    this.detachRemote();
    if (replacingTrack) this.device?.clearPlayback();
    const generation = ++this.remoteGeneration;
    this.warnedDecode = false;
    this.warnedPlaybackDrop = false;
    this.remoteSubscription = track.onReceiveRtp.subscribe((packet) => {
      if (this.stopped || generation !== this.remoteGeneration) return;
      this.handleDownlink(packet.payload);
    });
    this.options.debug?.("remote audio track attached");
  }

  detachRemote(): void {
    this.remoteGeneration++;
    this.remoteSubscription?.unSubscribe();
    this.remoteSubscription = null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.detachRemote();
    if (this.captureTimer) clearInterval(this.captureTimer);
    this.captureTimer = null;
    const device = this.device;
    this.device = null;
    if (device) {
      try {
        device.stop();
      } finally {
        device.close();
      }
    }
    this.encoder?.delete();
    this.decoder?.delete();
    this.encoder = null;
    this.decoder = null;
  }

  private pumpCapture(device: NativeDuplexDevice): void {
    if (this.stopped || this.device !== device) return;
    for (let chunk = 0; chunk < MAX_CAPTURE_CHUNKS_PER_POLL; chunk += 1) {
      const framesRead = device.readCapture(this.captureFrame);
      if (framesRead === 0) break;
      if (framesRead !== FRAME_SAMPLES) {
        this.options.debug?.(`duplex capture returned partial frame frames=${framesRead}`);
        break;
      }
      this.handleMicFrame(this.captureFrame);
    }
  }

  private handleMicFrame(frame: Buffer): void {
    this.options.onMicLevel(rmsDbS16(frame));
    if (isAllZero(frame)) {
      this.silentChunks++;
      if (this.silentChunks >= SILENCE_WARN_CHUNKS && !this.warnedSilence) {
        this.warnedSilence = true;
        this.options.onWarning(
          "microphone is delivering pure silence — check System Settings › Privacy & Security › Microphone for your terminal, then restart it",
        );
      }
    } else {
      this.silentChunks = 0;
      this.warnedSilence = false;
    }
    if (!this.encoder) return;
    try {
      sendCapturedFrame(this.encoder, frame, this.micMuted, this.options.sendFrame);
    } catch (error) {
      this.options.debug?.(`opus encode failed: ${message(error)}`);
    }
  }

  private handleDownlink(payload: Buffer): void {
    if (!this.decoder || payload.length === 0) return;
    let pcm: Buffer;
    try {
      pcm = Buffer.from(this.decoder.decode(payload));
    } catch (error) {
      if (!this.warnedDecode) {
        this.warnedDecode = true;
        this.options.onWarning(`agent audio decode failed: ${message(error)}`);
      }
      return;
    }
    this.options.onAgentLevel(rmsDbS16(pcm));
    const device = this.device;
    if (this.speakerMutedValue || !device) return;
    const playbackFrames = pcm.length / (DUPLEX_PLAYBACK_CHANNELS * 2);
    const written = device.writePlayback(pcm);
    if (written !== playbackFrames && !this.warnedPlaybackDrop) {
      this.warnedPlaybackDrop = true;
      this.options.onWarning(
        `speaker ring overflow dropped ${playbackFrames - written} PCM frames`,
      );
    }
  }
}

function validateDeviceIndex(
  direction: string,
  index: number | undefined,
  devices: readonly DuplexDeviceInfo[],
): void {
  if (index === undefined || devices.some((device) => device.index === index)) return;
  const names =
    devices.map((device) => `${device.index}: ${device.name}`).join(", ") || "none found";
  throw new Error(`no ${direction} device with index ${index} (${names})`);
}

function isAllZero(buffer: Buffer): boolean {
  for (let offset = 0; offset < buffer.length; offset += 2) {
    if (buffer.readInt16LE(offset) !== 0) return false;
  }
  return true;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
