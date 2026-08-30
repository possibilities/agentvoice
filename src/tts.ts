import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { loadScenario, stepAudioPath } from "./scenario.ts";

export const OPENAI_SPEECH_ENDPOINT = "https://api.openai.com/v1/audio/speech";

export const ttsManifestSchema = z.object({
  schemaVersion: z.literal(1),
  provider: z.literal("openai"),
  scenario: z.string().min(1),
  model: z.string().min(1),
  voice: z.string().min(1),
  responseFormat: z.literal("wav"),
  instructions: z.string().min(1),
  receipt: z.string().min(1).default("rendered.json"),
});

export type TtsManifest = z.infer<typeof ttsManifestSchema>;

export interface RenderProgress {
  id: string;
  index: number;
  total: number;
  phase: "reused" | "requesting" | "received";
}

export interface RenderedUtterance {
  id: string;
  audio: string;
  inputSha256: string;
  audioSha256: string;
  bytes: number;
  requestId: string | null;
}

export interface RenderFixtureResult {
  receiptPath: string;
  utterances: RenderedUtterance[];
}

export type SpeechFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface RenderFixtureOptions {
  manifestPath: string;
  apiKey?: string;
  /** Intentionally purchase and replace exactly one utterance. */
  replace?: string;
  fetcher?: SpeechFetch;
  onProgress?(progress: RenderProgress): void;
}

interface RenderReceipt {
  schemaVersion: 1;
  generatedAt: string;
  sourceManifest: string;
  scenario: string;
  provider: "openai";
  endpoint: string;
  model: string;
  voice: string;
  responseFormat: "wav";
  instructionsSha256: string;
  utterances: RenderedUtterance[];
}

export async function renderFixtureAudio(
  options: RenderFixtureOptions,
): Promise<RenderFixtureResult> {
  const manifestPath = resolve(options.manifestPath);
  const manifestDirectory = dirname(manifestPath);
  const manifest = ttsManifestSchema.parse(await Bun.file(manifestPath).json());
  const loaded = await loadScenario(resolve(manifestDirectory, manifest.scenario));
  const steps = loaded.scenario.steps.filter((step) => step.type === "play");
  if (steps.length === 0) throw new Error(`scenario has no play steps: ${loaded.path}`);

  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  const targets = steps.map((step) => {
    if (seenIds.has(step.id)) throw new Error(`duplicate play step id: ${step.id}`);
    seenIds.add(step.id);
    const path = stepAudioPath(loaded, step);
    assertInside(manifestDirectory, path, `audio target for ${step.id}`);
    if (!path.toLowerCase().endsWith(".wav")) {
      throw new Error(`OpenAI WAV fixture target must end in .wav: ${path}`);
    }
    if (seenPaths.has(path)) throw new Error(`duplicate fixture audio target: ${path}`);
    seenPaths.add(path);
    return { step, path };
  });

  const receiptPath = resolve(manifestDirectory, manifest.receipt);
  assertInside(manifestDirectory, receiptPath, "render receipt");

  if (options.replace && !targets.some(({ step }) => step.id === options.replace)) {
    throw new Error(`unknown fixture utterance for --replace: ${options.replace}`);
  }

  const receipt = existsSync(receiptPath)
    ? parseReceipt(readFileSync(receiptPath, "utf8"), receiptPath)
    : null;
  const expectedReceipt = receiptMetadata(manifestPath, manifestDirectory, loaded.path, manifest);
  if (receipt) assertReceiptMetadata(receipt, expectedReceipt, receiptPath);

  const evidenceById = new Map<string, RenderedUtterance>();
  if (receipt) {
    let previousTargetIndex = -1;
    for (const evidence of receipt.utterances) {
      if (evidenceById.has(evidence.id)) {
        throw new Error(`duplicate utterance ${evidence.id} in render receipt: ${receiptPath}`);
      }
      const targetIndex = targets.findIndex(({ step }) => step.id === evidence.id);
      if (targetIndex < 0) {
        throw new Error(`unknown utterance ${evidence.id} in render receipt: ${receiptPath}`);
      }
      if (targetIndex <= previousTargetIndex) {
        throw new Error(`render receipt utterances are not in scenario order: ${receiptPath}`);
      }
      previousTargetIndex = targetIndex;
      const { step, path } = targets[targetIndex]!;
      assertEvidenceFingerprint(
        evidence,
        step.id,
        relative(loaded.directory, path),
        step.transcript,
      );
      evidenceById.set(evidence.id, evidence);
    }
  }

  // Validate every reusable output before making any paid request. An
  // unreceipted or drifted file is never silently trusted or overwritten.
  for (const { step, path } of targets) {
    if (step.id === options.replace) continue;
    const evidence = evidenceById.get(step.id);
    if (!evidence) {
      if (existsSync(path)) {
        throw new Error(
          `fixture audio for ${step.id} exists without valid receipt evidence. ` +
            `Pass --replace ${step.id} to intentionally purchase and replace only that utterance.`,
        );
      }
      continue;
    }
    assertReusableAudio(path, evidence);
  }

  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const generatedAt = options.replace || !receipt ? new Date().toISOString() : receipt.generatedAt;
  for (let index = 0; index < targets.length; index++) {
    const { step, path } = targets[index]!;
    if (step.id !== options.replace && evidenceById.has(step.id)) {
      options.onProgress?.({ id: step.id, index, total: targets.length, phase: "reused" });
      continue;
    }
    if (!options.apiKey) {
      throw new Error(
        `OPENAI_API_KEY is required to render fixture utterance ${step.id}; ` +
          "validated existing utterances were left unchanged",
      );
    }
    options.onProgress?.({ id: step.id, index, total: targets.length, phase: "requesting" });
    const response = await fetcher(OPENAI_SPEECH_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildOpenAiSpeechRequest(manifest, step.transcript)),
    });
    if (!response.ok) {
      const detail = (await response.text()).trim().slice(0, 2_000);
      throw new Error(
        `OpenAI TTS request for ${step.id} failed (${response.status} ${response.statusText})` +
          `${detail ? `: ${detail}` : ""}`,
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    assertWave(bytes, step.id);
    const evidence: RenderedUtterance = {
      id: step.id,
      audio: relative(loaded.directory, path),
      inputSha256: sha256(step.transcript),
      audioSha256: sha256(bytes),
      bytes: bytes.length,
      requestId: response.headers.get("x-request-id"),
    };
    atomicWrite(path, bytes);
    evidenceById.set(step.id, evidence);
    atomicWrite(
      receiptPath,
      `${JSON.stringify(
        {
          ...expectedReceipt,
          generatedAt,
          utterances: targets.flatMap(({ step: targetStep }) => {
            const completed = evidenceById.get(targetStep.id);
            return completed ? [completed] : [];
          }),
        } satisfies RenderReceipt,
        null,
        2,
      )}\n`,
    );
    options.onProgress?.({ id: step.id, index, total: targets.length, phase: "received" });
  }

  const utterances = targets.map(({ step }) => evidenceById.get(step.id)!);
  if (utterances.some((evidence) => !evidence)) {
    throw new Error("render finished without evidence for every fixture utterance");
  }
  return { receiptPath, utterances };
}

