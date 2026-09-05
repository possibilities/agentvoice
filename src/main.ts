#!/usr/bin/env bun
/** Foreground voice application; console is a compatibility alias. */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import packageJson from "../package.json";
import { runConsoleHost } from "./console/host.ts";
import { ConfigError, cliToConfigValues, loadConfigFile, resolveConfig } from "./core/config.ts";
import { defaultConfigPath, expandTilde } from "./paths.ts";

export const VERSION: string = packageJson.version;
const USAGE = `agentvoice — a foreground Codex voice TUI

Usage:
  agentvoice --allow-full-access [options]          Continue this workspace's conversation
  agentvoice console --allow-full-access [options]  Compatibility alias

Options:
  --allow-full-access      Required each launch: unrestricted files/network, no approvals
  --workspace <dir>        Conversation root (default: launch directory)
  --no-continue            Start a new conversation (--fresh is an alias)
  --resume <id>            Resume an unarchived AgentVoice conversation in this workspace
  --config <path>          Config file (default: ~/.config/agentvoice/server.json)
  --model <id>             Codex work model (default: native configuration)
  --effort <level>         Codex reasoning effort (default: native configuration)
  --fast                  Native Fast tier when supported (higher usage/cost)
  --no-fast               Explicit standard processing, overriding inherited Fast
  --voice-model <id>       Realtime voice model
  --voice <name>           Voice timbre
  --device <index>         Microphone device (default: system default)
  --output-device <index>  Speaker device (default: system default)
  --sandbox <mode>         Only danger-full-access is supported
  --approval-policy <p>    Only never is supported
  --codex <path>           Stock Codex executable (default: $CODEX_PATH or codex)
  --debug                 Per-launch protocol/media log under the state directory
  --help                  Show help

One AgentVoice process owns an unmodified Codex app-server child.
Quitting stops running work; native conversation history remains resumable.
Full access is mandatory and verified with Codex; no config/environment opt-in.
No permission dialogs. Connector consent/tool questions are refused visibly.
No background services or remote attachment.

Prompts are opt-in: name files in server.json's prompt-files section, or use
native fields in orchestrator.extra / voice.extra. No filename auto-loading.
Relative prompt-file paths resolve beside the selected config, not the workspace.

Keys: [m] microphone · [s] speaker · [r] redial · [f] fresh · [q] quit
      [ctrl+k] commands · [space] push-to-talk (key-release capable terminal)
`;

export interface FlagSpec {
  value: ReadonlySet<string>;
  bool: ReadonlySet<string>;
}
const LAUNCH_FLAGS: FlagSpec = {
  value: new Set([
    "--config",
    "--model",
    "--effort",
    "--voice-model",
    "--voice",
    "--workspace",
    "--sandbox",
    "--approval-policy",
    "--codex",
    "--device",
    "--output-device",
    "--resume",
  ]),
  bool: new Set([
    "--allow-full-access",
    "--debug",
    "--fresh",
    "--no-continue",
    "--fast",
    "--no-fast",
    "--help",
  ]),
};

export class UsageError extends Error {}

export interface ParsedArgs {
  values: Record<string, string>;
  configPath?: string;
  debug: boolean;
  fresh: boolean;
  help: boolean;
  fast?: boolean;
  allowFullAccess?: boolean;
}

export function parseArgs(argv: string[], spec: FlagSpec = LAUNCH_FLAGS): ParsedArgs {
  const seen = new Set<string>();
  const values: Record<string, string> = {};
  let configPath: string | undefined;
  let debug = false;
  let fresh = false;
  let help = false;
  let fast: boolean | undefined;

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
      else if (flag === "--fresh" || flag === "--no-continue") fresh = true;
      else if (flag === "--fast" || flag === "--no-fast") fast = flag === "--fast";
      else if (flag === "--help") help = true;
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

  if (!help && fresh && values["resume"] !== undefined)
    throw new UsageError("--resume cannot be combined with --no-continue/--fresh");
  if (!help && values["resume"] !== undefined && !values["resume"].trim())
    throw new UsageError("--resume requires a non-empty id");
  if (!help && seen.has("--fast") && seen.has("--no-fast"))
    throw new UsageError("--fast cannot be combined with --no-fast");
  return {
    values,
    configPath,
    debug,
    fresh,
    help,
    ...(fast === undefined ? {} : { fast }),
    ...(seen.has("--allow-full-access") ? { allowFullAccess: true } : {}),
  };
}

