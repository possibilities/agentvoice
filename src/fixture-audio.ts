import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { AUDIO_SAMPLE_RATE, normalizeAudioToMonoPcm } from "./audio.ts";
import { type LoadedScenario, stepAudioPath } from "./scenario.ts";
import { OPENAI_SPEECH_ENDPOINT, ttsManifestSchema } from "./tts.ts";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const renderedUtteranceSchema = z
  .object({
    id: z.string().min(1),
    audio: z.string().min(1),
    inputSha256: sha256Schema,
    audioSha256: sha256Schema,
    bytes: z.number().int().positive(),
    requestId: z.string().min(1).nullable(),
  })
  .strict();

export const fixtureAudioReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().min(1),
    sourceManifest: z.string().min(1),
    scenario: z.string().min(1),
    provider: z.literal("openai"),
    endpoint: z.string().min(1),
    model: z.string().min(1),
    voice: z.string().min(1),
    responseFormat: z.literal("wav"),
    instructionsSha256: sha256Schema,
    utterances: z.array(renderedUtteranceSchema).min(1),
  })
  .strict();

export interface FixtureAudioEvidence {
  id: string;
  audio: string;
  transcriptSha256: string;
  source: {
    sha256: string;
    bytes: number;
  };
  normalized: {
    sha256: string;
    bytes: number;
    durationMs: number;
    sampleRate: typeof AUDIO_SAMPLE_RATE;
    channels: 1;
    sampleFormat: "s16le";
  };
}

export interface FixtureAudioProvenance {
  manifest: {
    path: string;
    sha256: string;
  };
  receipt: {
    path: string;
    sha256: string;
    generatedAt: string;
  };
  provider: "openai";
  endpoint: string;
  model: string;
  voice: string;
  responseFormat: "wav";
  instructionsSha256: string;
}

export interface VerifiedFixtureAudio {
  pcmByStepId: Map<string, Buffer>;
  evidence: FixtureAudioEvidence[];
  provenance: FixtureAudioProvenance;
  receiptBytes: Buffer;
}

interface VerifiedSource {
  id: string;
  audio: string;
  path: string;
  transcriptSha256: string;
  sourceBytes: number;
  sourceSha256: string;
}

/**
 * Fails closed on TTS contract or source-audio drift before doing any session
 * work. Call this before starting App-server or opening a realtime session.
 */
