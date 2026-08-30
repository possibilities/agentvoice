#!/usr/bin/env bun
import { writeSync } from "node:fs";
import {
  defaultJudgmentPath,
  type JudgeReasoningEffort,
  judgeArtifact,
  writeQualityJudgment,
} from "./judge.ts";
import { localEnvValue } from "./local-env.ts";

const args = Bun.argv.slice(2);
let exitCode = 0;

try {
  const artifactDirectory = positional(args);
  if (!artifactDirectory) {
    usage();
    exitCode = 2;
  } else {
    const apiKey = localEnvValue("OPENAI_API_KEY");
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set. Put it in the ignored .env.local file; never pass it on the command line.",
      );
    }
    const reasoningEffort = parseEffort(option(args, "--effort") ?? "high");
    const judgment = await judgeArtifact({
      artifactDirectory,
      apiKey,
      ...(option(args, "--model") ? { model: option(args, "--model") } : {}),
      reasoningEffort,
      ...(integerOption(args, "--timeout-ms") === undefined
        ? {}
        : { timeoutMs: integerOption(args, "--timeout-ms") }),
      ...(integerOption(args, "--max-output-tokens") === undefined
        ? {}
        : { maxOutputTokens: integerOption(args, "--max-output-tokens") }),
    });
    const output = option(args, "--output") ?? defaultJudgmentPath(artifactDirectory);
    writeQualityJudgment(output, judgment);
    stdout(
      `Quality judgment complete: ${output}\n` +
        `Harness: ${judgment.deterministicHarness.status}; quality: ${
          judgment.quality.score ?? "unjudgeable"
        }/100 (${judgment.quality.band}, ${judgment.quality.scoredWeight}% rubric coverage)\n`,
    );
  }
} catch (error) {
  stderr(`${error instanceof Error ? error.message : String(error)}\n`);
  exitCode = 1;
}

process.exit(exitCode);

function option(args: readonly string[], name: string): string | undefined {
  const equals = args.find((arg) => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function integerOption(args: readonly string[], name: string): number | undefined {
  const raw = option(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer; got ${raw}`);
  }
  return value;
}

function positional(args: readonly string[]): string | undefined {
  const valueOptions = new Set([
    "--model",
    "--effort",
    "--output",
    "--timeout-ms",
    "--max-output-tokens",
  ]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (valueOptions.has(arg)) {
      index++;
      continue;
    }
    if (!arg.startsWith("--")) return arg;
  }
  return undefined;
}

function parseEffort(value: string): JudgeReasoningEffort {
  if (["low", "medium", "high", "xhigh", "max"].includes(value)) {
    return value as JudgeReasoningEffort;
  }
  throw new Error(`--effort must be low, medium, high, xhigh, or max; got ${value}`);
}

function usage(): void {
  stderr(`Usage:
  bun run src/judge-cli.ts ARTIFACT [--model MODEL] [--effort EFFORT]
    [--output FILE] [--timeout-ms MS] [--max-output-tokens TOKENS]

Reads OPENAI_API_KEY from .env.local first, then the inherited environment. The
default output is a write-once sibling beneath artifacts/judgments/, leaving
the run artifact immutable.\n`);
}

function stdout(text: string): void {
  writeSync(process.stdout.fd, text);
}

function stderr(text: string): void {
  writeSync(process.stderr.fd, text);
}