export function buildOpenAiSpeechRequest(
  manifest: TtsManifest,
  input: string,
): Record<string, string> {
  return {
    model: manifest.model,
    voice: manifest.voice,
    input,
    instructions: manifest.instructions,
    response_format: manifest.responseFormat,
  };
}

function assertWave(bytes: Buffer, id: string): void {
  if (
    bytes.length < 44 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error(`OpenAI TTS response for ${id} was not a WAV file`);
  }
}

function receiptMetadata(
  manifestPath: string,
  manifestDirectory: string,
  scenarioPath: string,
  manifest: TtsManifest,
): Omit<RenderReceipt, "generatedAt" | "utterances"> {
  return {
    schemaVersion: 1,
    sourceManifest: basename(manifestPath),
    scenario: relative(manifestDirectory, scenarioPath),
    provider: manifest.provider,
    endpoint: OPENAI_SPEECH_ENDPOINT,
    model: manifest.model,
    voice: manifest.voice,
    responseFormat: manifest.responseFormat,
    instructionsSha256: sha256(manifest.instructions),
  };
}

function parseReceipt(text: string, path: string): RenderReceipt {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`render receipt is not valid JSON: ${path}: ${message(error)}`);
  }
  const schema = z
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
      instructionsSha256: z.string().regex(/^[0-9a-f]{64}$/),
      utterances: z.array(
        z.object({
          id: z.string().min(1),
          audio: z.string().min(1),
          inputSha256: z.string().regex(/^[0-9a-f]{64}$/),
          audioSha256: z.string().regex(/^[0-9a-f]{64}$/),
          bytes: z.number().int().positive(),
          requestId: z.string().min(1).nullable(),
        }),
      ),
    })
    .strict();
  try {
    return schema.parse(value);
  } catch (error) {
    throw new Error(`render receipt is invalid: ${path}: ${message(error)}`);
  }
}

function assertReceiptMetadata(
  actual: RenderReceipt,
  expected: Omit<RenderReceipt, "generatedAt" | "utterances">,
  path: string,
): void {
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (actual[key as keyof RenderReceipt] !== expectedValue) {
      throw new Error(`render receipt ${key} does not match the current request: ${path}`);
    }
  }
}

function assertEvidenceFingerprint(
  evidence: RenderedUtterance,
  id: string,
  audio: string,
  transcript: string,
): void {
  if (
    evidence.id !== id ||
    evidence.audio !== audio ||
    evidence.inputSha256 !== sha256(transcript)
  ) {
    throw new Error(`render receipt fingerprint does not match scenario utterance ${id}`);
  }
}

function assertReusableAudio(path: string, evidence: RenderedUtterance): void {
  if (!existsSync(path)) {
    throw new Error(
      `receipted fixture audio for ${evidence.id} is missing. ` +
        `Pass --replace ${evidence.id} to intentionally purchase its replacement.`,
    );
  }
  const bytes = readFileSync(path);
  if (bytes.length !== evidence.bytes || sha256(bytes) !== evidence.audioSha256) {
    throw new Error(
      `receipted fixture audio for ${evidence.id} has drifted. ` +
        `Pass --replace ${evidence.id} to intentionally purchase its replacement.`,
    );
  }
  assertWave(bytes, evidence.id);
}

function atomicWrite(path: string, bytes: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function assertInside(directory: string, path: string, label: string): void {
  const rel = relative(directory, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} must be inside ${directory}: ${path}`);
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
