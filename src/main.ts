#!/usr/bin/env bun
/** CLI entry: `agentvoicenext server [options]`. */
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  ConfigError,
  defaultConfigPath,
  expandTilde,
  loadConfigFile,
  resolveConfig,
  type ConfigValues,
} from "./config.ts";
import { runServer } from "./server.ts";

export const VERSION = "0.1.0";

const USAGE = `agentvoicenext — minimal voice server for Codex

Usage:
  agentvoicenext server [options]

Options:
  --config <path>          Config file (default: ~/.config/agentvoicenext/server.yaml)
  --model <id>             Orchestrator model (default: codex config)
  --effort <level>         Orchestrator reasoning effort (default: codex config)
  --voice-model <id>       Realtime speech model (default: codex config)
  --voice <name>           Voice timbre (default: upstream default)
  --workspace <dir>        Agent working directory
                           (default: ~/.local/state/agentvoicenext/workspace)
  --sandbox <mode>         read-only | workspace-write | danger-full-access
                           (default: danger-full-access)
  --approval-policy <p>    never | on-request | untrusted (default: never)
  --port <n>               WebSocket port on 127.0.0.1 (default: 8790)
  --codex <path>           Codex binary (default: $CODEX_PATH or "codex")
  --debug                  Log app-server protocol frames to stderr
  --help                   Show this help
`;

const VALUE_FLAGS = new Set([
  "--config",
  "--model",
  "--effort",
  "--voice-model",
  "--voice",
  "--workspace",
  "--sandbox",
  "--approval-policy",
  "--port",
  "--codex",
]);
const BOOLEAN_FLAGS = new Set(["--debug", "--help"]);

export class UsageError extends Error {}

export interface ParsedArgs {
  values: ConfigValues;
  configPath?: string;
  debug: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const seen = new Set<string>();
  const values: ConfigValues = {};
  let configPath: string | undefined;
  let debug = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!;
    let flag = argument;
    let inline: string | undefined;
    if (argument.startsWith("--")) {
      const equals = argument.indexOf("=");
      if (equals !== -1) {
        flag = argument.slice(0, equals);
        inline = argument.slice(equals + 1);
      }
    }
    if (!VALUE_FLAGS.has(flag) && !BOOLEAN_FLAGS.has(flag)) {
      throw new UsageError(`unknown option "${flag}"`);
    }
    if (seen.has(flag)) {
      throw new UsageError(`option "${flag}" given more than once`);
    }
    seen.add(flag);
    if (BOOLEAN_FLAGS.has(flag)) {
      if (inline !== undefined) throw new UsageError(`"${flag}" takes no value`);
      if (flag === "--debug") debug = true;
      else help = true;
      continue;
    }
    let value = inline;
    if (value === undefined) {
      const nextArgument = argv[i + 1];
      if (nextArgument === undefined || nextArgument.startsWith("--")) {
        throw new UsageError(`option "${flag}" requires a value`);
      }
      value = nextArgument;
      i++;
    }
    if (flag === "--config") configPath = value;
    else (values as Record<string, string>)[flag.slice(2)] = value;
  }

  return { values, configPath, debug, help };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (
    command === undefined ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command !== "server") {
    console.error(`unknown command "${command}"\n`);
    console.error(USAGE);
    return 2;
  }

  try {
    const parsed = parseArgs(argv.slice(1));
    if (parsed.help) {
      console.log(USAGE);
      return 0;
    }
    const home = homedir();
    const configPath = parsed.configPath
      ? resolve(expandTilde(parsed.configPath, home))
      : defaultConfigPath(process.env, home);
    const fileValues = await loadConfigFile(
      configPath,
      parsed.configPath !== undefined,
    );
    const config = resolveConfig(
      parsed.values,
      fileValues,
      process.env,
      home,
      parsed.debug,
    );
    await runServer(config, VERSION);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n`);
      console.error(USAGE);
      return 2;
    }
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 1;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
