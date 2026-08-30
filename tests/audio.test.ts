import { describe, expect, test } from "bun:test";
import { AUDIO_SAMPLE_RATE, wavBuffer } from "../src/audio.ts";
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