export async function loadVerifiedFixtureAudio(
  loaded: LoadedScenario,
  manifestPath = join(loaded.directory, "audio", "tts.json"),
): Promise<VerifiedFixtureAudio> {
  const absoluteManifestPath = resolve(manifestPath);
  const manifestDirectory = dirname(absoluteManifestPath);
  const manifestBytes = await readRequiredFile(absoluteManifestPath, "TTS manifest");
  const manifest = ttsManifestSchema.parse(parseJson(manifestBytes, "TTS manifest"));

  const declaredScenarioPath = resolve(manifestDirectory, manifest.scenario);
  if (declaredScenarioPath !== resolve(loaded.path)) {
    throw new Error(
      `TTS manifest scenario mismatch: expected ${loaded.path}; got ${declaredScenarioPath}`,
    );
  }

  const receiptPath = resolve(manifestDirectory, manifest.receipt);
  assertInside(manifestDirectory, receiptPath, "TTS render receipt");
  const receiptBytes = await readRequiredFile(receiptPath, "TTS render receipt");
  const receipt = fixtureAudioReceiptSchema.parse(parseJson(receiptBytes, "TTS render receipt"));

  assertEqual("receipt source manifest", receipt.sourceManifest, basename(absoluteManifestPath));
  assertEqual("receipt scenario", receipt.scenario, relative(manifestDirectory, loaded.path));
  assertEqual("receipt provider", receipt.provider, manifest.provider);
  assertEqual("receipt endpoint", receipt.endpoint, OPENAI_SPEECH_ENDPOINT);
  assertEqual("receipt model", receipt.model, manifest.model);
  assertEqual("receipt voice", receipt.voice, manifest.voice);
  assertEqual("receipt response format", receipt.responseFormat, manifest.responseFormat);
  assertEqual(
    "receipt instructions SHA-256",
    receipt.instructionsSha256,
    sha256(manifest.instructions),
  );

  const steps = loaded.scenario.steps.filter((step) => step.type === "play");
  if (steps.length === 0) throw new Error(`scenario has no play steps: ${loaded.path}`);
  if (receipt.utterances.length !== steps.length) {
    throw new Error(
      `TTS receipt utterance count mismatch: expected ${steps.length}; ` +
        `got ${receipt.utterances.length}`,
    );
  }

  // Validate the complete source set before invoking ffmpeg. This keeps all
  // fixture drift on the pre-session, fail-closed side of the runner boundary.
  const verifiedSources: VerifiedSource[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!;
    const rendered = receipt.utterances[index]!;
    if (seenIds.has(step.id)) throw new Error(`duplicate play step id: ${step.id}`);
    seenIds.add(step.id);

    assertEqual(`receipt utterance ${index + 1} id`, rendered.id, step.id);
    const path = stepAudioPath(loaded, step);
    assertInside(manifestDirectory, path, `audio target for ${step.id}`);
    if (seenPaths.has(path)) throw new Error(`duplicate fixture audio target: ${path}`);
    seenPaths.add(path);

    const audio = relative(loaded.directory, path);
    assertEqual(`receipt audio path for ${step.id}`, rendered.audio, audio);
    const transcriptSha256 = sha256(step.transcript);
    assertEqual(`receipt input SHA-256 for ${step.id}`, rendered.inputSha256, transcriptSha256);

    const source = await readRequiredFile(path, `fixture audio for ${step.id}`);
    if (source.length !== rendered.bytes) {
      throw new Error(
        `fixture audio byte count mismatch for ${step.id}: ` +
          `expected ${rendered.bytes}; got ${source.length}`,
      );
    }
    const sourceSha256 = sha256(source);
    assertEqual(`fixture audio SHA-256 for ${step.id}`, sourceSha256, rendered.audioSha256);
    verifiedSources.push({
      id: step.id,
      audio,
      path,
      transcriptSha256,
      sourceBytes: source.length,
      sourceSha256,
    });
  }

  const pcmByStepId = new Map<string, Buffer>();
  const evidence: FixtureAudioEvidence[] = [];
  for (const source of verifiedSources) {
    const pcm = await normalizeAudioToMonoPcm(source.path);
    const normalizedSha256 = sha256(pcm);
    pcmByStepId.set(source.id, pcm);
    evidence.push({
      id: source.id,
      audio: source.audio,
      transcriptSha256: source.transcriptSha256,
      source: {
        sha256: source.sourceSha256,
        bytes: source.sourceBytes,
      },
      normalized: {
        sha256: normalizedSha256,
        bytes: pcm.length,
        durationMs: (pcm.length / 2 / AUDIO_SAMPLE_RATE) * 1_000,
        sampleRate: AUDIO_SAMPLE_RATE,
        channels: 1,
        sampleFormat: "s16le",
      },
    });
  }

  return {
    pcmByStepId,
    evidence,
    receiptBytes,
    provenance: {
      manifest: {
        path: relative(loaded.directory, absoluteManifestPath),
        sha256: sha256(manifestBytes),
      },
      receipt: {
        path: relative(loaded.directory, receiptPath),
        sha256: sha256(receiptBytes),
        generatedAt: receipt.generatedAt,
      },
      provider: receipt.provider,
      endpoint: receipt.endpoint,
      model: receipt.model,
      voice: receipt.voice,
      responseFormat: receipt.responseFormat,
      instructionsSha256: receipt.instructionsSha256,
    },
  };
}

async function readRequiredFile(path: string, label: string): Promise<Buffer> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`${label} does not exist: ${path}`);
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length === 0) throw new Error(`${label} is empty: ${path}`);
  return bytes;
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${message(error)}`);
  }
}

function assertInside(directory: string, path: string, label: string): void {
  const rel = relative(directory, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} must be inside ${directory}: ${path}`);
  }
}

function assertEqual(label: string, actual: string, expected: string): void {
  if (actual !== expected)
    throw new Error(`${label} mismatch: expected ${expected}; got ${actual}`);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
