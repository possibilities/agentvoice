/** Pure audio-math and meter-rendering helpers for the voice client. */

export const SAMPLE_RATE = 48_000;
/** 20 ms of mono audio at 48 kHz — one Opus frame. */
export const FRAME_SAMPLES = 960;

/** Interleaved f32 [-1,1] → interleaved s16le, clamped. */
export function floatToS16(pcm: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    const sample = Math.max(-1, Math.min(1, pcm[i]!));
    out.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  return out;
}

/** RMS of f32 samples in dBFS; -Infinity for silence/empty. */
export function rmsDbFloat(pcm: Float32Array): number {
  if (pcm.length === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!;
  const rms = Math.sqrt(sum / pcm.length);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/** RMS of interleaved s16le samples in dBFS; -Infinity for silence/empty. */
export function rmsDbS16(buffer: Buffer): number {
  const samples = Math.floor(buffer.length / 2);
  if (samples === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const sample = buffer.readInt16LE(i * 2) / 32768;
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / samples);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/** Map dBFS to a 0..1 meter level over a floor (default -60 dB). */
export function levelFromDb(db: number, floorDb = -60): number {
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db - floorDb) / -floorDb));
}

const BAR_PARTIALS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

/** Horizontal level bar with 1/8-cell resolution, exactly `width` chars. */
export function barString(level: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, level));
  const cells = clamped * width;
  const full = Math.floor(cells);
  const partial = full < width ? BAR_PARTIALS[Math.round((cells - full) * 7)]! : "";
  return ("█".repeat(full) + partial).padEnd(width, " ");
}

const SPARK_CHARS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** Right-aligned history sparkline: newest sample at the right edge. */
export function sparkline(history: readonly number[], width: number): string {
  const window = history.slice(-width);
  const chars = window.map((level) => {
    const clamped = Math.max(0, Math.min(1, level));
    return SPARK_CHARS[Math.round(clamped * 8)]!;
  });
  return chars.join("").padStart(width, " ");
}

/** "mm:ss" (or "h:mm:ss" past an hour); negatives clamp to 0:00. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

/** First 8 chars of a long id, with an ellipsis when truncated. */
export function shortId(id: string): string {
  return id.length > 9 ? `${id.slice(0, 8)}…` : id;
}
