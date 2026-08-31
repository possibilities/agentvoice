import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wavBuffer } from "../src/audio.ts";
import {
  JUDGE_MEDIA_PROFILE_VERSION,
  loadPreparedJudgeMedia,
  prepareJudgeMedia,
} from "../src/judge-media.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("pairwise judge media", () => {
  test("creates and revalidates deterministic full-length dual-track MP3 copies", () => {
    const root = temporaryDirectory();
    const first = makeArtifact(root, "artifact-one", 3_000);
    const second = makeArtifact(root, "artifact-two", 5_000);
    const firstOutput = join(root, "media-one");
    const secondOutput = join(root, "media-two");

    const prepared = prepareJudgeMedia({
      artifactDirectories: [first, second],
      outputDirectory: firstOutput,
    });
    expect(prepared.manifest.profileVersion).toBe(JUDGE_MEDIA_PROFILE_VERSION);
    expect(prepared.manifest.subjects.map((subject) => subject.subjectId)).toEqual([
      "subject-1",
      "subject-2",
    ]);
    expect(prepared.manifest.subjects[0]!.tracks.isolatedOutput).toMatchObject({
      layout: "agent-mono",
      source: { format: { codec: "pcm_s16le", channels: 1, sampleRate: 48_000 } },
      listening: { format: { codec: "mp3", channels: 1, sampleRate: 48_000 } },
    });
    expect(prepared.manifest.subjects[0]!.tracks.conversation).toMatchObject({
      layout: "evaluator-left-agent-right",
      source: { format: { codec: "pcm_s16le", channels: 2, sampleRate: 48_000 } },
      listening: { format: { codec: "mp3", channels: 2, sampleRate: 48_000 } },
    });
    expect(prepared.audioOverrides[0].isolatedOutput?.path).toEndWith(
      "subject-1-isolated-output.mp3",
    );
    expect(prepared.audioOverrides[1].conversation?.path).toEndWith("subject-2-conversation.mp3");

    const reused = prepareJudgeMedia({
      artifactDirectories: [first, second],
      outputDirectory: firstOutput,
    });
    expect(reused.manifestSha256).toBe(prepared.manifestSha256);

    const duplicate = prepareJudgeMedia({
      artifactDirectories: [first, second],
      outputDirectory: secondOutput,
    });
    for (let subject = 0; subject < 2; subject++) {
      expect(duplicate.manifest.subjects[subject]!.tracks.isolatedOutput.listening.sha256).toBe(
        prepared.manifest.subjects[subject]!.tracks.isolatedOutput.listening.sha256,
      );
      expect(duplicate.manifest.subjects[subject]!.tracks.conversation.listening.sha256).toBe(
        prepared.manifest.subjects[subject]!.tracks.conversation.listening.sha256,
      );
    }
  });

  test("rejects a modified listening copy instead of silently reusing it", () => {
    const root = temporaryDirectory();
    const first = makeArtifact(root, "artifact-one", 3_000);
    const second = makeArtifact(root, "artifact-two", 5_000);
    const output = join(root, "media");
    const prepared = prepareJudgeMedia({
      artifactDirectories: [first, second],
      outputDirectory: output,
    });
    writeFileSync(prepared.audioOverrides[0].isolatedOutput!.path, Buffer.from("ID3tampered"));

    expect(() => loadPreparedJudgeMedia(output, [first, second])).toThrow(
      /failed receipt validation|ffprobe failed/,
    );
  });

  test("rejects noncanonical profiles and forged tool provenance", () => {
    const root = temporaryDirectory();
    const first = makeArtifact(root, "artifact-one", 3_000);
    const second = makeArtifact(root, "artifact-two", 5_000);
    const output = join(root, "media");
    const prepared = prepareJudgeMedia({
      artifactDirectories: [first, second],
      outputDirectory: output,
    });
    const canonicalManifest = readFileSync(prepared.manifestPath, "utf8");

    const noncanonicalProfile = JSON.parse(canonicalManifest);
    noncanonicalProfile.profiles.isolatedOutput.constantBitRateKbps = 128;
    writeFileSync(prepared.manifestPath, `${JSON.stringify(noncanonicalProfile, null, 2)}\n`);
    expect(() => loadPreparedJudgeMedia(output, [first, second])).toThrow(
      "profiles do not match canonical",
    );

    const forgedTools = JSON.parse(canonicalManifest);
    forgedTools.tools.ffmpegVersion = "forged ffmpeg version";
    writeFileSync(prepared.manifestPath, `${JSON.stringify(forgedTools, null, 2)}\n`);
    expect(() => loadPreparedJudgeMedia(output, [first, second])).toThrow(
      "tool provenance does not match",
    );
  });

  test("rejects listening media whose probed format contradicts its canonical track profile", () => {
    const root = temporaryDirectory();
    const first = makeArtifact(root, "artifact-one", 3_000);
    const second = makeArtifact(root, "artifact-two", 5_000);
    const output = join(root, "media");
    const prepared = prepareJudgeMedia({
      artifactDirectories: [first, second],
      outputDirectory: output,
    });
    const manifest = JSON.parse(readFileSync(prepared.manifestPath, "utf8"));
    const subject = manifest.subjects[0];
    const isolatedFile = subject.tracks.isolatedOutput.listening.file;
    copyFileSync(
      prepared.audioOverrides[0].conversation!.path,
      prepared.audioOverrides[0].isolatedOutput!.path,
    );
    subject.tracks.isolatedOutput.listening = {
      ...structuredClone(subject.tracks.conversation.listening),
      file: isolatedFile,
    };
    writeFileSync(prepared.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => loadPreparedJudgeMedia(output, [first, second])).toThrow(
      "isolated output listening format does not match canonical profile",
    );
  });

  test("rejects canonical-format listening media not derived from its bound PCM source", () => {
    const root = temporaryDirectory();
    const first = makeArtifact(root, "artifact-one", 3_000);
    const second = makeArtifact(root, "artifact-two", 5_000);
    const output = join(root, "media");
    const prepared = prepareJudgeMedia({
      artifactDirectories: [first, second],
      outputDirectory: output,
    });
    const manifest = JSON.parse(readFileSync(prepared.manifestPath, "utf8"));
    const firstListening = manifest.subjects[0].tracks.isolatedOutput.listening;
    const secondListening = manifest.subjects[1].tracks.isolatedOutput.listening;
    expect(firstListening.sha256).not.toBe(secondListening.sha256);
    copyFileSync(
      prepared.audioOverrides[1].isolatedOutput!.path,
      prepared.audioOverrides[0].isolatedOutput!.path,
    );
    manifest.subjects[0].tracks.isolatedOutput.listening = {
      ...structuredClone(secondListening),
      file: firstListening.file,
    };
    writeFileSync(prepared.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => loadPreparedJudgeMedia(output, [first, second])).toThrow(
      "is not the canonical transcode of its bound source",
    );
  });

  test("re-probes listening metadata and enforces canonical subject order", () => {
    const root = temporaryDirectory();
    const first = makeArtifact(root, "artifact-one", 3_000);
    const second = makeArtifact(root, "artifact-two", 5_000);
    const metadataOutput = join(root, "metadata-media");
    const metadata = prepareJudgeMedia({
      artifactDirectories: [first, second],
      outputDirectory: metadataOutput,
    });
    const tamperedMetadata = JSON.parse(readFileSync(metadata.manifestPath, "utf8"));
    tamperedMetadata.subjects[0].tracks.isolatedOutput.listening.format.durationMs += 100;
    writeFileSync(metadata.manifestPath, `${JSON.stringify(tamperedMetadata, null, 2)}\n`);
    expect(() => loadPreparedJudgeMedia(metadataOutput, [first, second])).toThrow(
      "failed receipt validation",
    );

    const orderOutput = join(root, "order-media");
    const order = prepareJudgeMedia({
      artifactDirectories: [first, second],
      outputDirectory: orderOutput,
    });
    const tamperedOrder = JSON.parse(readFileSync(order.manifestPath, "utf8"));
    tamperedOrder.subjects.reverse();
    writeFileSync(order.manifestPath, `${JSON.stringify(tamperedOrder, null, 2)}\n`);
    expect(() => loadPreparedJudgeMedia(orderOutput, [first, second])).toThrow(
      "subjects must be ordered",
    );
  });
});

function makeArtifact(root: string, name: string, amplitude: number): string {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  const sampleCount = 24_000;
  const outputPcm = Buffer.alloc(sampleCount * 2);
  const comparisonPcm = Buffer.alloc(sampleCount * 4);
  for (let sample = 0; sample < sampleCount; sample++) {
    const agent = sample % 32 < 16 ? amplitude : -amplitude;
    const evaluator = sample % 48 < 24 ? 2_000 : -2_000;
    outputPcm.writeInt16LE(agent, sample * 2);
    comparisonPcm.writeInt16LE(evaluator, sample * 4);
    comparisonPcm.writeInt16LE(agent, sample * 4 + 2);
  }
  writeFileSync(join(directory, "output.wav"), wavBuffer(outputPcm, 1));
  writeFileSync(join(directory, "comparison.wav"), wavBuffer(comparisonPcm, 2));
  writeFileSync(
    join(directory, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      evidence: {
        outputAudio: "output.wav",
        comparisonAudio: "comparison.wav",
      },
    })}\n`,
  );
  return directory;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "agentvoice-judge-media-"));
  temporaryDirectories.push(directory);
  return directory;
}
