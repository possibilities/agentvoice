import { describe, expect, test } from "bun:test";
import { AUDIO_SAMPLE_RATE, wavBuffer } from "../src/audio.ts";
import {
  analyzeDuplexActivity,
  analyzePcm16Track,
  analyzePcm16Wav,
  parsePcm16Wav,
  planBlindAudioClips,
  type TimedAudioEvent,
} from "../src/audio-analysis.ts";

describe("PCM WAV validation", () => {
  test("parses and deinterleaves canonical stereo PCM", () => {
    const interleaved = pcm(4, (sample) => [sample * 100, sample * -200]);
    const parsed = parsePcm16Wav(wavBuffer(interleaved, 2));

    expect(parsed).toMatchObject({
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: 2,
      bitsPerSample: 16,
      sampleCountPerChannel: 4,
    });
    expect(samples(parsed.tracks[0]!)).toEqual([0, 100, 200, 300]);
    expect(samples(parsed.tracks[1]!)).toEqual([0, -200, -400, -600]);
  });

  test("rejects a corrupt RIFF length and incomplete sample frame", () => {
    const valid = wavBuffer(Buffer.alloc(8), 2);
    const wrongLength = Buffer.from(valid);
    wrongLength.writeUInt32LE(valid.length, 4);
    expect(() => parsePcm16Wav(wrongLength)).toThrow("RIFF length declares");

    const incomplete = Buffer.concat([valid, Buffer.alloc(2)]);
    incomplete.writeUInt32LE(incomplete.length - 8, 4);
    incomplete.writeUInt32LE(10, 40);
    expect(() => parsePcm16Wav(incomplete)).toThrow("complete interleaved sample frame");
  });

  test("includes a content hash in reusable WAV evidence", () => {
    const wav = wavBuffer(Buffer.alloc(AUDIO_SAMPLE_RATE * 2), 1);
    const analysis = analyzePcm16Wav(wav);

    expect(analysis.sha256).toHaveLength(64);
    expect(analysis.format.durationMs).toBe(1_000);
    expect(analysis.tracks[0]!.peakDbfs).toBeNull();
    expect(analysis.duplex).toBeNull();
  });
});

describe("deterministic signal metrics", () => {
  test("reports activity, clipping, silence, and bounded digital-zero candidates", () => {
    const track = Buffer.alloc(1_000 * 2);
    writeSquareWave(track, 100, 400, 1_000);
    track.writeInt16LE(32_767, 200 * 2);
    writeSquareWave(track, 440, 800, 1_000);

    const analysis = analyzePcm16Track(track, 1_000);

    expect(analysis).toMatchObject({
      durationMs: 1_000,
      frameSamples: 20,
      activeFrameCount: 33,
      silentFrameCount: 17,
      activeDurationMs: 660,
      activeTimelineRatio: 0.66,
      leadingSilenceMs: 100,
      trailingSilenceMs: 200,
      clippedSampleCount: 1,
      dropoutHeuristic: {
        candidateCount: 1,
        totalCandidateMs: 40,
        longestCandidateMs: 40,
      },
    });
    expect(analysis.activityRegions).toEqual([
      {
        startSample: 100,
        endSample: 800,
        startMs: 100,
        endMs: 800,
        durationMs: 700,
      },
    ]);
    expect(analysis.dropoutHeuristic.candidates[0]).toMatchObject({
      startMs: 400,
      endMs: 440,
    });
  });

  test("measures simultaneous audibility at a requested resolution", () => {
    const input = Buffer.alloc(200 * 2);
    const output = Buffer.alloc(200 * 2);
    writeSquareWave(input, 0, 100, 1_000);
    writeSquareWave(output, 50, 150, 1_000);

    expect(analyzeDuplexActivity(input, output, 1_000, -50, 10)).toMatchObject({
      resolutionMs: 10,
      inputOnlyMs: 50,
      outputOnlyMs: 50,
      simultaneousAudibleMs: 50,
      neitherAudibleMs: 50,
      simultaneousShareOfInputActivity: 0.5,
      simultaneousShareOfOutputActivity: 0.5,
    });
  });
});

describe("blind listening clip plan", () => {
  test("keeps full evidence and derives semantic steering and final windows", () => {
    const events: TimedAudioEvent[] = [
      event(1, 10_000, "media", "input.audio.started", { id: "steer" }),
      event(2, 18_000, "realtime", "delegation.created", {}),
      event(3, 30_000, "media", "input.audio.started", { id: "verify" }),
    ];

    expect(planBlindAudioClips(events, 50_000)).toEqual({
      schemaVersion: 1,
      artifactDurationMs: 50_000,
      timelineAlignment: {
        journalToAudioOffsetMs: 0,
        source: "assumed-zero",
      },
      clips: [
        expect.objectContaining({
          id: "output-quality",
          source: "output.wav",
          startMs: 0,
          endMs: 50_000,
        }),
        expect.objectContaining({
          id: "conversation-timing",
          source: "comparison.wav",
          startMs: 0,
          endMs: 50_000,
        }),
        expect.objectContaining({
          id: "steering-interaction",
          startMs: 9_000,
          endMs: 26_000,
          durationMs: 17_000,
        }),
        expect.objectContaining({
          id: "final-exchange",
          startMs: 29_500,
          endMs: 50_000,
          durationMs: 20_500,
        }),
      ],
    });
  });

  test("aligns journal times to sample-anchored audio time", () => {
    const events: TimedAudioEvent[] = [
      event(1, 10_000, "media", "input.audio.started", {
        id: "steer",
        startSample: 48_000,
      }),
      event(2, 18_000, "realtime", "delegation.created", {}),
      event(3, 30_000, "media", "input.audio.started", {
        id: "verify",
        startSample: 1_008_000,
      }),
    ];

    const plan = planBlindAudioClips(events, 50_000);
    expect(plan.timelineAlignment).toEqual({
      journalToAudioOffsetMs: 9_000,
      source: "input-start-samples",
    });
    expect(plan.clips[2]).toMatchObject({ startMs: 0, endMs: 17_000 });
    expect(plan.clips[3]).toMatchObject({ startMs: 20_500, endMs: 50_000 });
  });
});

function pcm(sampleCount: number, values: (sample: number) => readonly [number, number]): Buffer {
  const result = Buffer.alloc(sampleCount * 4);
  for (let sample = 0; sample < sampleCount; sample++) {
    const [left, right] = values(sample);
    result.writeInt16LE(left, sample * 4);
    result.writeInt16LE(right, sample * 4 + 2);
  }
  return result;
}

function samples(track: Buffer): number[] {
  const result: number[] = [];
  for (let offset = 0; offset < track.length; offset += 2) result.push(track.readInt16LE(offset));
  return result;
}

function writeSquareWave(track: Buffer, startSample: number, endSample: number, amplitude: number) {
  for (let sample = startSample; sample < endSample; sample++) {
    track.writeInt16LE(sample % 2 === 0 ? amplitude : -amplitude, sample * 2);
  }
}

function event(
  seq: number,
  atMs: number,
  source: string,
  type: string,
  data: Record<string, unknown>,
): TimedAudioEvent {
  return { seq, atMs, source, type, data };
}
