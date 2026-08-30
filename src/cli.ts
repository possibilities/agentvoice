#!/usr/bin/env bun
import { writeSync } from "node:fs";
import { probeCodexVoice, runCodexScenario } from "./codex-runner.ts";
import { FxHeadlessOrchestrator } from "./fx-orchestrator.ts";
import { probeLiveKit, runLiveKitScenario } from "./livekit-runner.ts";
import { localEnvValue } from "./local-env.ts";

const [command, contender, ...rest] = Bun.argv.slice(2);
let exitCode = 0;

try {
  if (command === "probe" && contender === "codex") {
    const codexPath = option(rest, "--codex") ?? "codex";
    const result = await probeCodexVoice(codexPath);
    stdout(`${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "probe" && contender === "fx") {
    const fxPath = option(rest, "--fx") ?? "fx";
    const orchestrator = new FxHeadlessOrchestrator({
      workspace: process.cwd(),
      fxPath,
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    });
    try {
      const identity = await orchestrator.start();
      const snapshot = await orchestrator.snapshot();
      stdout(`${JSON.stringify({ identity, snapshot }, null, 2)}\n`);
    } finally {
      await orchestrator.stop();
    }
  } else if (command === "probe" && contender === "livekit") {
    const result = await probeLiveKit({
      ...(option(rest, "--livekit-server")
        ? { liveKitServerPath: option(rest, "--livekit-server") }
        : {}),
      ...(option(rest, "--worker") ? { workerPath: option(rest, "--worker") } : {}),
      ...(option(rest, "--runtime") ? { runtimePath: option(rest, "--runtime") } : {}),
    });
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
  } else if (command === "run" && contender === "livekit") {
    const scenarioPath = positional(rest);
    if (!scenarioPath) throw new Error("missing scenario path");
    const directory = await runLiveKitScenario({
      scenarioPath,
      openAiApiKey: requiredOpenAiApiKey(),
      ...(option(rest, "--artifacts") ? { artifactsRoot: option(rest, "--artifacts") } : {}),
      ...(option(rest, "--livekit-server")
        ? { liveKitServerPath: option(rest, "--livekit-server") }
        : {}),
      ...(option(rest, "--fx") ? { fxPath: option(rest, "--fx") } : {}),
      ...(option(rest, "--agent") ? { agentPath: option(rest, "--agent") } : {}),
      ...(option(rest, "--worker") ? { workerPath: option(rest, "--worker") } : {}),
      ...(option(rest, "--runtime") ? { runtimePath: option(rest, "--runtime") } : {}),
    });
    stdout(`LiveKit contender run complete: ${directory}\n`);
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
  const valueOptions = new Set([
    "--artifacts",
    "--codex",
    "--livekit-server",
    "--fx",
    "--agent",
    "--worker",
    "--runtime",
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

function usage(): void {
  stderr(`Usage:
  bun run src/cli.ts probe codex [--codex PATH]
  bun run src/cli.ts probe fx [--fx PATH]
  bun run src/cli.ts probe livekit [--livekit-server PATH] [--worker PATH] [--runtime PATH]
  bun run src/cli.ts run codex SCENARIO [--artifacts DIR] [--codex PATH]
  bun run src/cli.ts run livekit SCENARIO [--artifacts DIR] [--livekit-server PATH]
    [--fx PATH] [--agent PATH] [--worker PATH] [--runtime PATH]\n`);
}

function requiredOpenAiApiKey(): string {
  const apiKey = localEnvValue("OPENAI_API_KEY");
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Put it in the ignored .env.local file; never pass it on the command line.",
    );
  }
  return apiKey;
}

function stdout(text: string): void {
  writeSync(process.stdout.fd, text);
}

function stderr(text: string): void {
  writeSync(process.stderr.fd, text);
}