function parseDeviceIndex(flag: string, value: string): number {
  const index = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(index) || index > 0x7fffffff) {
    throw new UsageError(`${flag} must be a non-negative 32-bit integer; got "${value}"`);
  }
  return index;
}

export interface ConsoleOptions {
  deviceIndex?: number;
  outputDeviceIndex?: number;
  debug: boolean;
  fresh: boolean;
  resume?: string;
}
export type ParsedConsoleCommand =
  | { help: true }
  | { help: false; options: ConsoleOptions; parsed: ParsedArgs };

export function parseConsoleCommand(argv: string[]): ParsedConsoleCommand {
  const parsed = parseArgs(argv);
  if (parsed.help) return { help: true };
  if (!parsed.allowFullAccess)
    throw new UsageError(
      "AgentVoice requires --allow-full-access on every launch: unrestricted filesystem/network access and no command/file approval prompts.",
    );
  const device = parsed.values["device"];
  const outputDevice = parsed.values["output-device"];
  const resume = parsed.values["resume"];
  return {
    help: false,
    parsed,
    options: {
      ...(device === undefined ? {} : { deviceIndex: parseDeviceIndex("--device", device) }),
      ...(outputDevice === undefined
        ? {}
        : { outputDeviceIndex: parseDeviceIndex("--output-device", outputDevice) }),
      debug: parsed.debug,
      fresh: parsed.fresh,
      ...(resume === undefined ? {} : { resume }),
    },
  };
}

export function configLoader(parsed: ParsedArgs, launchCwd = process.cwd()) {
  const home = homedir();
  const configPath = parsed.configPath
    ? resolve(launchCwd, expandTilde(parsed.configPath, home))
    : defaultConfigPath(process.env, home);
  const {
    device: _device,
    "output-device": _outputDevice,
    resume: _resume,
    ...values
  } = parsed.values;
  const cliValues = cliToConfigValues(values);
  const loadResolvedConfig = async () => {
    const fileValues = await loadConfigFile(configPath, parsed.configPath !== undefined);
    const config = resolveConfig(cliValues, fileValues, process.env, home, {
      debug: parsed.debug,
      configDir: dirname(configPath),
      launchCwd,
    });
    try {
      if (!statSync(config.orchestrator.workspace).isDirectory())
        throw new Error("not a directory");
      config.orchestrator.workspace = realpathSync(config.orchestrator.workspace);
    } catch (error) {
      throw new ConfigError(
        `Cannot use workspace ${config.orchestrator.workspace}: ${String(error)}`,
      );
    }
    return config;
  };
  return { configPath, loadResolvedConfig };
}

async function runConsoleCommand(argv: string[]): Promise<number> {
  const command = parseConsoleCommand(argv);
  if (command.help) {
    console.log(USAGE);
    return 0;
  }
  const { configPath, loadResolvedConfig } = configLoader(command.parsed);
  const config = await loadResolvedConfig();
  await runConsoleHost(config, VERSION, {
    media: {
      deviceIndex: command.options.deviceIndex,
      outputDeviceIndex: command.options.outputDeviceIndex,
    },
    debug: command.options.debug,
    runtime: {
      fresh: command.options.fresh,
      resume: command.options.resume,
      fast: command.parsed.fast,
      configSource: { path: configPath, load: loadResolvedConfig },
    },
  });
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0];
  try {
    if (command === "help") {
      console.log(USAGE);
      return 0;
    }
    if (command === "accounts")
      throw new UsageError(
        "AgentVoice account management has been retired. Use codex login (optionally with CODEX_HOME set), then launch AgentVoice with the same environment. Existing profiles and credentials are untouched; see README migration notes.",
      );
    if (command === "server" || command === "resident" || command === "remote") {
      throw new UsageError(
        `${command} has been retired. Run agentvoice --allow-full-access [--workspace <dir>] in the foreground. Existing installed services are not changed automatically; see README migration notes.`,
      );
    }
    return await runConsoleCommand(command === "console" ? argv.slice(1) : argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof UsageError) {
      console.error(USAGE);
      return 2;
    }
    return 1;
  }
}
if (import.meta.main) process.exit(await main());
