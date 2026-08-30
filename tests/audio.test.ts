import { describe, expect, test } from "bun:test";
import { AUDIO_SAMPLE_RATE, wavBuffer } from "../src/audio.ts";

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
