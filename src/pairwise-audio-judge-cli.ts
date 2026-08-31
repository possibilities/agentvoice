#!/usr/bin/env bun
import { existsSync, mkdirSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultJudgeMediaDirectory, prepareJudgeMedia } from "./judge-media.ts";
import { localEnvValue } from "./local-env.ts";
import {
  defaultPairwiseAudioJudgmentPath,
  judgeArtifactPair,
  loadPairwiseResponseCheckpoint,
  writePairwiseAudioJudgment,
  writePairwiseResponseCheckpoint,
} from "./pairwise-audio-judge.ts";

export async function runPairwiseAudioJudgeCli(args: readonly string[]): Promise<number> {
  let exitCode = 0;
  let outputLock: PairwiseAudioJudgeLock | undefined;

  try {
    const options = parseArguments(args);
    if (!options) {
      usage();
      return 2;
    }
    const output =
      options.output ??
      defaultPairwiseAudioJudgmentPath(
        options.artifactDirectories[0],
        options.artifactDirectories[1],
      );
    if (!options.prepareOnly) {
      if (existsSync(output)) {
        throw new Error(
          `refusing to spend on a duplicate comparison because the write-once output exists: ${output}`,
        );
      }
      outputLock = acquirePairwiseAudioJudgeLock(output);
      if (existsSync(output)) {
        throw new Error(
          `refusing to spend on a duplicate comparison because the write-once output appeared while acquiring its lock: ${output}`,
        );
      }
    }
    const prepared = prepareJudgeMedia({
      artifactDirectories: options.artifactDirectories,
      outputDirectory:
        options.mediaDirectory ??
        defaultJudgeMediaDirectory(options.artifactDirectories[0], options.artifactDirectories[1]),
    });
    if (options.prepareOnly) {
      stdout(
        `Prepared dual-track judge media: ${prepared.manifestPath}\n` +
          `Manifest SHA-256: ${prepared.manifestSha256}\n`,
      );
      return 0;
    }

    const apiKey = resolvePairwiseAudioJudgeApiKey(options);
    const attemptId = new Date().toISOString().replace(/[:.]/g, "-");
    const checkpointPaths = [
      `${output}.attempt-${attemptId}.pass-1.response.json`,
      `${output}.attempt-${attemptId}.pass-2.response.json`,
    ] as const;
    const responseCheckpoints = [
      options.resumePassOne ? loadPairwiseResponseCheckpoint(options.resumePassOne) : undefined,
      options.resumePassTwo ? loadPairwiseResponseCheckpoint(options.resumePassTwo) : undefined,
    ] as const;
    const judgment = await judgeArtifactPair({
      artifactDirectories: options.artifactDirectories,
      audioOverrides: prepared.audioOverrides,
      mediaPreparation: {
        profileVersion: prepared.manifest.profileVersion,
        manifestSha256: prepared.manifestSha256,
      },
      responseCheckpoints,
      onResponseCheckpoint(checkpoint) {
        const path = checkpointPaths[checkpoint.ordinal - 1]!;
        writePairwiseResponseCheckpoint(path, checkpoint);
        stderr(`Saved pass ${checkpoint.ordinal} response checkpoint: ${path}\n`);
      },
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxCompletionTokens === undefined
        ? {}
        : { maxCompletionTokens: options.maxCompletionTokens }),
    });
    writePairwiseAudioJudgment(output, judgment);
    const winner =
      judgment.aggregate.winner === "tie"
        ? "tie"
        : judgment.subjects.find((subject) => subject.subjectId === judgment.aggregate.winner)!
            .artifactId;
    stdout(
      `Blind audio comparison complete: ${output}\n` +
        `Winner: ${winner}; margin: ${judgment.aggregate.marginPoints} points; ` +
        `consensus: ${judgment.aggregate.consensus}\n`,
    );
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    exitCode = 1;
  } finally {
    try {
      outputLock?.release();
    } catch (error) {
      stderr(
        `could not release pairwise audio judge lock: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      exitCode = 1;
    }
  }
  return exitCode;
}

if (import.meta.main) {
  process.exit(await runPairwiseAudioJudgeCli(Bun.argv.slice(2)));
}

interface CliOptions {
  artifactDirectories: [string, string];
  output?: string;
  mediaDirectory?: string;
  model?: string;
  timeoutMs?: number;
  maxCompletionTokens?: number;
  resumePassOne?: string;
  resumePassTwo?: string;
  prepareOnly: boolean;
}

export interface PairwiseAudioJudgeLock {
  path: string;
  release(): void;
}

/** Serializes report-producing invocations before either pass can reach the provider. */
export function acquirePairwiseAudioJudgeLock(output: string): PairwiseAudioJudgeLock {
  const absoluteOutput = resolve(output);
  const path = `${absoluteOutput}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          kind: "voice-agent-pairwise-audio-judge-lock",
          pid: process.pid,
          createdAt: new Date().toISOString(),
          output: absoluteOutput,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new Error(
        `another pairwise audio judgment already holds the atomic output lock: ${path}. ` +
          "If no judge process is running, remove only this stale lock and retry.",
      );
    }
    throw error;
  }

  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      try {
        unlinkSync(path);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    },
  };
}

