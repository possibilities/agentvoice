import { mkdirSync } from "node:fs";
import OpusScript from "opusscript";
import type { EventJournal } from "./events.ts";
import { environmentWithoutOpenAiApiKey } from "./local-env.ts";

export const AUDIO_SAMPLE_RATE = 48_000;
export const AUDIO_FRAME_MS = 20;
export const AUDIO_FRAME_SAMPLES = (AUDIO_SAMPLE_RATE * AUDIO_FRAME_MS) / 1_000;
export const AUDIBLE_OVERLAP_RESOLUTION_SAMPLES = AUDIO_SAMPLE_RATE / 1_000;
export const MONO_FRAME_BYTES = AUDIO_FRAME_SAMPLES * 2;
export const AUDIBLE_RMS_THRESHOLD = 64;

const SILENCE_FRAME = Buffer.alloc(MONO_FRAME_BYTES);

export async function normalizeAudioToMonoPcm(path: string): Promise<Buffer> {
  if (!(await Bun.file(path).exists())) {
    throw new Error(`fixture audio does not exist: ${path}`);
  }
  const child = Bun.spawn(
    [
      "ffmpeg",
      "-v",
      "error",
      "-i",
      path,
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "-ar",
      String(AUDIO_SAMPLE_RATE),
      "-ac",
      "1",
      "pipe:1",
    ],
    {
      env: environmentWithoutOpenAiApiKey(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`ffmpeg could not normalize ${path}: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  const pcm = Buffer.from(stdout);
  if (pcm.length === 0) throw new Error(`fixture audio is empty: ${path}`);
  return pcm.subarray(0, pcm.length - (pcm.length % 2));
}

interface ActivePlayback {
  id: string;
  pcm: Buffer;
  offset: number;
  startSample: number;
  resolve(): void;
  reject(error: Error): void;
}

export interface UplinkOptions {
  sendOpus(payload: Buffer): void;
  recorder: DuplexRecorder;
  journal: EventJournal;
}

/** Keeps the uplink alive with 20 ms Opus frames and overlays scripted audio. */
export class ContinuousUplink {
  private readonly options: UplinkOptions;
  private readonly encoder = new OpusScript(AUDIO_SAMPLE_RATE, 1, OpusScript.Application.VOIP);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: ActivePlayback | null = null;
  private nextFrameAt = 0;
  private stopped = true;

  constructor(options: UplinkOptions) {
    this.options = options;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.options.recorder.beginTimeline();
    this.nextFrameAt = performance.now();
    this.schedule();
  }

  play(id: string, pcm: Buffer): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("audio uplink is not running"));
    if (this.active) {
      return Promise.reject(
        new Error(`cannot play ${id}; fixture utterance ${this.active.id} is still playing`),
      );
    }
    return new Promise((resolve, reject) => {
      const startSample = this.options.recorder.currentInputSample();
      this.active = { id, pcm, offset: 0, startSample, resolve, reject };
      this.options.journal.record("media", "input.audio.started", {
        id,
        durationMs: (pcm.length / 2 / AUDIO_SAMPLE_RATE) * 1_000,
        startSample,
      });
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.active) {
      this.active.reject(new Error("audio uplink stopped"));
      this.active = null;
    }
    this.encoder.delete();
  }

  private schedule(): void {
    if (this.stopped) return;
    const now = performance.now();
    if (now - this.nextFrameAt > AUDIO_FRAME_MS * 3) {
      this.options.journal.record("media", "input.audio.clock-reset", {
        lagMs: now - this.nextFrameAt,
      });
      this.nextFrameAt = now;
    }
    const delay = Math.max(0, this.nextFrameAt - now);
    this.timer = setTimeout(() => {
      this.tick();
      this.nextFrameAt += AUDIO_FRAME_MS;
      this.schedule();
    }, delay);
  }

  private tick(): void {
    const frame = Buffer.alloc(MONO_FRAME_BYTES);
    const active = this.active;
    if (active) {
      const remaining = active.pcm.length - active.offset;
      const bytes = Math.min(MONO_FRAME_BYTES, remaining);
      active.pcm.copy(frame, 0, active.offset, active.offset + bytes);
      active.offset += bytes;
    } else {
      SILENCE_FRAME.copy(frame);
    }

    this.options.recorder.recordInput(frame);
    const encoded = Buffer.from(this.encoder.encode(frame, AUDIO_FRAME_SAMPLES));
    this.options.sendOpus(encoded);

    if (active && active.offset >= active.pcm.length) {
      this.active = null;
      this.options.journal.record("media", "input.audio.finished", {
        id: active.id,
        startSample: active.startSample,
        endSample: this.options.recorder.currentInputSample(),
      });
      active.resolve();
    }
  }
}

interface OutputSegment {
  sampleOffset: number;
  pcm: Buffer;
}

export interface AudibleOverlapMeasurement {
  sampleRate: number;
  windowSamples: number;
  resolutionSamples: number;
  inputStartSample: number;
  inputEndSample: number;
  overlappingWindowCount: number;
  overlappingSampleCount: number;
  overlapDurationMs: number;
}

/** Captures an aligned duplex timeline and emits mono plus stereo-review WAVs. */
export class DuplexRecorder {
  private startedAt = performance.now();
  private readonly inputFrames: Buffer[] = [];
  private readonly outputSegments: OutputSegment[] = [];
  private inputSamples = 0;
  private outputBaseTimestamp: number | null = null;
  private outputBaseSample = 0;
  private wallOutputCursor: number | null = null;
  private wallOutputReceivedAt: number | null = null;

  beginTimeline(): void {
    if (this.inputFrames.length > 0 || this.outputSegments.length > 0) {
      throw new Error("cannot restart a duplex recording after media was captured");
    }
    this.startedAt = performance.now();
  }

  currentInputSample(): number {
    return this.inputSamples;
  }

  recordInput(frame: Buffer): void {
    if (frame.length !== MONO_FRAME_BYTES) {
      throw new Error(`input frame is ${frame.length} bytes; expected ${MONO_FRAME_BYTES}`);
    }
    this.inputFrames.push(Buffer.from(frame));
    this.inputSamples += AUDIO_FRAME_SAMPLES;
  }

  recordOutput(stereoPcm: Buffer, rtpTimestamp: number): void {
    const mono = downmixStereoS16(stereoPcm);
    if (this.outputBaseTimestamp === null) {
      this.outputBaseTimestamp = rtpTimestamp;
      this.outputBaseSample = Math.max(
        0,
        Math.round(((performance.now() - this.startedAt) / 1_000) * AUDIO_SAMPLE_RATE),
      );
    }
    const timestampDelta = (rtpTimestamp - this.outputBaseTimestamp) >>> 0;
    this.outputSegments.push({
      sampleOffset: this.outputBaseSample + timestampDelta,
      pcm: mono,
    });
  }

  /** Records a 48 kHz mono frame received from a transport without RTP timestamps. */
  recordOutputMonoFrame(monoPcm: Buffer): void {
    if (monoPcm.length === 0 || monoPcm.length % 2 !== 0) {
      throw new Error("output mono frame must contain complete 16-bit samples");
    }
    const receivedAt = performance.now();
    const samples = monoPcm.length / 2;
    const wallEnd = Math.max(
      0,
      Math.round(((receivedAt - this.startedAt) / 1_000) * AUDIO_SAMPLE_RATE),
    );
    const frameDurationMs = (samples / AUDIO_SAMPLE_RATE) * 1_000;
    const contiguous =
      this.wallOutputCursor !== null &&
      this.wallOutputReceivedAt !== null &&
      receivedAt - this.wallOutputReceivedAt <= Math.max(100, frameDurationMs * 3);
    const sampleOffset = contiguous
      ? this.wallOutputCursor!
      : Math.max(this.wallOutputCursor ?? 0, wallEnd - samples);
    this.outputSegments.push({ sampleOffset, pcm: Buffer.from(monoPcm) });
    this.wallOutputCursor = sampleOffset + samples;
    this.wallOutputReceivedAt = receivedAt;
  }

  measureAudibleOverlap(
    inputStartSample: number,
    inputEndSample: number,
  ): AudibleOverlapMeasurement {
    const { input, output } = this.renderTracks(inputEndSample);
    return measureAudiblePcmOverlap(input, output, inputStartSample, inputEndSample);
  }

  async write(directory: string): Promise<{ durationMs: number }> {
    const { input, output, totalSamples } = this.renderTracks();
    const stereo = interleaveStereo(input, output);

    mkdirSync(directory, { recursive: true });
    await Promise.all([
      Bun.write(`${directory}/input.wav`, wavBuffer(input, 1)),
      Bun.write(`${directory}/output.wav`, wavBuffer(output, 1)),
      Bun.write(`${directory}/comparison.wav`, wavBuffer(stereo, 2)),
    ]);
    return { durationMs: (totalSamples / AUDIO_SAMPLE_RATE) * 1_000 };
  }

  private renderTracks(minimumSamples = 0): {
    input: Buffer;
    output: Buffer;
    totalSamples: number;
  } {
    const elapsedSamples = Math.ceil(
      ((performance.now() - this.startedAt) / 1_000) * AUDIO_SAMPLE_RATE,
    );
    let totalSamples = Math.max(this.inputSamples, elapsedSamples, minimumSamples);
    for (const segment of this.outputSegments) {
      totalSamples = Math.max(totalSamples, segment.sampleOffset + segment.pcm.length / 2);
    }

    const input = Buffer.alloc(totalSamples * 2);
    Buffer.concat(this.inputFrames).copy(input);
    const output = Buffer.alloc(totalSamples * 2);
    for (const segment of this.outputSegments) {
      segment.pcm.copy(output, segment.sampleOffset * 2);
    }
    return { input, output, totalSamples };
  }
}

export function measureAudiblePcmOverlap(
  input: Buffer,
  output: Buffer,
  inputStartSample: number,
  inputEndSample: number,
  windowSamples = AUDIO_FRAME_SAMPLES,
): AudibleOverlapMeasurement {
  if (!Number.isInteger(inputStartSample) || inputStartSample < 0) {
    throw new Error(`inputStartSample must be a nonnegative integer; got ${inputStartSample}`);
  }
  if (!Number.isInteger(inputEndSample) || inputEndSample <= inputStartSample) {
    throw new Error(`inputEndSample must be greater than inputStartSample; got ${inputEndSample}`);
  }
  if (!Number.isInteger(windowSamples) || windowSamples < 1) {
    throw new Error(`windowSamples must be a positive integer; got ${windowSamples}`);
  }

  let overlappingWindowCount = 0;
  let overlappingSampleCount = 0;
  for (let offset = inputStartSample; offset < inputEndSample; offset += windowSamples) {
    const windowEnd = Math.min(offset + windowSamples, inputEndSample);
    let windowOverlapSamples = 0;
    for (
      let resolutionOffset = offset;
      resolutionOffset < windowEnd;
      resolutionOffset += AUDIBLE_OVERLAP_RESOLUTION_SAMPLES
    ) {
      const samples = Math.min(AUDIBLE_OVERLAP_RESOLUTION_SAMPLES, windowEnd - resolutionOffset);
      if (
        isAudiblePcmRange(input, resolutionOffset, samples) &&
        isAudiblePcmRange(output, resolutionOffset, samples)
      ) {
        windowOverlapSamples += samples;
      }
    }
    if (windowOverlapSamples > 0) {
      overlappingWindowCount++;
      overlappingSampleCount += windowOverlapSamples;
    }
  }
  return {
    sampleRate: AUDIO_SAMPLE_RATE,
    windowSamples,
    resolutionSamples: AUDIBLE_OVERLAP_RESOLUTION_SAMPLES,
    inputStartSample,
    inputEndSample,
    overlappingWindowCount,
    overlappingSampleCount,
    overlapDurationMs: (overlappingSampleCount / AUDIO_SAMPLE_RATE) * 1_000,
  };
}

function isAudiblePcmRange(pcm: Buffer, startSample: number, sampleCount: number): boolean {
  let sumSquares = 0;
  for (let sample = 0; sample < sampleCount; sample++) {
    const byteOffset = (startSample + sample) * 2;
    const value = byteOffset + 1 < pcm.length ? pcm.readInt16LE(byteOffset) : 0;
    sumSquares += value * value;
  }
  return Math.sqrt(sumSquares / sampleCount) >= AUDIBLE_RMS_THRESHOLD;
}

export function wavBuffer(pcm: Buffer, channels: 1 | 2): Buffer {
  const blockAlign = channels * 2;
  const byteRate = AUDIO_SAMPLE_RATE * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(AUDIO_SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function downmixStereoS16(stereo: Buffer): Buffer {
  const frames = Math.floor(stereo.length / 4);
  const mono = Buffer.allocUnsafe(frames * 2);
  for (let frame = 0; frame < frames; frame++) {
    const left = stereo.readInt16LE(frame * 4);
    const right = stereo.readInt16LE(frame * 4 + 2);
    mono.writeInt16LE(Math.round((left + right) / 2), frame * 2);
  }
  return mono;
}

function interleaveStereo(left: Buffer, right: Buffer): Buffer {
  const samples = Math.max(left.length, right.length) / 2;
  const stereo = Buffer.alloc(samples * 4);
  for (let sample = 0; sample < samples; sample++) {
    stereo.writeInt16LE(left.readInt16LE(sample * 2), sample * 4);
    stereo.writeInt16LE(right.readInt16LE(sample * 2), sample * 4 + 2);
  }
  return stereo;
}
