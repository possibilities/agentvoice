#!/usr/bin/env bun
import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
/** Foreground voice application; console is a compatibility alias. */
import packageJson from "../package.json";
import { discoverController, discoverMcpConnection } from "./control/discovery.ts";
import { loadLaunchConfig } from "./core/launch-config.ts";
import { eventSocketPath } from "./events/socket.ts";
import { expandTilde, stateDirectory } from "./paths.ts";

export { loadLaunchConfig } from "./core/launch-config.ts";

export const VERSION: string = packageJson.version;
const USAGE = `agentvoice — a foreground Codex voice TUI

Usage:
  agentvoice --allow-full-access [options]          Continue this workspace's conversation
  agentvoice console --allow-full-access [options]  Compatibility alias
  agentvoice mcp-config [--workspace <dir>] [--thread <id>]
                                                  Print a live MCP client configuration
  agentvoice event-socket [--workspace <dir>] [--thread <id>]
                                                  Print a live read-only event socket path

Options:
  --allow-full-access      Required each launch: unrestricted files/network, no approvals
  --workspace <dir>        Conversation root (default: launch directory)
  --continue              Continue this workspace's conversation (default)
  --no-continue            Start a new conversation (--fresh is an alias)
  --resume <id>            Resume an unarchived AgentVoice conversation in this workspace
  --role <name|path>       Role directory (name under ~/.config/agentroles or a path):
                           its skills, mcp.json and prompt files apply to this launch only
  --config <path>          Config file (default: ~/.config/agentvoice/server.json)
  -c, --codex-config <key=value>  Native Codex startup override (repeatable, TOML value)
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

The foreground controller retains a disposable voice runtime and its stock Codex child.
Quitting stops running work; native conversation history remains resumable.
Full access is mandatory and verified with Codex; no config/environment opt-in.
No permission dialogs. Connector consent/tool questions are refused visibly.
No background services or remote attachment.

Prompts are opt-in files beside the selected config (not the workspace), each one
native Codex control: VOICE_AGENT_SYSTEM_PROMPT.md, VOICE_AGENT_APPEND_SYSTEM_PROMPT.md,
VOICE_ORCHESTRATOR_SYSTEM_PROMPT.md, VOICE_ORCHESTRATOR_APPEND_SYSTEM_PROMPT.md,
VOICE_ORCHESTRATOR_SESSION_START.md, VOICE_ORCHESTRATOR_SESSION_END.md. An override
and an append for the same agent cannot both be present. Raw native fields remain
available in orchestrator.extra / voice.extra.

Settings and prompt files load per runtime generation; runtime restart rereads them.
Raw extra fields can override named CLI settings; see README for precedence.

MCP config export selects one live controller by canonical workspace (the launch
directory by default). Use --thread when more than one controller is live there.
It prints an authenticated mcpServers JSON object for Claude Code and Inspector.

Keys: [m] toggle microphone · [s] toggle speaker · [r] redial · [f] fresh · [q] quit
      [ctrl+k] commands · [space] hold to talk (muted mic, key-release capable terminal)
`;

export interface FlagSpec {
  value: ReadonlySet<string>;
  bool: ReadonlySet<string>;
}
const LAUNCH_FLAGS: FlagSpec = {
  value: new Set([
    "--config",
    "--codex-config",
    "-c",
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
    "--role",
  ]),
  bool: new Set([
    "--allow-full-access",
    "--debug",
    "--fresh",
    "--no-continue",
    "--continue",
    "--fast",
    "--no-fast",
    "--help",
  ]),
};

export class UsageError extends Error {}

