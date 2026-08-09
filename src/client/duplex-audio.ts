/**
 * Client audio over one native miniaudio duplex device. Opus and WebRTC stay
 * in TypeScript; the real-time callback and bounded PCM rings stay native.
 */

import OpusScript from "opusscript";
import type { MediaStreamTrack } from "werift";
import { FRAME_SAMPLES, rmsDbS16 } from "./dsp.ts";
import {
  DUPLEX_PLAYBACK_CHANNELS,
  DUPLEX_PLAYBACK_START_FRAMES,
  DUPLEX_SAMPLE_RATE,
  type DuplexDeviceInfo,
  type DuplexStats,
  NativeDuplexDevice,
} from "./duplex-device.ts";

export interface VoiceAudioOptions {
  deviceIndex?: number;
  outputDeviceIndex?: number;
  sendFrame(frame: Buffer): void;
  onMicLevel(db: number): void;
  onAgentLevel(db: number): void;
  onWarning(line: string): void;
  debug?(line: string): void;
}

export interface CaptureDeviceInfo {
  index: number;
  name: string;
  isDefault: boolean;
}

const SILENCE_WARN_CHUNKS = 50;
const CAPTURE_POLL_MS = 5;
const MAX_CAPTURE_CHUNKS_PER_POLL = 32;
const DEBUG_LOG_INTERVAL_MS = 1_000;
const PCM_BYTES_PER_SECOND = DUPLEX_SAMPLE_RATE * DUPLEX_PLAYBACK_CHANNELS * 2;

interface DownlinkWindow {
  startedAt: number;
  lastPacketAt: number;
  firstTimestamp: number;
  lastTimestamp: number;
  packets: number;
  sequenceBreaks: number;
  opusBytes: number;
  pcmBytes: number;
  playbackFrames: number;
  arrivalGapsMs: number[];
  handlerTimesMs: number[];
  ringBeforeMinFrames: number | null;
  ringBeforeMaxFrames: number | null;
  ringAfterMinFrames: number | null;
  ringAfterMaxFrames: number | null;
}

interface PacketTiming {
  arrivedAt: number;
  arrivalGapMs: number | null;
  rtpStepMs: number | null;
  sequenceBreak: boolean;
}

export class DuplexVoiceAudio {
  private readonly options: VoiceAudioOptions;
  private device: NativeDuplexDevice | null = null;
  private encoder: OpusScript | null = null;
  private decoder: OpusScript | null = null;
  private captureTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private captureFrame = Buffer.allocUnsafe(FRAME_SAMPLES * 2);
  private previousStats: DuplexStats | null = null;
  private downlinkWindow: DownlinkWindow | null = null;
  private lastPacketArrivalAt: number | null = null;
  private lastPacketSequenceNumber: number | null = null;
  private lastPacketTimestamp: number | null = null;
  private observedPlaybackStarvations = 0n;
  private remoteSubscription: { unSubscribe(): void } | null = null;
  private remoteGeneration = 0;
  private silentChunks = 0;
  private warnedSilence = false;
  private warnedDecode = false;
  private warnedPlaybackDrop = false;
  private seenRemoteAudio = false;
  private stopped = false;
  private speakerMutedValue = false;

  micMuted = false;

  constructor(options: VoiceAudioOptions) {
    this.options = options;
  }

  get speakerMuted(): boolean {
    return this.speakerMutedValue;
  }

  set speakerMuted(muted: boolean) {
    if (muted === this.speakerMutedValue) return;
    this.speakerMutedValue = muted;
    if (muted) this.device?.clearPlayback();
  }

