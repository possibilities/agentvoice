export interface AudioFrame {
  readonly stream: number;
  readonly revision: number;
  readonly rms: number;
  readonly peak: number;
  readonly level: number;
  readonly onset: number;
  readonly onsetRevision: number;
  readonly centroid: number;
  readonly waveform: Float32Array;
  readonly bands: Float32Array;
}

export interface PersonaAudio {
  input?: AudioFrame;
  output?: AudioFrame;
}

export const silence = (): AudioFrame => ({
  stream: 0,
  revision: 0,
  rms: 0,
  peak: 0,
  level: 0,
  onset: 0,
  onsetRevision: 0,
  centroid: 0,
  waveform: new Float32Array(128),
  bands: new Float32Array(16),
});

export const clamp = (n: number, min = 0, max = 1): number =>
  Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;

const size = 1024;
let nextStream = 0;
const loudness = (n: number) => clamp((20 * Math.log10(Math.max(1e-9, n)) + 60) / 54);

/** Fixed 20 ms analysis hops make envelopes independent of producer chunking. */
export class AudioAnalyzer {
  frame = silence();
  private ring = new Float64Array(size);
  private real = new Float64Array(size);
  private imaginary = new Float64Array(size);
  private cursor = 0;
  private count = 0;
  private sum = 0;
  private peak = 0;
  private previousSample = 0;
  private highPass = 0;
  private hop: number;
  private previousLevel = 0;

  constructor(readonly sampleRate: number) {
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000)
      throw new RangeError("Audio sample rate must be 8000–96000 Hz");
    this.hop = Math.round(sampleRate / 50);
    this.frame = { ...silence(), stream: ++nextStream };
  }

  push(samples: Float32Array): AudioFrame {
    if (samples.length > this.sampleRate * 2)
      throw new RangeError("Feed audio in chunks of at most two seconds");
    for (const value of samples) {
      const sample = Number.isFinite(value) ? clamp(value, -1, 1) : 0;
      const filtered = sample - this.previousSample + 0.995 * this.highPass;
      this.previousSample = sample;
      this.highPass = filtered;
      this.ring[this.cursor] = filtered;
      this.cursor = (this.cursor + 1) % size;
      this.sum += filtered * filtered;
      this.peak = Math.max(this.peak, Math.abs(filtered));
      if (++this.count === this.hop) this.analyze();
    }
    return this.frame;
  }

  pushS16(pcm: Buffer): AudioFrame {
    if (pcm.length % 2) throw new Error("PCM must contain whole signed 16-bit mono samples");
    if (pcm.length > this.sampleRate * 4) throw new RangeError("PCM chunk exceeds two seconds");
    const samples = new Float32Array(pcm.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
    return this.push(samples);
  }

  private analyze(): void {
    const rms = clamp(Math.sqrt(this.sum / this.count));
    const target = loudness(rms);
    const level =
      this.frame.level + (target - this.frame.level) * (target > this.frame.level ? 0.7 : 0.16);
    const waveform = new Float32Array(128);
    for (let i = 0; i < size; i++) {
      const value = this.ring[(this.cursor + i) % size]!;
      this.real[i] = value * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
      this.imaginary[i] = 0;
    }
    // Keep the most recent 8 ms for a readable vocal trace at every sample rate.
    const span = Math.min(size, Math.round(this.sampleRate * 0.008));
    for (let i = 0; i < waveform.length; i++)
      waveform[i] = clamp(
        this.ring[(this.cursor - span + Math.floor((i * span) / 128) + size) % size]!,
        -1,
        1,
      );
    fft(this.real, this.imaginary);
    const bands = new Float32Array(16);
    const upper = Math.min(12000, this.sampleRate / 2);
    let mass = 0;
    let moment = 0;
    for (let b = 0; b < bands.length; b++) {
      const low = 60 * (upper / 60) ** (b / bands.length);
      const high = 60 * (upper / 60) ** ((b + 1) / bands.length);
      const first = Math.max(1, Math.floor((low * size) / this.sampleRate));
      const last = Math.min(
        size / 2,
        Math.max(first + 1, Math.ceil((high * size) / this.sampleRate)),
      );
      let power = 0;
      for (let k = first; k < last; k++) power += this.real[k]! ** 2 + this.imaginary[k]! ** 2;
      const amplitude = (Math.sqrt(power) * 4) / size;
      const energy = loudness(amplitude);
      bands[b] =
        this.frame.bands[b]! +
        (energy - this.frame.bands[b]!) * (energy > this.frame.bands[b]! ? 0.8 : 0.22);
      mass += amplitude;
      moment += amplitude * (b / 15);
    }
    const revision = this.frame.revision + 1;
    const onset = clamp((target - this.previousLevel - 0.035) * 3);
    this.frame = {
      stream: this.frame.stream,
      revision,
      rms,
      peak: clamp(this.peak),
      level: level < 0.0001 ? 0 : level,
      // Carry the last attack across hops; each visual consumes its revision once.
      onset: onset > 0.12 ? onset : this.frame.onset,
      onsetRevision: onset > 0.12 ? revision : this.frame.onsetRevision,
      centroid: mass > 0.0001 ? moment / mass : 0,
      waveform,
      bands,
    };
    this.previousLevel = target;
    this.count = this.sum = this.peak = 0;
  }
}

function fft(real: Float64Array, imaginary: Float64Array): void {
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [real[i], real[j]] = [real[j]!, real[i]!];
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    for (let base = 0; base < size; base += length) {
      for (let j = 0; j < length / 2; j++) {
        const c = Math.cos(angle * j);
        const s = Math.sin(angle * j);
        const even = base + j;
        const odd = even + length / 2;
        const r = real[odd]! * c - imaginary[odd]! * s;
        const im = real[odd]! * s + imaginary[odd]! * c;
        real[odd] = real[even]! - r;
        imaginary[odd] = imaginary[even]! - im;
        real[even] = real[even]! + r;
        imaginary[even] = imaginary[even]! + im;
      }
    }
  }
}
