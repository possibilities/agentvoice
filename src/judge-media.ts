import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { analyzePcm16Wav } from "./audio-analysis.ts";
import type { CandidateAudioOverrides } from "./pairwise-audio-judge.ts";

export const JUDGE_MEDIA_PROFILE_VERSION = "dual-full-length-mp3-v1" as const;
export const JUDGE_MEDIA_MANIFEST_NAME = "media-manifest.json" as const;

const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;
const SHA256 = /^[a-f0-9]{64}$/;

const artifactManifestSchema = z
  .object({
    evidence: z
      .object({
        outputAudio: z.string().min(1),
        comparisonAudio: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();

const mediaFormatSchema = z
  .object({
    codec: z.string().min(1),
    sampleRate: z.number().int().positive(),
    channels: z.number().int().positive(),
    durationMs: z.number().positive(),
    bitRate: z.number().int().positive().nullable(),
  })
  .strict();

const sourceTrackSchema = z
  .object({
    file: z.string().min(1),
    sha256: z.string().regex(SHA256),
    byteLength: z.number().int().positive(),
    format: mediaFormatSchema,
  })
  .strict();

const listeningTrackSchema = z
  .object({
    file: z.string().min(1),
    sha256: z.string().regex(SHA256),
    byteLength: z.number().int().positive(),
    format: mediaFormatSchema,
  })
  .strict();

const subjectMediaSchema = z
  .object({
    subjectId: z.enum(["subject-1", "subject-2"]),
    artifactId: z.string().min(1),
    artifactManifestSha256: z.string().regex(SHA256),
    tracks: z
      .object({
        isolatedOutput: z
          .object({
            layout: z.literal("agent-mono"),
            source: sourceTrackSchema,
            listening: listeningTrackSchema,
          })
          .strict(),
        conversation: z
          .object({
            layout: z.literal("evaluator-left-agent-right"),
            source: sourceTrackSchema,
            listening: listeningTrackSchema,
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const transcodeProfileSchema = z
  .object({
    codec: z.literal("libmp3lame"),
    container: z.literal("mp3"),
    sampleRate: z.literal(48_000),
    channels: z.union([z.literal(1), z.literal(2)]),
    constantBitRateKbps: z.union([z.literal(96), z.literal(128)]),
    ffmpegArguments: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const judgeMediaManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("voice-agent-pairwise-judge-media"),
    profileVersion: z.literal(JUDGE_MEDIA_PROFILE_VERSION),
    tools: z
      .object({
        ffmpegVersion: z.string().min(1),
        ffprobeVersion: z.string().min(1),
      })
      .strict(),
    profiles: z
      .object({
        isolatedOutput: transcodeProfileSchema,
        conversation: transcodeProfileSchema,
      })
      .strict(),
    subjects: z.tuple([subjectMediaSchema, subjectMediaSchema]),
  })
  .strict();

export type JudgeMediaManifest = z.infer<typeof judgeMediaManifestSchema>;

export interface PreparedJudgeMedia {
  directory: string;
  manifestPath: string;
  manifestSha256: string;
  manifest: JudgeMediaManifest;
  audioOverrides: readonly [CandidateAudioOverrides, CandidateAudioOverrides];
}

export interface PrepareJudgeMediaOptions {
  artifactDirectories: readonly [string, string];
  outputDirectory?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
}

interface ArtifactSources {
  artifactDirectory: string;
  artifactId: string;
  artifactManifestSha256: string;
  isolatedOutput: LoadedSourceTrack;
  conversation: LoadedSourceTrack;
}

interface LoadedSourceTrack {
  path: string;
  declaredFile: string;
  bytes: Buffer;
  sha256: string;
  format: z.infer<typeof mediaFormatSchema>;
}

const TRANSCODE_PROFILES = {
  isolatedOutput: {
    codec: "libmp3lame",
    container: "mp3",
    sampleRate: 48_000,
    channels: 1,
    constantBitRateKbps: 96,
    ffmpegArguments: [
      "-map_metadata",
      "-1",
      "-vn",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "96k",
      "-ar",
      "48000",
      "-ac",
      "1",
      "-write_xing",
      "0",
    ],
  },
  conversation: {
    codec: "libmp3lame",
    container: "mp3",
    sampleRate: 48_000,
    channels: 2,
    constantBitRateKbps: 128,
    ffmpegArguments: [
      "-map_metadata",
      "-1",
      "-vn",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "128k",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-write_xing",
      "0",
    ],
  },
} as const;

export function defaultJudgeMediaDirectory(
  firstArtifactDirectory: string,
  secondArtifactDirectory: string,
): string {
  const first = resolve(firstArtifactDirectory);
  const names = [basename(first), basename(resolve(secondArtifactDirectory))].sort();
  return join(dirname(first), "judgments", "media", `${names[0]}--vs--${names[1]}`);
}

/**
 * Creates a write-once, full-length listening bundle. An existing bundle is reused only after its
 * canonical tool/profile contract, source receipts, listening receipts, and reproduced transcodes
 * are revalidated against the requested artifacts.
 */
export function prepareJudgeMedia(options: PrepareJudgeMediaOptions): PreparedJudgeMedia {
  const artifactDirectories = options.artifactDirectories.map((path) =>
    realpathSync(resolve(path)),
  ) as [string, string];
  const outputDirectory = resolve(
    options.outputDirectory ??
      defaultJudgeMediaDirectory(artifactDirectories[0], artifactDirectories[1]),
  );
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const ffprobePath = options.ffprobePath ?? "ffprobe";
  if (existsSync(outputDirectory)) {
    return loadPreparedJudgeMedia(outputDirectory, artifactDirectories, ffprobePath, ffmpegPath);
  }

  const sources = artifactDirectories.map(loadArtifactSources) as [
    ArtifactSources,
    ArtifactSources,
  ];
  const parent = dirname(outputDirectory);
  mkdirSync(parent, { recursive: true });
  const temporaryDirectory = mkdtempSync(join(parent, ".pairwise-media-"));
  try {
    const subjects = sources.map((source, index) =>
      transcodeSubject(
        source,
        index === 0 ? "subject-1" : "subject-2",
        temporaryDirectory,
        ffmpegPath,
        ffprobePath,
      ),
    ) as JudgeMediaManifest["subjects"];
    const manifest = judgeMediaManifestSchema.parse({
      schemaVersion: 1,
      kind: "voice-agent-pairwise-judge-media",
      profileVersion: JUDGE_MEDIA_PROFILE_VERSION,
      tools: {
        ffmpegVersion: toolVersion(ffmpegPath),
        ffprobeVersion: toolVersion(ffprobePath),
      },
      profiles: TRANSCODE_PROFILES,
      subjects,
    });
    writeFileSync(
      join(temporaryDirectory, JUDGE_MEDIA_MANIFEST_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    renameSync(temporaryDirectory, outputDirectory);
  } catch (error) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
  return loadPreparedJudgeMedia(outputDirectory, artifactDirectories, ffprobePath, ffmpegPath);
}

export function loadPreparedJudgeMedia(
  directory: string,
  artifactDirectories: readonly [string, string],
  ffprobePath = "ffprobe",
  ffmpegPath = "ffmpeg",
): PreparedJudgeMedia {
  const root = realpathSync(resolve(directory));
  const manifestPath = realpathSync(join(root, JUDGE_MEDIA_MANIFEST_NAME));
  assertWithin(root, manifestPath, "judge media manifest");
  const manifestBytes = readBoundedFile(manifestPath, MAX_MANIFEST_BYTES, "judge media manifest");
  const manifest = judgeMediaManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  validateCanonicalProfiles(manifest.profiles);
  validateToolProvenance(manifest.tools, ffmpegPath, ffprobePath);
  if (
    manifest.subjects[0].subjectId !== "subject-1" ||
    manifest.subjects[1].subjectId !== "subject-2"
  ) {
    throw new Error("judge media subjects must be ordered subject-1, subject-2");
  }
  const sources = artifactDirectories.map((path) =>
    loadArtifactSources(realpathSync(resolve(path))),
  ) as [ArtifactSources, ArtifactSources];
  const verificationDirectory = mkdtempSync(join(tmpdir(), "agentvoice-judge-media-verify-"));
  try {
    const overrides = manifest.subjects.map((subject, index) => {
      const source = sources[index]!;
      validateManifestSubject(
        subject,
        source,
        root,
        verificationDirectory,
        ffmpegPath,
        ffprobePath,
      );
      return {
        isolatedOutput: listeningOverride(root, subject.tracks.isolatedOutput.listening),
        conversation: listeningOverride(root, subject.tracks.conversation.listening),
      };
    }) as [CandidateAudioOverrides, CandidateAudioOverrides];
    return {
      directory: root,
      manifestPath,
      manifestSha256: sha256(manifestBytes),
      manifest,
      audioOverrides: overrides,
    };
  } finally {
    rmSync(verificationDirectory, { recursive: true, force: true });
  }
}

function loadArtifactSources(artifactDirectory: string): ArtifactSources {
  const manifestPath = realpathSync(join(artifactDirectory, "manifest.json"));
  assertWithin(artifactDirectory, manifestPath, "artifact manifest");
  const manifestBytes = readBoundedFile(manifestPath, MAX_MANIFEST_BYTES, "artifact manifest");
  const manifest = artifactManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  return {
    artifactDirectory,
    artifactId: basename(artifactDirectory),
    artifactManifestSha256: sha256(manifestBytes),
    isolatedOutput: loadSourceTrack(
      artifactDirectory,
      manifest.evidence.outputAudio,
      "isolated output",
      1,
    ),
    conversation: loadSourceTrack(
      artifactDirectory,
      manifest.evidence.comparisonAudio,
      "conversation",
      2,
    ),
  };
}

function loadSourceTrack(
  artifactDirectory: string,
  declaredFile: string,
  label: string,
  expectedChannels: 1 | 2,
): LoadedSourceTrack {
  const path = realpathSync(resolve(artifactDirectory, declaredFile));
  assertWithin(artifactDirectory, path, `${label} source`);
  const bytes = readBoundedFile(path, MAX_AUDIO_BYTES, `${label} source`);
  const analysis = analyzePcm16Wav(bytes);
  if (analysis.format.channels !== expectedChannels) {
    throw new Error(`${label} source must have ${expectedChannels} channel(s)`);
  }
  if (analysis.format.sampleRate !== 48_000) {
    throw new Error(`${label} source must use 48000 Hz PCM`);
  }
  return {
    path,
    declaredFile,
    bytes,
    sha256: analysis.sha256,
    format: {
      codec: analysis.format.codec,
      sampleRate: analysis.format.sampleRate,
      channels: analysis.format.channels,
      durationMs: analysis.format.durationMs,
      bitRate:
        analysis.format.sampleRate * analysis.format.channels * analysis.format.bitsPerSample,
    },
  };
}

function transcodeSubject(
  source: ArtifactSources,
  subjectId: "subject-1" | "subject-2",
  outputDirectory: string,
  ffmpegPath: string,
  ffprobePath: string,
): JudgeMediaManifest["subjects"][number] {
  const isolatedFile = `${subjectId}-isolated-output.mp3`;
  const conversationFile = `${subjectId}-conversation.mp3`;
  const isolatedPath = join(outputDirectory, isolatedFile);
  const conversationPath = join(outputDirectory, conversationFile);
  transcode(
    ffmpegPath,
    source.isolatedOutput.path,
    isolatedPath,
    TRANSCODE_PROFILES.isolatedOutput,
  );
  transcode(
    ffmpegPath,
    source.conversation.path,
    conversationPath,
    TRANSCODE_PROFILES.conversation,
  );
  return subjectMediaSchema.parse({
    subjectId,
    artifactId: source.artifactId,
    artifactManifestSha256: source.artifactManifestSha256,
    tracks: {
      isolatedOutput: {
        layout: "agent-mono",
        source: sourceTrackReceipt(source.isolatedOutput),
        listening: listeningTrackReceipt(isolatedFile, isolatedPath, ffprobePath),
      },
      conversation: {
        layout: "evaluator-left-agent-right",
        source: sourceTrackReceipt(source.conversation),
        listening: listeningTrackReceipt(conversationFile, conversationPath, ffprobePath),
      },
    },
  });
}

function transcode(
  ffmpegPath: string,
  sourcePath: string,
  destinationPath: string,
  profile: (typeof TRANSCODE_PROFILES)[keyof typeof TRANSCODE_PROFILES],
): void {
  run(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-n",
    "-i",
    sourcePath,
    ...profile.ffmpegArguments,
    destinationPath,
  ]);
}

function sourceTrackReceipt(source: LoadedSourceTrack): z.infer<typeof sourceTrackSchema> {
  return {
    file: source.declaredFile,
    sha256: source.sha256,
    byteLength: source.bytes.byteLength,
    format: source.format,
  };
}

function listeningTrackReceipt(
  file: string,
  path: string,
  ffprobePath: string,
): z.infer<typeof listeningTrackSchema> {
  const bytes = readBoundedFile(path, MAX_AUDIO_BYTES, "listening copy");
  validateMp3(bytes);
  return listeningTrackSchema.parse({
    file,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    format: probeAudio(ffprobePath, path),
  });
}

function validateManifestSubject(
  subject: JudgeMediaManifest["subjects"][number],
  source: ArtifactSources,
  mediaRoot: string,
  verificationDirectory: string,
  ffmpegPath: string,
  ffprobePath: string,
): void {
  if (
    subject.artifactId !== source.artifactId ||
    subject.artifactManifestSha256 !== source.artifactManifestSha256
  ) {
    throw new Error(`judge media subject ${subject.subjectId} does not match ${source.artifactId}`);
  }
  validateSourceReceipt(subject.tracks.isolatedOutput.source, source.isolatedOutput);
  validateSourceReceipt(subject.tracks.conversation.source, source.conversation);
  validateListeningReceipt(
    mediaRoot,
    subject.tracks.isolatedOutput.listening,
    ffprobePath,
    TRANSCODE_PROFILES.isolatedOutput,
    "isolated output",
  );
  validateListeningReceipt(
    mediaRoot,
    subject.tracks.conversation.listening,
    ffprobePath,
    TRANSCODE_PROFILES.conversation,
    "conversation",
  );
  validateCanonicalTranscode(
    mediaRoot,
    subject.tracks.isolatedOutput.listening,
    source.isolatedOutput.path,
    join(verificationDirectory, `${subject.subjectId}-isolated-output.mp3`),
    ffmpegPath,
    TRANSCODE_PROFILES.isolatedOutput,
  );
  validateCanonicalTranscode(
    mediaRoot,
    subject.tracks.conversation.listening,
    source.conversation.path,
    join(verificationDirectory, `${subject.subjectId}-conversation.mp3`),
    ffmpegPath,
    TRANSCODE_PROFILES.conversation,
  );
}

function validateSourceReceipt(
  receipt: z.infer<typeof sourceTrackSchema>,
  source: LoadedSourceTrack,
): void {
  const expected = sourceTrackReceipt(source);
  if (JSON.stringify(receipt) !== JSON.stringify(expected)) {
    throw new Error(`judge media source receipt is stale for ${source.declaredFile}`);
  }
}

function validateListeningReceipt(
  mediaRoot: string,
  receipt: z.infer<typeof listeningTrackSchema>,
  ffprobePath: string,
  profile: TranscodeProfile,
  label: string,
): void {
  const path = realpathSync(resolve(mediaRoot, receipt.file));
  assertWithin(mediaRoot, path, "listening copy");
  const expected = listeningTrackReceipt(receipt.file, path, ffprobePath);
  if (JSON.stringify(receipt) !== JSON.stringify(expected)) {
    throw new Error(`judge media listening copy failed receipt validation: ${receipt.file}`);
  }
  validateListeningFormat(expected.format, profile, label);
}

function validateCanonicalProfiles(profiles: JudgeMediaManifest["profiles"]): void {
  if (!isDeepStrictEqual(profiles, TRANSCODE_PROFILES)) {
    throw new Error(
      `judge media profiles do not match canonical ${JUDGE_MEDIA_PROFILE_VERSION} settings`,
    );
  }
}

function validateToolProvenance(
  tools: JudgeMediaManifest["tools"],
  ffmpegPath: string,
  ffprobePath: string,
): void {
  const expected = {
    ffmpegVersion: toolVersion(ffmpegPath),
    ffprobeVersion: toolVersion(ffprobePath),
  };
  if (!isDeepStrictEqual(tools, expected)) {
    throw new Error("judge media tool provenance does not match the active ffmpeg and ffprobe");
  }
}

type TranscodeProfile = (typeof TRANSCODE_PROFILES)[keyof typeof TRANSCODE_PROFILES];

function validateListeningFormat(
  format: z.infer<typeof mediaFormatSchema>,
  profile: TranscodeProfile,
  label: string,
): void {
  const expectedBitRate = profile.constantBitRateKbps * 1_000;
  if (
    format.codec !== "mp3" ||
    format.sampleRate !== profile.sampleRate ||
    format.channels !== profile.channels ||
    format.bitRate !== expectedBitRate
  ) {
    throw new Error(
      `judge media ${label} listening format does not match canonical profile: ` +
        `expected mp3/${profile.sampleRate}Hz/${profile.channels}ch/${expectedBitRate}bps`,
    );
  }
}

function validateCanonicalTranscode(
  mediaRoot: string,
  receipt: z.infer<typeof listeningTrackSchema>,
  sourcePath: string,
  verificationPath: string,
  ffmpegPath: string,
  profile: TranscodeProfile,
): void {
  transcode(ffmpegPath, sourcePath, verificationPath, profile);
  const actualPath = realpathSync(resolve(mediaRoot, receipt.file));
  assertWithin(mediaRoot, actualPath, "listening copy");
  const actualBytes = readBoundedFile(actualPath, MAX_AUDIO_BYTES, "listening copy");
  const expectedBytes = readBoundedFile(
    verificationPath,
    MAX_AUDIO_BYTES,
    "reproduced listening copy",
  );
  if (!actualBytes.equals(expectedBytes)) {
    throw new Error(
      `judge media listening copy is not the canonical transcode of its bound source: ${receipt.file}`,
    );
  }
}

function listeningOverride(
  mediaRoot: string,
  receipt: z.infer<typeof listeningTrackSchema>,
): { path: string; durationMs: number } {
  const path = realpathSync(resolve(mediaRoot, receipt.file));
  assertWithin(mediaRoot, path, "listening copy");
  return { path, durationMs: receipt.format.durationMs };
}

function probeAudio(ffprobePath: string, path: string): z.infer<typeof mediaFormatSchema> {
  const output = run(ffprobePath, [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "format=duration:stream=codec_name,sample_rate,channels,bit_rate",
    "-of",
    "json",
    path,
  ]);
  const parsed = z
    .object({
      streams: z
        .array(
          z
            .object({
              codec_name: z.string().min(1),
              sample_rate: z.string().regex(/^\d+$/),
              channels: z.number().int().positive(),
              bit_rate: z.string().regex(/^\d+$/).optional(),
            })
            .passthrough(),
        )
        .length(1),
      format: z.object({ duration: z.string().min(1) }).passthrough(),
    })
    .passthrough()
    .parse(JSON.parse(output));
  const stream = parsed.streams[0]!;
  return mediaFormatSchema.parse({
    codec: stream.codec_name,
    sampleRate: Number(stream.sample_rate),
    channels: stream.channels,
    durationMs: Number(parsed.format.duration) * 1_000,
    bitRate: stream.bit_rate === undefined ? null : Number(stream.bit_rate),
  });
}

function toolVersion(path: string): string {
  const firstLine = run(path, ["-version"]).split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) throw new Error(`${path} returned an empty version`);
  return firstLine;
}

function run(command: string, args: readonly string[]): string {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error(`could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status ?? "signal"}): ${String(result.stderr).trim() || "no diagnostic"}`,
    );
  }
  return String(result.stdout);
}

function readBoundedFile(path: string, maximum: number, label: string): Buffer {
  const size = statSync(path).size;
  if (size < 1) throw new Error(`${label} is empty: ${path}`);
  if (size > maximum) throw new Error(`${label} exceeds ${maximum} bytes: ${path}`);
  return readFileSync(path);
}

function validateMp3(bytes: Buffer): void {
  const hasId3 = bytes.subarray(0, 3).toString("ascii") === "ID3";
  const hasFrameSync = bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
  if (!hasId3 && !hasFrameSync) throw new Error("listening copy is not an MP3 bitstream");
}

function assertWithin(root: string, candidate: string, label: string): void {
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} escapes ${root}`);
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