export interface ParsedArgs {
  values: Record<string, string>;
  codexConfig?: string[];
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
  const codexConfig: string[] = [];
  let configPath: string | undefined;
  let debug = false;
  let fresh = false;
  let help = false;
  let fast: boolean | undefined;

  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!;
    let flag = argument;
    let inline: string | undefined;
    if (argument.startsWith("--") || argument.startsWith("-c=")) {
      const equals = argument.indexOf("=");
      if (equals !== -1) {
        flag = argument.slice(0, equals);
        inline = argument.slice(equals + 1);
      }
    }
    if (!spec.value.has(flag) && !spec.bool.has(flag)) {
      throw new UsageError(`unknown option "${flag}"`);
    }
    const nativeConfig = flag === "--codex-config" || flag === "-c";
    if (seen.has(flag) && !nativeConfig) {
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
      if (nextArgument === undefined || nextArgument.startsWith("--") || nextArgument === "-c") {
        throw new UsageError(`option "${flag}" requires a value`);
      }
      value = nextArgument;
      i++;
    }
    if (nativeConfig) codexConfig.push(value);
    else if (flag === "--config") configPath = value;
    else values[flag.slice(2)] = value;
  }

  if (!help && fresh && values["resume"] !== undefined)
    throw new UsageError("--resume cannot be combined with --no-continue/--fresh");
  if (!help && seen.has("--continue") && (fresh || values["resume"] !== undefined))
    throw new UsageError("--continue cannot be combined with --no-continue/--fresh or --resume");
  if (!help && values["resume"] !== undefined && !values["resume"].trim())
    throw new UsageError("--resume requires a non-empty id");
  if (!help && seen.has("--fast") && seen.has("--no-fast"))
    throw new UsageError("--fast cannot be combined with --no-fast");
  return {
    values,
    ...(codexConfig.length > 0 ? { codexConfig } : {}),
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

const MCP_CONFIG_FLAGS: FlagSpec = {
  value: new Set(["--workspace", "--thread"]),
  bool: new Set(["--help"]),
};

export type ParsedMcpConfigCommand =
  | { help: true }
  | { help: false; workspace: string; threadId?: string };

export function parseMcpConfigCommand(
  argv: string[],
  launchCwd = process.cwd(),
  home = homedir(),
): ParsedMcpConfigCommand {
  const parsed = parseArgs(argv, MCP_CONFIG_FLAGS);
  if (parsed.help) return { help: true };
  const threadId = parsed.values["thread"];
  if (threadId !== undefined && !threadId.trim())
    throw new UsageError("--thread requires a non-empty id");
  const selected = parsed.values["workspace"] ?? launchCwd;
  if (!selected.trim()) throw new UsageError("--workspace requires a non-empty directory");
  const workspacePath = resolve(launchCwd, expandTilde(selected, home));
  try {
    if (!statSync(workspacePath).isDirectory()) throw new Error("not a directory");
    return {
      help: false,
      workspace: realpathSync(workspacePath),
      ...(threadId === undefined ? {} : { threadId }),
    };
  } catch (error) {
    throw new UsageError(`Cannot use workspace ${workspacePath}: ${String(error)}`);
  }
}

export async function runMcpConfigCommand(
  argv: string[],
  options: {
    launchCwd?: string;
    home?: string;
    env?: Record<string, string | undefined>;
    write?: (text: string) => void | Promise<void>;
  } = {},
): Promise<number> {
  const home = options.home ?? homedir();
  const command = parseMcpConfigCommand(argv, options.launchCwd ?? process.cwd(), home);
  if (command.help) {
    await (options.write ?? ((text) => Bun.write(Bun.stdout, text)))(USAGE);
    return 0;
  }
  const config = await discoverMcpConnection(
    stateDirectory(options.env ?? process.env, home),
    command.workspace,
    command.threadId,
  );
  await (options.write ?? ((text) => Bun.write(Bun.stdout, text)))(
    `${JSON.stringify(config, null, 2)}\n`,
  );
  return 0;
}

export async function runEventSocketCommand(
  argv: string[],
  options: {
    launchCwd?: string;
    home?: string;
    env?: Record<string, string | undefined>;
    write?: (text: string) => void | Promise<void>;
  } = {},
): Promise<number> {
  const home = options.home ?? homedir();
  const command = parseMcpConfigCommand(argv, options.launchCwd ?? process.cwd(), home);
  const write = options.write ?? ((text: string) => Bun.write(Bun.stdout, text));
  if (command.help) {
    await write(USAGE);
    return 0;
  }
  const stateDir = stateDirectory(options.env ?? process.env, home);
  const descriptor = await discoverController(stateDir, command.workspace, command.threadId);
  const path = eventSocketPath(stateDir, descriptor.instanceId);
  const info = lstatSync(path);
  if (
    !info.isSocket() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("unsafe AgentVoice event socket");
  await write(`${path}\n`);
  return 0;
}

async function runConsoleCommand(argv: string[]): Promise<number> {
  const command = parseConsoleCommand(argv);
  if (command.help) {
    console.log(USAGE);
    return 0;
  }
  await loadLaunchConfig(command.parsed);
  const { runController } = await import("./runtime-control/controller.ts");
  await runController(
    { parsed: command.parsed, options: command.options, launchCwd: process.cwd() },
    VERSION,
  );
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0];
  try {
    if (command === "help") {
      console.log(USAGE);
      return 0;
    }
    if (command === "event-socket") return await runEventSocketCommand(argv.slice(1));
    if (command === "mcp-config") return await runMcpConfigCommand(argv.slice(1));
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
