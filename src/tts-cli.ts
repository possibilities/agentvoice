#!/usr/bin/env bun
import { writeSync } from "node:fs";
import { localEnvValue } from "./local-env.ts";
import { renderFixtureAudio } from "./tts.ts";

const DEFAULT_MANIFEST = "fixtures/compact-full-duplex/audio/tts.json";
const args = Bun.argv.slice(2);
const replaceIndex = args.indexOf("--replace");
const replace = replaceIndex >= 0 ? args[replaceIndex + 1] : undefined;
const optionValues = new Set<number>();
if (replaceIndex >= 0) {
  optionValues.add(replaceIndex);
  optionValues.add(replaceIndex + 1);
}
const unknownOptions = args.filter(
  (arg, index) => arg.startsWith("--") && !optionValues.has(index),
);
const positional = args.filter((_arg, index) => !optionValues.has(index));

if (unknownOptions.length > 0 || positional.length > 1 || (replaceIndex >= 0 && !replace)) {
  stderr(`Usage: bun run render:fixture -- [TTS_MANIFEST] [--replace UTTERANCE_ID]\n`);
  process.exitCode = 2;
} else {
  const apiKey = localEnvValue("OPENAI_API_KEY");
  try {
    const result = await renderFixtureAudio({
      manifestPath: positional[0] ?? DEFAULT_MANIFEST,
      ...(apiKey ? { apiKey } : {}),
      ...(replace ? { replace } : {}),
      onProgress(progress) {
        if (progress.phase === "requesting") {
          stdout(`Rendering ${progress.index + 1}/${progress.total}: ${progress.id}...\n`);
        }
      },
    });
    stdout(
      `Fixture ready with ${result.utterances.length} utterances; receipt: ${result.receiptPath}\n`,
    );
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

function stdout(text: string): void {
  writeSync(process.stdout.fd, text);
}

function stderr(text: string): void {
  writeSync(process.stderr.fd, text);
}
