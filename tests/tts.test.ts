import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wavBuffer } from "../src/audio.ts";
import { buildOpenAiSpeechRequest, renderFixtureAudio, ttsManifestSchema } from "../src/tts.ts";

const manifest = ttsManifestSchema.parse({
  schemaVersion: 1,
  provider: "openai",
  scenario: "../scenario.json",
  model: "gpt-4o-mini-tts",
  voice: "marin",
  responseFormat: "wav",
  instructions: "Speak naturally.",
  receipt: "rendered.json",
});

describe("fixture TTS", () => {
  test("builds the documented OpenAI speech request", () => {
    expect(buildOpenAiSpeechRequest(manifest, "Hello there.")).toEqual({
      model: "gpt-4o-mini-tts",
      voice: "marin",
      input: "Hello there.",
      instructions: "Speak naturally.",
      response_format: "wav",
    });
  });

  test("renders scenario play steps and records exact hashes", async () => {
    const fixture = makeFixture();
    try {
      const wave = wavBuffer(Buffer.alloc(480), 1);
      const authorizations: Array<string | null> = [];
      const result = await renderFixtureAudio({
        manifestPath: fixture.manifestPath,
        apiKey: "test-key",
        fetcher: async (_url, init) => {
          authorizations.push(new Headers(init.headers).get("authorization"));
          return new Response(wave, {
            status: 200,
            headers: { "content-type": "audio/wav", "x-request-id": "req_test" },
          });
        },
      });

      expect(authorizations).toEqual(["Bearer test-key"]);
      expect(Buffer.compare(readFileSync(fixture.audioPath), wave)).toBe(0);
      expect(result.utterances).toHaveLength(1);
      expect(result.utterances[0]).toMatchObject({
        id: "hello",
        audio: "audio/01-hello.wav",
        bytes: wave.length,
        requestId: "req_test",
      });
      const receipt = JSON.parse(readFileSync(result.receiptPath, "utf8"));
      expect(receipt).toMatchObject({
        provider: "openai",
        model: "gpt-4o-mini-tts",
        voice: "marin",
      });
      expect(receipt.utterances[0].audioSha256).toHaveLength(64);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("reuses a complete fingerprinted fixture without a key or paid request", async () => {
    const fixture = makeFixture();
    try {
      const wave = wavBuffer(Buffer.alloc(480), 1);
      await renderFixtureAudio({
        manifestPath: fixture.manifestPath,
        apiKey: "test-key",
        fetcher: async () => new Response(wave, { status: 200 }),
      });

      let calls = 0;
      const result = await renderFixtureAudio({
        manifestPath: fixture.manifestPath,
        fetcher: async () => {
          calls++;
          return new Response();
        },
      });

      expect(calls).toBe(0);
      expect(result.utterances).toHaveLength(1);
      expect(result.utterances[0]?.audioSha256).toHaveLength(64);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("checkpoints paid successes and resumes after a later request fails", async () => {
    const fixture = makeFixture(2);
    try {
      const firstWave = wavBuffer(Buffer.alloc(480, 1), 1);
      const secondWave = wavBuffer(Buffer.alloc(480, 2), 1);
      let calls = 0;
      await expect(
        renderFixtureAudio({
          manifestPath: fixture.manifestPath,
          apiKey: "test-key",
          fetcher: async () => {
            calls++;
            return calls === 1
              ? new Response(firstWave, { status: 200 })
              : new Response("temporary failure", { status: 503 });
          },
        }),
      ).rejects.toThrow("temporary failure");

      const partialReceipt = JSON.parse(readFileSync(fixture.receiptPath, "utf8"));
      expect(partialReceipt.utterances.map((item: { id: string }) => item.id)).toEqual(["hello"]);
      expect(Buffer.compare(readFileSync(fixture.audioPath), firstWave)).toBe(0);

      calls = 0;
      const result = await renderFixtureAudio({
        manifestPath: fixture.manifestPath,
        apiKey: "test-key",
        fetcher: async () => {
          calls++;
          return new Response(secondWave, { status: 200 });
        },
      });
      expect(calls).toBe(1);
      expect(result.utterances.map((item) => item.id)).toEqual(["hello", "goodbye"]);
      expect(Buffer.compare(readFileSync(fixture.audioPath), firstWave)).toBe(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("replaces only one explicitly named utterance", async () => {
    const fixture = makeFixture(2);
    try {
      const original = wavBuffer(Buffer.alloc(480, 1), 1);
      await renderFixtureAudio({
        manifestPath: fixture.manifestPath,
        apiKey: "test-key",
        fetcher: async () => new Response(original, { status: 200 }),
      });
      const untouched = readFileSync(fixture.secondAudioPath!);
      const replacement = wavBuffer(Buffer.alloc(480, 3), 1);
      let calls = 0;

      await renderFixtureAudio({
        manifestPath: fixture.manifestPath,
        apiKey: "test-key",
        replace: "hello",
        fetcher: async () => {
          calls++;
          return new Response(replacement, { status: 200 });
        },
      });

      expect(calls).toBe(1);
      expect(Buffer.compare(readFileSync(fixture.audioPath), replacement)).toBe(0);
      expect(Buffer.compare(readFileSync(fixture.secondAudioPath!), untouched)).toBe(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("refuses unreceipted audio before making a paid request", async () => {
    const fixture = makeFixture();
    try {
      writeFileSync(fixture.audioPath, "existing");
      let calls = 0;
      await expect(
        renderFixtureAudio({
          manifestPath: fixture.manifestPath,
          apiKey: "test-key",
          fetcher: async () => {
            calls++;
            return new Response();
          },
        }),
      ).rejects.toThrow("exists without valid receipt evidence");
      expect(calls).toBe(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

function makeFixture(count = 1): {
  root: string;
  manifestPath: string;
  receiptPath: string;
  audioPath: string;
  secondAudioPath?: string;
} {
  const root = mkdtempSync(join(tmpdir(), "agentvoice-tts-test-"));
  const audioDirectory = join(root, "audio");
  mkdirSync(audioDirectory);
  const scenarioPath = join(root, "scenario.json");
  const manifestPath = join(audioDirectory, "tts.json");
  const receiptPath = join(audioDirectory, "rendered.json");
  const audioPath = join(audioDirectory, "01-hello.wav");
  const secondAudioPath = join(audioDirectory, "02-goodbye.wav");
  const steps = [
    {
      type: "play",
      id: "hello",
      audio: "audio/01-hello.wav",
      transcript: "Hello there.",
    },
  ];
  if (count === 2) {
    steps.push({
      type: "play",
      id: "goodbye",
      audio: "audio/02-goodbye.wav",
      transcript: "Goodbye now.",
    });
  }
  writeFileSync(
    scenarioPath,
    JSON.stringify({
      schemaVersion: 1,
      id: "tts-test",
      description: "TTS renderer test.",
      workspace: "workspace",
      steps,
    }),
  );
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return {
    root,
    manifestPath,
    receiptPath,
    audioPath,
    ...(count === 2 ? { secondAudioPath } : {}),
  };
}