export function resolvePairwiseAudioJudgeApiKey(
  options: Pick<CliOptions, "resumePassOne" | "resumePassTwo">,
  lookup: (name: string) => string | undefined = localEnvValue,
): string | undefined {
  if (options.resumePassOne && options.resumePassTwo) return undefined;
  const apiKey = lookup("OPENAI_API_KEY");
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Put it in the ignored .env.local file; never pass it on the command line.",
    );
  }
  return apiKey;
}

function parseArguments(args: readonly string[]): CliOptions | null {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  let prepareOnly = false;
  const valueOptions = new Set([
    "--output",
    "--media-dir",
    "--model",
    "--timeout-ms",
    "--max-completion-tokens",
    "--resume-pass-1",
    "--resume-pass-2",
  ]);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--prepare-only") {
      prepareOnly = true;
      continue;
    }
    const equals = argument.indexOf("=");
    const name = equals >= 0 ? argument.slice(0, equals) : argument;
    if (valueOptions.has(name)) {
      const value = equals >= 0 ? argument.slice(equals + 1) : args[++index];
      if (!value) throw new Error(`${name} requires a value`);
      if (values.has(name)) throw new Error(`${name} may be specified only once`);
      values.set(name, value);
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`unknown option: ${argument}`);
    positionals.push(argument);
  }
  if (positionals.length === 0) return null;
  if (positionals.length !== 2) {
    throw new Error(`expected exactly two artifact directories; got ${positionals.length}`);
  }
  return {
    artifactDirectories: [positionals[0]!, positionals[1]!],
    ...(values.get("--output") === undefined ? {} : { output: values.get("--output") }),
    ...(values.get("--media-dir") === undefined
      ? {}
      : { mediaDirectory: values.get("--media-dir") }),
    ...(values.get("--model") === undefined ? {} : { model: values.get("--model") }),
    ...(values.get("--timeout-ms") === undefined
      ? {}
      : { timeoutMs: positiveInteger(values.get("--timeout-ms")!, "--timeout-ms") }),
    ...(values.get("--max-completion-tokens") === undefined
      ? {}
      : {
          maxCompletionTokens: positiveInteger(
            values.get("--max-completion-tokens")!,
            "--max-completion-tokens",
          ),
        }),
    ...(values.get("--resume-pass-1") === undefined
      ? {}
      : { resumePassOne: values.get("--resume-pass-1") }),
    ...(values.get("--resume-pass-2") === undefined
      ? {}
      : { resumePassTwo: values.get("--resume-pass-2") }),
    prepareOnly,
  };
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer; got ${value}`);
  }
  return parsed;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function usage(): void {
  stderr(`Usage:
  bun run src/pairwise-audio-judge-cli.ts ARTIFACT_A ARTIFACT_B
    [--output FILE] [--media-dir DIRECTORY] [--model MODEL]
    [--timeout-ms MS] [--max-completion-tokens TOKENS]
    [--resume-pass-1 CHECKPOINT] [--resume-pass-2 CHECKPOINT] [--prepare-only]

The command first creates or validates deterministic full-length MP3 copies of
each output.wav and comparison.wav. Without --prepare-only it acquires an atomic
sidecar lock for the write-once output, runs two identity-blind counterbalanced
audio judgments with store=false, and writes one report beneath
artifacts/judgments/. OPENAI_API_KEY is read from .env.local unless both pass
checkpoints are supplied, in which case replay is local and credential-free.
It writes each provider response before semantic validation so a paid pass can
be inspected and replayed after a validation failure. Current checkpoints bind
the exact serialized request body; historical v1 checkpoints are validation-only
and cannot be replayed into a v2 run. The command refuses to call the paid judge
when the output report exists or another invocation holds its lock.\n`);
}

function stdout(text: string): void {
  writeSync(process.stdout.fd, text);
}

function stderr(text: string): void {
  writeSync(process.stderr.fd, text);
}
