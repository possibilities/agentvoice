#!/usr/bin/env bun
/** CLI entry: `agentvoicenext server [options]` / `agentvoicenext client [options]`. */
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import packageJson from "../package.json";
import { ClientError, runClient } from "./client/ui.ts";
import { defaultConfigPath, expandTilde } from "./paths.ts";
import { ConfigError, cliToConfigValues, loadConfigFile, resolveConfig } from "./server/config.ts";
import { runServer } from "./server/server.ts";

export const VERSION: string = packageJson.version;
const DEFAULT_CLIENT_URL = "ws://127.0.0.1:7890/ws";

const USAGE = `agentvoicenext — minimal voice server and terminal client for Codex

Usage:
  agentvoicenext server [options]   Start the voice server
  agentvoicenext client [options]   Open the terminal voice client

Server options (the full surface lives in server.yaml; see server.yaml.example):
  --config <path>          Config file (default: ~/.config/agentvoicenext/server.yaml)
  --model <id>             Orchestrator agent model (default: codex config)
  --effort <level>         Orchestrator agent reasoning effort (default: codex config)
  --voice-model <id>       Voice agent model (default: codex config)
  --voice <name>           Voice timbre (default: upstream default)
  --workspace <dir>        Orchestrator agent working directory
                           (default: ~/.local/state/agentvoicenext/workspace)
  --sandbox <mode>         read-only | workspace-write | danger-full-access
                           (default: danger-full-access)
  --approval-policy <p>    never | on-request | untrusted (default: never)
  --port <n>               WebSocket port on 127.0.0.1 (default: 7890)
  --codex <path>           Codex binary (default: $CODEX_PATH or "codex")
  --debug                  Log app-server protocol frames to stderr

Prompts are files in the config file's directory, all optional:
  VOICE.md, VOICE_SEED_{DEVELOPER,USER,ASSISTANT}.md   prime the voice agent
  ORCHESTRATOR.md, ORCHESTRATOR_BASE.md,               prime the orchestrator
  ORCHESTRATOR_SESSION_{START,END}.md                    agent

Client options:
  --url <ws-url>           Server WebSocket (default: ${DEFAULT_CLIENT_URL})
  --device <index>         Microphone device index (default: system default)
  --debug                  Write a debug log to the state directory

Keys in the client: [m] mute mic · [s] mute speaker · [r] redial voice · [q] quit
`;

export interface FlagSpec {
  value: ReadonlySet<string>;
  bool: ReadonlySet<string>;
}

const SERVER_FLAGS: FlagSpec = {
  value: new Set([
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
  ]),
  bool: new Set(["--debug", "--help"]),
};

const CLIENT_FLAGS: FlagSpec = {
  value: new Set(["--url", "--device"]),
  bool: new Set(["--debug", "--help"]),
};

export class UsageError extends Error {}

export interface ParsedArgs {
  values: Record<string, string>;
  configPath?: string;
  debug: boolean;
  help: boolean;
}

export function parseArgs(argv: string[], spec: FlagSpec = SERVER_FLAGS): ParsedArgs {
  const seen = new Set<string>();
  const values: Record<string, string> = {};
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
    if (!spec.value.has(flag) && !spec.bool.has(flag)) {
      throw new UsageError(`unknown option "${flag}"`);
    }
    if (seen.has(flag)) {
      throw new UsageError(`option "${flag}" given more than once`);
    }
    seen.add(flag);
    if (spec.bool.has(flag)) {
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
    else values[flag.slice(2)] = value;
  }

  return { values, configPath, debug, help };
}

async function runServerCommand(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, SERVER_FLAGS);
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  const home = homedir();
  const configPath = parsed.configPath
    ? resolve(expandTilde(parsed.configPath, home))
    : defaultConfigPath(process.env, home);
  const fileValues = await loadConfigFile(configPath, parsed.configPath !== undefined);
  // Prompt files live beside the config file, so --config relocates the bundle.
  const config = resolveConfig(cliToConfigValues(parsed.values), fileValues, process.env, home, {
    debug: parsed.debug,
    configDir: dirname(configPath),
  });
  await runServer(config, VERSION);
  return 0;
}

async function runClientCommand(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, CLIENT_FLAGS);
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  let deviceIndex: number | undefined;
  const device = parsed.values["device"];
  if (device !== undefined) {
    deviceIndex = Number.parseInt(device, 10);
    if (!Number.isInteger(deviceIndex) || deviceIndex < 0) {
      throw new UsageError(`--device must be a non-negative integer; got "${device}"`);
    }
  }
  await runClient({
    url: parsed.values["url"] ?? DEFAULT_CLIENT_URL,
    ...(deviceIndex !== undefined ? { deviceIndex } : {}),
    debug: parsed.debug,
  });
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }

  try {
    if (command === "server") return await runServerCommand(argv.slice(1));
    if (command === "client") return await runClientCommand(argv.slice(1));
    console.error(`unknown command "${command}"\n`);
    console.error(USAGE);
    return 2;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n`);
      console.error(USAGE);
      return 2;
    }
    if (error instanceof ConfigError || error instanceof ClientError) {
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
