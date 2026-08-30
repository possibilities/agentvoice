#!/usr/bin/env bun
import { writeSync } from "node:fs";
import { probeCodexVoice, runCodexScenario } from "./codex-runner.ts";

const [command, contender, ...rest] = Bun.argv.slice(2);
let exitCode = 0;

try {
  if (command === "probe" && contender === "codex") {
    const codexPath = option(rest, "--codex") ?? "codex";
    const result = await probeCodexVoice(codexPath);
    stdout(`${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "run" && contender === "codex") {
    const scenarioPath = positional(rest);
    if (!scenarioPath) throw new Error("missing scenario path");
    const directory = await runCodexScenario({
      scenarioPath,
      ...(option(rest, "--artifacts") ? { artifactsRoot: option(rest, "--artifacts") } : {}),
      ...(option(rest, "--codex") ? { codexPath: option(rest, "--codex") } : {}),
    });
    stdout(`Codex reference run complete: ${directory}\n`);
  } else {
    usage();
    exitCode = 2;
  }
} catch (error) {
  stderr(`${error instanceof Error ? error.message : String(error)}\n`);
  exitCode = 1;
}

// Werift/Bun can retain a settled stream task after a connected peer closes,
// even though no process, socket, or timer remains. All runner cleanup has
// completed before this boundary, so terminate the CLI deterministically.
process.exit(exitCode);

function option(args: readonly string[], name: string): string | undefined {
  const equals = args.find((arg) => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--artifacts" || arg === "--codex") {
      index++;
      continue;
    }
    if (!arg.startsWith("--")) return arg;
  }
  return undefined;
}

function usage(): void {
  stderr(`Usage:
  bun run src/cli.ts probe codex [--codex PATH]
  bun run src/cli.ts run codex SCENARIO [--artifacts DIR] [--codex PATH]\n`);
}

function stdout(text: string): void {
  writeSync(process.stdout.fd, text);
}

function stderr(text: string): void {
  writeSync(process.stderr.fd, text);
}