  captureDevices(): CaptureDeviceInfo[] {
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
      this.options.debug?.(
        `duplex devices capture=${JSON.stringify(captureDevices)} playback=${JSON.stringify(playbackDevices)}`,
      );

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
        `duplex opened miniaudio=${device.miniaudioVersion} client_rate=${DUPLEX_SAMPLE_RATE} playback_start_frames=${DUPLEX_PLAYBACK_START_FRAMES} ` +
          `backend=${negotiated.backend} capture=${JSON.stringify({ device: negotiated.captureDevice, ...negotiated.capture })} ` +
          `playback=${JSON.stringify({ device: negotiated.playbackDevice, ...negotiated.playback })}`,
      );
      this.previousStats = device.stats();
      this.captureTimer = setInterval(() => this.pumpCapture(device), CAPTURE_POLL_MS);
      this.captureTimer.unref?.();
      if (this.options.debug) {
        this.statsTimer = setInterval(() => this.logStats("interval"), DEBUG_LOG_INTERVAL_MS);
        this.statsTimer.unref?.();
      }
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
    this.seenRemoteAudio = false;
    this.resetPacketTiming();
    this.observedPlaybackStarvations = this.device?.playbackStarvationCount() ?? 0n;
    const subscription = track.onReceiveRtp.subscribe((packet) => {
      if (this.stopped || generation !== this.remoteGeneration) return;
      this.handleDownlink(packet.payload, packet.header.sequenceNumber, packet.header.timestamp);
    });
    this.remoteSubscription = subscription;
    this.options.debug?.("remote audio track attached");
  }

  detachRemote(): void {
    this.logDownlinkWindow("track detached");
    this.remoteGeneration++;
    this.remoteSubscription?.unSubscribe();
    this.remoteSubscription = null;
    this.resetPacketTiming();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.detachRemote();
    if (this.captureTimer) clearInterval(this.captureTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.captureTimer = null;
    this.statsTimer = null;
    this.logStats("stop");
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
        this.options.debug?.(
          `duplex capture returned partial frame frames=${framesRead} expected=${FRAME_SAMPLES}`,
        );
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

    if (this.micMuted || !this.encoder) return;
    try {
      const encoded = this.encoder.encode(frame, FRAME_SAMPLES);
      this.options.sendFrame(Buffer.from(encoded));
    } catch (error) {
      this.options.debug?.(`opus encode failed: ${message(error)}`);
    }
  }

  private handleDownlink(payload: Buffer, sequenceNumber: number, timestamp: number): void {
    if (!this.decoder || payload.length === 0) return;
    const timing = this.observePacketTiming(sequenceNumber, timestamp);
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

    const agentDb = rmsDbS16(pcm);
    this.options.onAgentLevel(agentDb);
    const playbackFrames = pcm.length / (DUPLEX_PLAYBACK_CHANNELS * 2);
    let written = 0;
    let bufferedBefore: number | null = null;
    let bufferedAfter: number | null = null;
    const device = this.device;
    if (!this.speakerMutedValue && device) {
      bufferedBefore = device.playbackBufferedFrames();
      written = device.writePlayback(pcm);
      bufferedAfter = device.playbackBufferedFrames();
      if (written !== playbackFrames && !this.warnedPlaybackDrop) {
        this.warnedPlaybackDrop = true;
        const debugHint = this.options.debug ? "; see --debug log" : "";
        this.options.onWarning(
          `speaker ring overflow dropped ${playbackFrames - written} PCM frames${debugHint}`,
        );
      }
    }
    const handlerMs = performance.now() - timing.arrivedAt;
    if (device) {
      this.tracePlaybackStarvations(
        device,
        timing,
        sequenceNumber,
        timestamp,
        payload.length,
        agentDb,
        bufferedBefore,
        bufferedAfter,
      );
    }
    this.recordDownlink(
      sequenceNumber,
      timestamp,
      payload.length,
      pcm.length,
      written,
      timing,
      handlerMs,
      bufferedBefore,
      bufferedAfter,
    );
  }

  private observePacketTiming(sequenceNumber: number, timestamp: number): PacketTiming {
    const arrivedAt = performance.now();
    const previousArrival = this.lastPacketArrivalAt;
    const previousSequence = this.lastPacketSequenceNumber;
    const previousTimestamp = this.lastPacketTimestamp;
    this.lastPacketArrivalAt = arrivedAt;
    this.lastPacketSequenceNumber = sequenceNumber;
    this.lastPacketTimestamp = timestamp;
    return {
      arrivedAt,
      arrivalGapMs: previousArrival === null ? null : arrivedAt - previousArrival,
      rtpStepMs:
        previousTimestamp === null
          ? null
          : (((timestamp - previousTimestamp) >>> 0) / DUPLEX_SAMPLE_RATE) * 1_000,
      sequenceBreak:
        previousSequence !== null && ((previousSequence + 1) & 0xffff) !== sequenceNumber,
    };
  }

  private resetPacketTiming(): void {
    this.lastPacketArrivalAt = null;
    this.lastPacketSequenceNumber = null;
    this.lastPacketTimestamp = null;
  }

  private tracePlaybackStarvations(
    device: NativeDuplexDevice,
    timing: PacketTiming,
    sequenceNumber: number,
    timestamp: number,
    opusBytes: number,
    pcmDb: number,
    bufferedBefore: number | null,
    bufferedAfter: number | null,
  ): void {
    if (!this.options.debug) return;
    const current = device.playbackStarvationCount();
    if (current <= this.observedPlaybackStarvations) return;

    const capacity = BigInt(device.playbackStarvationEventCapacity);
    let first = this.observedPlaybackStarvations + 1n;
    const unseen = current - this.observedPlaybackStarvations;
    if (unseen > capacity) {
      const lost = unseen - capacity;
      this.options.debug(`playback starvation trace lost_events=${lost}`);
      first = current - capacity + 1n;
    }
    const callbacksNow = device.callbackCount();
    for (let sequence = first; sequence <= current; sequence += 1n) {
      const event = device.playbackStarvationEvent(sequence);
      if (!event) {
        this.options.debug(`playback starvation event=${sequence} unavailable`);
        continue;
      }
      const callbacksAgo =
        callbacksNow >= event.callbackCount ? callbacksNow - event.callbackCount : 0n;
      const ageMs = Number(callbacksAgo) * (event.requestedFrames / DUPLEX_SAMPLE_RATE) * 1_000;
      this.options.debug(
        `playback starvation event=${event.sequence} callback=${event.callbackCount} callbacks_ago=${callbacksAgo} age_ms_est=${ageMs.toFixed(1)} ` +
          `available_frames=${event.availableFrames} requested_frames=${event.requestedFrames} read_frames=${event.readFrames} ` +
          `packet_sequence=${sequenceNumber} rtp_timestamp=${timestamp} opus_bytes=${opusBytes} pcm_db=${formatDb(pcmDb)} ` +
          `arrival_gap_ms=${formatOptionalMs(timing.arrivalGapMs)} ` +
          `rtp_step_ms=${formatOptionalMs(timing.rtpStepMs)} ring_before=${formatOptionalFrames(bufferedBefore)} ring_after=${formatOptionalFrames(bufferedAfter)}`,
      );
    }
    this.observedPlaybackStarvations = current;
  }

  private recordDownlink(
    sequenceNumber: number,
    timestamp: number,
    opusBytes: number,
    pcmBytes: number,
    playbackFrames: number,
    timing: PacketTiming,
    handlerMs: number,
    bufferedBefore: number | null,
    bufferedAfter: number | null,
  ): void {
    if (!this.options.debug) return;
    const now = timing.arrivedAt;
    let window = this.downlinkWindow;
    if (!window) {
      window = {
        startedAt: now,
        lastPacketAt: now,
        firstTimestamp: timestamp,
        lastTimestamp: timestamp,
        packets: 0,
        sequenceBreaks: 0,
        opusBytes: 0,
        pcmBytes: 0,
        playbackFrames: 0,
        arrivalGapsMs: [],
        handlerTimesMs: [],
        ringBeforeMinFrames: null,
        ringBeforeMaxFrames: null,
        ringAfterMinFrames: null,
        ringAfterMaxFrames: null,
      };
      this.downlinkWindow = window;
    }
    if (timing.sequenceBreak) window.sequenceBreaks++;
    window.lastPacketAt = now;
    window.lastTimestamp = timestamp;
    window.packets++;
    window.opusBytes += opusBytes;
    window.pcmBytes += pcmBytes;
    window.playbackFrames += playbackFrames;
    if (timing.arrivalGapMs !== null) window.arrivalGapsMs.push(timing.arrivalGapMs);
    window.handlerTimesMs.push(handlerMs);
    if (bufferedBefore !== null) {
      window.ringBeforeMinFrames = minimum(window.ringBeforeMinFrames, bufferedBefore);
      window.ringBeforeMaxFrames = maximum(window.ringBeforeMaxFrames, bufferedBefore);
    }
    if (bufferedAfter !== null) {
      window.ringAfterMinFrames = minimum(window.ringAfterMinFrames, bufferedAfter);
      window.ringAfterMaxFrames = maximum(window.ringAfterMaxFrames, bufferedAfter);
    }
    if (!this.seenRemoteAudio) {
      this.seenRemoteAudio = true;
      this.options.debug(
        `agent audio first packet sequence=${sequenceNumber} rtp_timestamp=${timestamp} opus_bytes=${opusBytes} pcm_bytes=${pcmBytes} pcm_ms=${((pcmBytes / PCM_BYTES_PER_SECOND) * 1_000).toFixed(1)}`,
      );
    }
    if (window.lastPacketAt - window.startedAt >= DEBUG_LOG_INTERVAL_MS) {
      this.logDownlinkWindow("interval");
    }
  }

  private logDownlinkWindow(reason: string): void {
    const window = this.downlinkWindow;
    this.downlinkWindow = null;
    if (!window || !this.options.debug) return;
    const rtpMs =
      (((window.lastTimestamp - window.firstTimestamp) >>> 0) / DUPLEX_SAMPLE_RATE) * 1_000;
    const pcmMs = (window.pcmBytes / PCM_BYTES_PER_SECOND) * 1_000;
    const gapP95 = percentile(window.arrivalGapsMs, 0.95);
    const gapMax = maximumValue(window.arrivalGapsMs);
    const handlerP95 = percentile(window.handlerTimesMs, 0.95);
    const handlerMax = maximumValue(window.handlerTimesMs);
    this.options.debug(
      `agent audio ${reason} wall_ms=${(window.lastPacketAt - window.startedAt).toFixed(1)} rtp_ms=${rtpMs.toFixed(1)} pcm_ms=${pcmMs.toFixed(1)} ` +
        `packets=${window.packets} sequence_breaks=${window.sequenceBreaks} opus_bytes=${window.opusBytes} playback_frames=${window.playbackFrames} ` +
        `arrival_gap_p95_ms=${formatOptionalMs(gapP95)} arrival_gap_max_ms=${formatOptionalMs(gapMax)} ` +
        `arrival_gap_gt_30=${countGreaterThan(window.arrivalGapsMs, 30)} arrival_gap_gt_40=${countGreaterThan(window.arrivalGapsMs, 40)} ` +
        `arrival_gap_gt_60=${countGreaterThan(window.arrivalGapsMs, 60)} handler_p95_ms=${formatOptionalMs(handlerP95)} handler_max_ms=${formatOptionalMs(handlerMax)} ` +
        `ring_before=${formatFrameRange(window.ringBeforeMinFrames, window.ringBeforeMaxFrames)} ` +
        `ring_after=${formatFrameRange(window.ringAfterMinFrames, window.ringAfterMaxFrames)} muted=${this.speakerMutedValue}`,
    );
  }

  private logStats(reason: string): void {
    const device = this.device;
    if (!device || !this.options.debug) return;
    const stats = device.stats();
    const previous = this.previousStats;
    this.previousStats = stats;
    this.options.debug(
      `duplex stats ${reason} state=${deviceStateName(stats.state)} started=${stats.started} ` +
        `callbacks=${stats.callbacks} callbacks_delta=${delta(stats.callbacks, previous?.callbacks)} max_callback_frames=${stats.maxCallbackFrames} ` +
        `capture_buffered=${stats.captureBufferedFrames} capture_received_delta=${delta(stats.captureReceivedFrames, previous?.captureReceivedFrames)} ` +
        `capture_read_delta=${delta(stats.captureReadFrames, previous?.captureReadFrames)} capture_dropped=${stats.captureDroppedFrames} ` +
        `playback_buffered=${stats.playbackBufferedFrames} playback_submitted_delta=${delta(stats.playbackSubmittedFrames, previous?.playbackSubmittedFrames)} ` +
        `playback_written_delta=${delta(stats.playbackWrittenFrames, previous?.playbackWrittenFrames)} playback_rendered_delta=${delta(stats.playbackRenderedFrames, previous?.playbackRenderedFrames)} ` +
        `playback_dropped=${stats.playbackDroppedFrames} starvations=${stats.playbackStarvations} starvations_delta=${delta(stats.playbackStarvations, previous?.playbackStarvations)} ` +
        `starved_frames=${stats.playbackStarvedFrames} notifications=${stats.startedNotifications}/${stats.stoppedNotifications}/${stats.reroutedNotifications}/${stats.interruptionBeganNotifications}/${stats.interruptionEndedNotifications}`,
    );
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

function minimum(current: number | null, value: number): number {
  return current === null ? value : Math.min(current, value);
}

function maximum(current: number | null, value: number): number {
  return current === null ? value : Math.max(current, value);
}

function maximumValue(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

function percentile(values: readonly number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? null;
}

function countGreaterThan(values: readonly number[], threshold: number): number {
  let count = 0;
  for (const value of values) {
    if (value > threshold) count++;
  }
  return count;
}

function formatOptionalMs(value: number | null): string {
  return value === null ? "none" : value.toFixed(1);
}

function formatOptionalFrames(value: number | null): string {
  return value === null ? "none" : String(value);
}

function formatDb(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : "-inf";
}

function formatFrameRange(minimumFrames: number | null, maximumFrames: number | null): string {
  return minimumFrames === null || maximumFrames === null
    ? "none"
    : `${minimumFrames}..${maximumFrames}`;
}

function delta(current: bigint, previous: bigint | undefined): bigint {
  return previous === undefined ? current : current - previous;
}

function deviceStateName(state: number): string {
  return ["uninitialized", "stopped", "started", "starting", "stopping"][state] ?? String(state);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
