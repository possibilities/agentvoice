import { AudioAnalyzer, type AudioFrame, silence } from "./audio.ts";
import type { PersonaState } from "./visual.ts";

export interface SpeechClip {
  samples: Float32Array;
  sampleRate: number;
}
export interface Cue {
  at: number;
  state: PersonaState;
  text: string;
}
export interface AudioSource {
  readonly kind: "replay" | "microphone";
  readonly label: string;
  readonly frame: AudioFrame;
  readonly position: number;
  readonly duration: number;
  readonly cue: Cue | undefined;
  advance(seconds: number): void;
  seek(seconds: number): void;
  setRunning(running: boolean): void;
  close(): void;
}

export const maxWavBytes = 24 * 1024 * 1024;

/** Deliberately bounded WAV support: mono/stereo PCM16 or IEEE float32. */
export function decodeWav(bytes: Buffer): SpeechClip {
  if (bytes.length > maxWavBytes) throw new Error("WAV exceeds 24 MiB");
  if (
    bytes.length < 12 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new Error("Expected a RIFF WAVE file");
  const end = bytes.readUInt32LE(4) + 8;
  if (end > bytes.length || end < 12) throw new Error("Truncated WAV container");
  let format: Buffer | undefined;
  let data: Buffer | undefined;
  for (let offset = 12; offset < end; ) {
    if (offset + 8 > end) throw new Error("Truncated WAV chunk header");
    const name = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const next = offset + 8 + length;
    if (next + (length % 2) > end) throw new Error("Truncated WAV chunk");
    if (name === "fmt ") {
      if (format) throw new Error("Duplicate WAV format");
      format = bytes.subarray(offset + 8, next);
    }
    if (name === "data") {
      if (data) throw new Error("Duplicate WAV data");
      data = bytes.subarray(offset + 8, next);
    }
    offset = next + (length % 2);
  }
  if (!format || format.length < 16 || !data) throw new Error("WAV needs format and audio data");
  const encoding = format.readUInt16LE(0);
  const channels = format.readUInt16LE(2);
  const sampleRate = format.readUInt32LE(4);
  const alignment = format.readUInt16LE(12);
  const bits = format.readUInt16LE(14);
  if (
    !((encoding === 1 && bits === 16) || (encoding === 3 && bits === 32)) ||
    channels < 1 ||
    channels > 2
  )
    throw new Error("Use a mono or stereo PCM16 / float32 WAV file");
  if (
    sampleRate < 8000 ||
    sampleRate > 96000 ||
    alignment !== (channels * bits) / 8 ||
    data.length % alignment
  )
    throw new Error("Invalid WAV rate or sample alignment (supported: 8000–96000 Hz)");
  const count = data.length / alignment;
  if (count < sampleRate * 0.02 || count > sampleRate * 120)
    throw new Error("WAV duration must be 20 ms–120 seconds");
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      const offset = i * alignment + (channel * bits) / 8;
      const value = encoding === 1 ? data.readInt16LE(offset) / 32768 : data.readFloatLE(offset);
      if (!Number.isFinite(value)) throw new Error("WAV contains non-finite samples");
      sum += Math.max(-1, Math.min(1, value));
    }
    samples[i] = sum / channels;
  }
  return { samples, sampleRate };
}

export async function loadWav(path: string): Promise<SpeechClip> {
  const file = Bun.file(path);
  if (file.size > maxWavBytes) throw new Error("WAV exceeds 24 MiB");
  return decodeWav(Buffer.from(await file.arrayBuffer()));
}

export class SpeechReplay implements AudioSource {
  readonly kind = "replay";
  private analyzer: AudioAnalyzer;
  private current = silence();
  private cursor = 0;
  private remainder = 0;
  private running = false;
  private closed = false;

  constructor(
    readonly clip: SpeechClip,
    readonly label: string,
    readonly cues: readonly Cue[] = [],
  ) {
    this.analyzer = new AudioAnalyzer(clip.sampleRate);
    if (clip.samples.length < clip.sampleRate * 0.02) throw new Error("Speech clip is too short");
  }
  get frame(): AudioFrame {
    return this.current;
  }
  get position(): number {
    return this.cursor / this.clip.sampleRate;
  }
  get duration(): number {
    return this.clip.samples.length / this.clip.sampleRate;
  }
  get cue(): Cue | undefined {
    return this.cues.findLast((cue) => cue.at <= this.position);
  }

  setRunning(running: boolean): void {
    this.running = running && !this.closed;
  }

