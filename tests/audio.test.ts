import { describe, expect, test } from "bun:test";
import {
  AUDIBLE_OVERLAP_RESOLUTION_SAMPLES,
  AUDIO_FRAME_SAMPLES,
  AUDIO_SAMPLE_RATE,
  measureAudiblePcmOverlap,
  wavBuffer,
} from "../src/audio.ts";
import { isAudiblePcm } from "../src/realtime-peer.ts";

describe("wavBuffer", () => {
  test("writes a valid mono PCM header", () => {
    const pcm = Buffer.alloc(AUDIO_SAMPLE_RATE * 2);
    const wav = wavBuffer(pcm, 1);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(AUDIO_SAMPLE_RATE);
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
  });

  test("writes stereo block alignment and byte rate", () => {
    const wav = wavBuffer(Buffer.alloc(AUDIO_SAMPLE_RATE * 4), 2);
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt16LE(32)).toBe(4);
    expect(wav.readUInt32LE(28)).toBe(AUDIO_SAMPLE_RATE * 4);
  });
});

describe("output speech activity", () => {
  test("ignores continuous silent RTP but detects voiced PCM", () => {
    expect(isAudiblePcm(Buffer.alloc(1_920 * 2))).toBe(false);
    const voiced = Buffer.alloc(1_920 * 2);
    for (let offset = 0; offset < voiced.length; offset += 2) {
      voiced.writeInt16LE(offset % 4 === 0 ? 1_000 : -1_000, offset);
    }
    expect(isAudiblePcm(voiced)).toBe(true);
  });
});

describe("decoded PCM overlap", () => {
  test("counts only aligned windows where both tracks are audible", () => {
    const input = voicedPcm(AUDIO_FRAME_SAMPLES * 3);
    const output = Buffer.alloc(input.length);
    voicedPcm(AUDIO_FRAME_SAMPLES).copy(output, AUDIO_FRAME_SAMPLES * 2);

    expect(measureAudiblePcmOverlap(input, output, 0, AUDIO_FRAME_SAMPLES * 3)).toMatchObject({
      windowSamples: AUDIO_FRAME_SAMPLES,
      resolutionSamples: AUDIBLE_OVERLAP_RESOLUTION_SAMPLES,
      overlappingWindowCount: 1,
      overlappingSampleCount: AUDIO_FRAME_SAMPLES,
      overlapDurationMs: 20,
    });
  });

  test("does not confuse adjacent audible windows with full-duplex overlap", () => {
    const input = Buffer.alloc(AUDIO_FRAME_SAMPLES * 4);
    const output = Buffer.alloc(input.length);
    voicedPcm(AUDIO_FRAME_SAMPLES).copy(input, 0);
    voicedPcm(AUDIO_FRAME_SAMPLES).copy(output, AUDIO_FRAME_SAMPLES * 2);

    expect(measureAudiblePcmOverlap(input, output, 0, AUDIO_FRAME_SAMPLES * 2)).toMatchObject({
      overlappingWindowCount: 0,
      overlappingSampleCount: 0,
      overlapDurationMs: 0,
    });
  });

  test("does not count disjoint speech inside the same 20 ms window", () => {
    const input = Buffer.alloc(AUDIO_FRAME_SAMPLES * 2);
    const output = Buffer.alloc(input.length);
    const halfWindow = AUDIO_FRAME_SAMPLES / 2;
    voicedPcm(halfWindow).copy(input, 0);
    voicedPcm(halfWindow).copy(output, halfWindow * 2);

    expect(measureAudiblePcmOverlap(input, output, 0, AUDIO_FRAME_SAMPLES)).toMatchObject({
      overlappingWindowCount: 0,
      overlappingSampleCount: 0,
      overlapDurationMs: 0,
    });
  });
});

function voicedPcm(sampleCount: number): Buffer {
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let offset = 0; offset < pcm.length; offset += 2) {
    pcm.writeInt16LE(offset % 4 === 0 ? 1_000 : -1_000, offset);
  }
  return pcm;
}
