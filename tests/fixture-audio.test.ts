import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIO_SAMPLE_RATE, wavBuffer } from "../src/audio.ts";
import { loadVerifiedFixtureAudio } from "../src/fixture-audio.ts";
import { loadScenario } from "../src/scenario.ts";
import { OPENAI_SPEECH_ENDPOINT } from "../src/tts.ts";

describe("verified fixture audio", () => {
  test("binds the receipt, source WAV, transcript, and normalized PCM", async () => {
    const fixture = makeFixture();
    try {
      const loaded = await loadScenario(fixture.scenarioPath);
      const result = await loadVerifiedFixtureAudio(loaded, fixture.manifestPath);

      expect(result.pcmByStepId.get("hello")).toEqual(fixture.pcm);
      expect(result.evidence).toEqual([
        {
          id: "hello",
          audio: "audio/01-hello.wav",
          transcriptSha256: sha256(fixture.transcript),
          source: {
            sha256: sha256(fixture.wave),
            bytes: fixture.wave.length,
          },
          normalized: {
            sha256: sha256(fixture.pcm),
            bytes: fixture.pcm.length,
            durationMs: 40,
            sampleRate: AUDIO_SAMPLE_RATE,
            channels: 1,
            sampleFormat: "s16le",
          },
        },
      ]);
      expect(result.provenance).toMatchObject({
        manifest: { path: "audio/tts.json" },
        receipt: {
          path: "audio/rendered.json",
          generatedAt: "2026-08-30T12:00:00.000Z",
        },
        provider: "openai",
        endpoint: OPENAI_SPEECH_ENDPOINT,
        model: "gpt-4o-mini-tts",
        voice: "marin",
        responseFormat: "wav",
        instructionsSha256: sha256(fixture.instructions),
      });
      expect(result.provenance.manifest.sha256).toHaveLength(64);
      expect(result.provenance.receipt.sha256).toHaveLength(64);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects manifest drift from the render receipt", async () => {
    const fixture = makeFixture();
    try {
      const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8"));
      manifest.voice = "cedar";
      writeFileSync(fixture.manifestPath, JSON.stringify(manifest));
      const loaded = await loadScenario(fixture.scenarioPath);

      await expect(loadVerifiedFixtureAudio(loaded, fixture.manifestPath)).rejects.toThrow(
        "receipt voice mismatch",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects transcript drift from the render receipt", async () => {
    const fixture = makeFixture();
    try {
      const scenario = JSON.parse(readFileSync(fixture.scenarioPath, "utf8"));
      scenario.steps[0]!.transcript = "Hello there!";
      writeFileSync(fixture.scenarioPath, JSON.stringify(scenario));
      const loaded = await loadScenario(fixture.scenarioPath);

      await expect(loadVerifiedFixtureAudio(loaded, fixture.manifestPath)).rejects.toThrow(
        "receipt input SHA-256 for hello mismatch",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects source byte-count and hash drift", async () => {
    const fixture = makeFixture();
    try {
      const receipt = JSON.parse(readFileSync(fixture.receiptPath, "utf8"));
      receipt.utterances[0].bytes += 1;
      writeFileSync(fixture.receiptPath, JSON.stringify(receipt));
      const loaded = await loadScenario(fixture.scenarioPath);
      await expect(loadVerifiedFixtureAudio(loaded, fixture.manifestPath)).rejects.toThrow(
        "fixture audio byte count mismatch for hello",
      );

      receipt.utterances[0].bytes -= 1;
      writeFileSync(fixture.receiptPath, JSON.stringify(receipt));
      const tampered = Buffer.from(fixture.wave);
      const finalByte = tampered.length - 1;
      tampered.writeUInt8(tampered.readUInt8(finalByte) ^ 1, finalByte);
      writeFileSync(fixture.audioPath, tampered);
      await expect(loadVerifiedFixtureAudio(loaded, fixture.manifestPath)).rejects.toThrow(
        "fixture audio SHA-256 for hello mismatch",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("requires an exact, ordered receipt utterance set", async () => {
    const fixture = makeFixture();
    try {
      const receipt = JSON.parse(readFileSync(fixture.receiptPath, "utf8"));
      receipt.utterances[0].id = "different";
      writeFileSync(fixture.receiptPath, JSON.stringify(receipt));
      const loaded = await loadScenario(fixture.scenarioPath);

      await expect(loadVerifiedFixtureAudio(loaded, fixture.manifestPath)).rejects.toThrow(
        "receipt utterance 1 id mismatch",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

interface Fixture {
  root: string;
  scenarioPath: string;
  manifestPath: string;
  receiptPath: string;
  audioPath: string;
  transcript: string;
  instructions: string;
  pcm: Buffer;
  wave: Buffer;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "agentvoice-fixture-audio-test-"));
  const audioDirectory = join(root, "audio");
  mkdirSync(audioDirectory);
  const scenarioPath = join(root, "scenario.json");
  const manifestPath = join(audioDirectory, "tts.json");
  const receiptPath = join(audioDirectory, "rendered.json");
  const audioPath = join(audioDirectory, "01-hello.wav");
  const transcript = "Hello there.";
  const instructions = "Speak naturally.";
  const pcm = Buffer.alloc((AUDIO_SAMPLE_RATE * 2 * 40) / 1_000);
  for (let offset = 0; offset < pcm.length; offset += 2) {
    pcm.writeInt16LE((offset * 31) % 32_767, offset);
  }
  const wave = wavBuffer(pcm, 1);
  writeFileSync(audioPath, wave);
  writeFileSync(
    scenarioPath,
    JSON.stringify({
      schemaVersion: 1,
      id: "fixture-audio-test",
      description: "Fixture audio verifier test.",
      workspace: "workspace",
      steps: [
        {
          type: "play",
          id: "hello",
          audio: "audio/01-hello.wav",
          transcript,
        },
      ],
    }),
  );
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      provider: "openai",
      scenario: "../scenario.json",
      model: "gpt-4o-mini-tts",
      voice: "marin",
      responseFormat: "wav",
      instructions,
      receipt: "rendered.json",
    }),
  );
  writeFileSync(
    receiptPath,
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-08-30T12:00:00.000Z",
      sourceManifest: "tts.json",
      scenario: "../scenario.json",
      provider: "openai",
      endpoint: OPENAI_SPEECH_ENDPOINT,
      model: "gpt-4o-mini-tts",
      voice: "marin",
      responseFormat: "wav",
      instructionsSha256: sha256(instructions),
      utterances: [
        {
          id: "hello",
          audio: "audio/01-hello.wav",
          inputSha256: sha256(transcript),
          audioSha256: sha256(wave),
          bytes: wave.length,
          requestId: "req_test",
        },
      ],
    }),
  );
  return {
    root,
    scenarioPath,
    manifestPath,
    receiptPath,
    audioPath,
    transcript,
    instructions,
    pcm,
    wave,
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