  advance(seconds: number): void {
    if (!this.running || !Number.isFinite(seconds) || seconds <= 0) return;
    this.remainder += Math.min(0.1, seconds) * this.clip.sampleRate;
    let remaining = Math.floor(this.remainder);
    this.remainder -= remaining;
    while (remaining > 0) {
      const take = Math.min(remaining, this.clip.samples.length - this.cursor);
      const frame = this.analyzer.push(this.clip.samples.subarray(this.cursor, this.cursor + take));
      if (frame.revision) this.current = frame;
      this.cursor += take;
      remaining -= take;
      if (this.cursor === this.clip.samples.length) {
        this.cursor = 0;
        this.analyzer = new AudioAnalyzer(this.clip.sampleRate);
      }
    }
  }

  seek(seconds: number): void {
    if (this.closed || !Number.isFinite(seconds)) return;
    this.cursor = Math.floor(
      Math.max(0, Math.min(this.duration - 1 / this.clip.sampleRate, seconds)) *
        this.clip.sampleRate,
    );
    this.remainder = 0;
    this.analyzer = new AudioAnalyzer(this.clip.sampleRate);
    this.current = this.analyzer.push(
      this.clip.samples.subarray(
        Math.max(0, this.cursor - Math.round(this.clip.sampleRate * 0.08)),
        this.cursor,
      ),
    );
  }

  close(): void {
    this.closed = true;
    this.running = false;
  }
}

export interface CaptureDevice {
  start(): void;
  stop(): void;
  close(): void;
  readCapture(target: Buffer): number;
}

/** Loaded only by the standalone lab's explicit --mic path. Never feeds playback. */
export class MicrophoneSource implements AudioSource {
  readonly kind = "microphone";
  readonly label = "Microphone · live input";
  readonly duration = 0;
  readonly cue = undefined;
  position = 0;
  private analyzer = new AudioAnalyzer(48000);
  private chunk = Buffer.alloc(960 * 2);
  private running = false;
  private closed = false;
  private current = silence();
  constructor(private device: CaptureDevice) {}
  get frame(): AudioFrame {
    return this.current;
  }

  setRunning(running: boolean): void {
    if (this.closed || running === this.running) return;
    if (running) {
      // Discard buffered capture from before a pause before admitting fresh samples.
      for (let i = 0; i < 64 && this.device.readCapture(this.chunk) > 0; i++) {}
      this.analyzer = new AudioAnalyzer(48000);
      this.current = silence();
      try {
        this.device.start();
      } catch (error) {
        this.close();
        throw error;
      }
    } else {
      try {
        this.device.stop();
      } catch (error) {
        this.close();
        throw error;
      }
      this.current = silence();
    }
    this.running = running;
  }

  advance(seconds: number): void {
    if (!this.running || this.closed) return;
    this.position += Math.max(0, Math.min(0.1, seconds));
    for (let i = 0; i < 32; i++) {
      const count = this.device.readCapture(this.chunk);
      if (!count) break;
      if (!Number.isInteger(count) || count < 0 || count > 960)
        throw new Error("Invalid microphone frame count");
      this.current = this.analyzer.pushS16(this.chunk.subarray(0, count * 2));
    }
  }
  seek(): void {}
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.running = false;
    this.current = silence();
    this.device.close();
  }
}

export async function demoSpeech(): Promise<SpeechReplay> {
  const [you, agent] = await Promise.all([
    loadWav(`${import.meta.dir}/fixtures/you.wav`),
    loadWav(`${import.meta.dir}/fixtures/agent.wav`),
  ]);
  return composeDemo(you, agent);
}

export function composeDemo(you: SpeechClip, agent: SpeechClip): SpeechReplay {
  if (you.sampleRate !== agent.sampleRate) throw new Error("Demo sample rates must match");
  const rate = you.sampleRate;
  const parts = [
    new Float32Array(rate),
    you.samples,
    new Float32Array(rate * 2),
    agent.samples,
    new Float32Array(rate * 4),
  ];
  const samples = new Float32Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    samples.set(part, offset);
    offset += part.length;
  }
  const heard = 1 + you.samples.length / rate;
  const spoke = heard + 2 + agent.samples.length / rate;
  return new SpeechReplay({ samples, sampleRate: rate }, "Speech demo · silent replay", [
    { at: 0, state: "idle", text: "Ready when you are." },
    { at: 1, state: "listening", text: "Help me find a little more space in my day." },
    { at: heard, state: "thinking", text: "Finding a place to begin…" },
    {
      at: heard + 2,
      state: "speaking",
      text: "Let's start with one thing. What can wait until tomorrow?",
    },
    { at: spoke, state: "idle", text: "Take your time." },
    { at: spoke + 1.5, state: "asleep", text: "Resting." },
  ]);
}
