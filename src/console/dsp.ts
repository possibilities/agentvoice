/** Audio framing and diagnostic math. */

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
