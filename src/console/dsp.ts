/** Pure audio-math and meter-rendering helpers for the voice client. */

export const SAMPLE_RATE = 48_000;
/** 20 ms of mono audio at 48 kHz — one Opus frame. */
export const FRAME_SAMPLES = 960;

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

/** "mm:ss" (or "h:mm:ss" past an hour); negatives clamp to 0:00. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}
