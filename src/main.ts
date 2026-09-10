#!/usr/bin/env bun
import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
/** Local voice server and independent pointer frontend. */
import packageJson from "../package.json";
import { discoverController, discoverMcpConnection } from "./control/discovery.ts";
import { loadLaunchConfig } from "./core/launch-config.ts";
import { eventSocketPath } from "./events/socket.ts";
import { expandTilde, stateDirectory } from "./paths.ts";

export { loadLaunchConfig } from "./core/launch-config.ts";

export const VERSION: string = packageJson.version;
const USAGE = `agentvoice — a local Codex voice server and frontend

Usage:
  agentvoice server [options]       Wait for a frontend to start a call
  agentvoice service status|restart|remove
                                   Manage the default macOS LaunchAgent
  agentvoice [--workspace <dir>]    Open voice controls, transcript and agent panes
  agentvoice client [--workspace <dir>]
                                   Connect with the pointer frontend alone
  agentvoice phone [--workspace <dir>]
                                   Open the loopback browser voice frontend
  agentvoice client|phone --connect <private-profile.json>
                                   Connect to an authenticated WSS server
  agentvoice network --help        Configure network access and device grants
  agentvoice role --help           Eject, copy and edit workspace SQLite roles
  agentvoice attach agent [--workspace <dir>] [--thread <id>]
                                   Attach stock Codex to an active call
  agentvoice attach voice [--workspace <dir>] [--thread <id>] [--list]
                                   View or list persistent voice transcripts
  agentvoice mcp-config [--workspace <dir>] [--thread <id>]
                                   Print live read-only MCP configuration
  agentvoice event-socket [--workspace <dir>] [--thread <id>]
                                   Print a live read-only event socket
  agentvoice threads [--workspace <dir>] [--thread <root-id>]
                                   Show loaded threads and activity for watch

Server options:
  --workspace <dir>        Explicit conversation root (default: managed workspace)
  --config <path>          Config file (default: ~/.config/agentvoice/server.json)
  --continue              Continue the latest eligible conversation for each call
  --resume <id>            Resume this exact conversation for each call
  --fresh, --no-continue   Start a new conversation for each call (default)
  --role <name|path>       Role directory for prompts, skills and MCP servers
  -c, --codex-config <key=value>  Native startup override (repeatable, TOML)
  --model <id>             Codex work model
  --effort <level>         Reasoning effort
  --fast, --no-fast        Explicit native Fast or standard processing
  --voice-model <id>       Realtime voice model
  --voice <name>           Voice timbre
  --sandbox <mode>         Native sandbox mode
  --approval-policy <p>    Native approval policy
  --allow-full-access     Explicit unrestricted files/network and no approvals
  --codex <path>           Stock Codex executable
  --debug                 Private per-call protocol/media log
  --help                  Show help

Client options (agentvoice or agentvoice client):
  --device <index>         This client's microphone device
  --output-device <index>  This client's speaker device

The macOS installer starts the default server as a LaunchAgent. Connect with agentvoice.
For manual use, run agentvoice server. It opens no audio or Codex child while waiting.
Closing the frontend ends its call; the server returns to waiting.
The client has pointer controls only: microphone, speaker and hold-to-talk.
Terminate its process or close its terminal to end a call. There are no app keybindings.
Server settings and prompt files load for each call. Permissions follow native
configuration unless explicitly overridden; native managed requirements still apply.
Use agentvoice attach agent to answer native approvals and tool questions.
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
  continue: boolean;
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
  let continueLatest = false;
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
      else if (flag === "--continue") continueLatest = true;
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
    continue: continueLatest,
    help,
    ...(fast === undefined ? {} : { fast }),
    ...(seen.has("--allow-full-access") ? { allowFullAccess: true } : {}),
  };
}

export function parseDeviceIndex(flag: string, value: string): number {
  const index = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(index) || index > 0x7fffffff) {
    throw new UsageError(`${flag} must be a non-negative 32-bit integer; got "${value}"`);
  }
  return index;
}

export interface ServerOptions {
  debug: boolean;
  fresh: boolean;
  continue: boolean;
  resume?: string;
}
export type ParsedServerCommand =
  | { help: true }
  | { help: false; options: ServerOptions; parsed: ParsedArgs };

export function parseServerCommand(argv: string[]): ParsedServerCommand {
  const parsed = parseArgs(argv);
  if (parsed.help) return { help: true };
  const device = parsed.values["device"];
  const outputDevice = parsed.values["output-device"];
  if (device !== undefined || outputDevice !== undefined)
    throw new UsageError(
      "Audio devices belong to the client; use agentvoice client --device/--output-device",
    );
  const resume = parsed.values["resume"];
  return {
    help: false,
    parsed,
    options: {
      debug: parsed.debug,
      fresh: parsed.fresh,
      continue: parsed.continue,
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

async function runServerCommand(argv: string[]): Promise<number> {
  const command = parseServerCommand(argv);
  if (command.help) {
    console.log(USAGE);
    return 0;
  }
  const config = await loadLaunchConfig(command.parsed);
  const { runServer } = await import("./frontend/server.ts");
  await runServer(
    { parsed: command.parsed, options: command.options, launchCwd: process.cwd() },
    VERSION,
    config.managedWorkspace ? undefined : config.orchestrator.workspace,
    command.parsed.values["workspace"] === undefined ? undefined : config.orchestrator.workspace,
  );
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0];
  try {
    if (command === "__runtime-worker") {
      const { runRuntimeWorker } = await import("./runtime-control/worker.ts");
      runRuntimeWorker();
      await new Promise<void>(() => {});
    }
    if (command === "help") {
      console.log(USAGE);
      return 0;
    }
    if (command === "role") {
      const { runRoleCommand } = await import("./roles/cli.ts");
      return await runRoleCommand(argv.slice(1));
    }
    if (command === "event-socket") return await runEventSocketCommand(argv.slice(1));
    if (command === "threads") {
      const { runThreadsCommand } = await import("./threads/command.ts");
      return await runThreadsCommand(argv.slice(1), stateDirectory(process.env, homedir()));
    }

    if (command === "attach") {
      const { runAttachCommand } = await import("./attachment/command.ts");
      return await runAttachCommand(argv.slice(1), stateDirectory(process.env, homedir()));
    }
    if (command === "mcp-config") return await runMcpConfigCommand(argv.slice(1));
    if (command === "accounts")
      throw new UsageError(
        "AgentVoice account management has been retired. Use codex login (optionally with CODEX_HOME set), then launch AgentVoice with the same environment. Existing profiles and credentials are untouched; see README migration notes.",
      );
    if (command === "server") return await runServerCommand(argv.slice(1));
    if (command === "service") {
      const action = argv[1];
      if (argv.length !== 2 || !["status", "restart", "remove"].includes(action ?? ""))
        throw new UsageError("Usage: agentvoice service status|restart|remove");
      const { VoiceService, serviceOptions } = await import("./service.ts");
      const service = new VoiceService(serviceOptions(import.meta.path));
      if (action === "restart" || action === "remove") await service.change(action);
      console.log(await service.status());
      return 0;
    }
    if (command === "network") {
      const { networkCommand } = await import("./network/command.ts");
      networkCommand(argv.slice(1), stateDirectory(process.env, homedir()));
      return 0;
    }
    if (command === "resident" || command === "remote" || command === "console") {
      throw new UsageError(
        `${command} has been retired. Run agentvoice server, then agentvoice in another terminal. Existing installed services are not changed automatically.`,
      );
    }
    if (command === "phone") {
      const phoneArgs = argv.slice(1);
      const parsed = parseArgs(phoneArgs, {
        value: new Set(["--workspace", "--connect"]),
        bool: new Set(["--help"]),
      });
      if (parsed.help) {
        console.log(USAGE);
        return 0;
      }
      const selected =
        parsed.values["workspace"] === undefined
          ? undefined
          : parseMcpConfigCommand(["--workspace", parsed.values["workspace"]]);
      if (selected?.help) return 0;
      if (parsed.values["connect"] && selected)
        throw new UsageError("--connect and --workspace are mutually exclusive");
      const { loadConnectionProfile } = await import("./network/credentials.ts");
      const { runBrowserFrontend } = await import("./browser/frontend.ts");
      await runBrowserFrontend(selected?.workspace, {
        connection: parsed.values["connect"]
          ? loadConnectionProfile(resolve(parsed.values["connect"]))
          : undefined,
      });
      return 0;
    }
    const clientArgs = command === "client" ? argv.slice(1) : argv;
    const frontendFlags = parseArgs(clientArgs, {
      value: new Set(["--workspace", "--device", "--output-device", "--connect"]),
      bool: new Set(["--help"]),
    });
    if (frontendFlags.help) {
      console.log(USAGE);
      return 0;
    }
    const selected =
      frontendFlags.values["workspace"] === undefined
        ? undefined
        : parseMcpConfigCommand(["--workspace", frontendFlags.values["workspace"]]);
    if (selected?.help) return 0;
    if (frontendFlags.values["connect"] && (selected || command !== "client"))
      throw new UsageError(
        "--connect requires agentvoice client and cannot select a local workspace",
      );
    if (command === "client") {
      const { launchClientRuntime } = await import("./frontend/client-runtime.ts");
      const exitCode = await launchClientRuntime(clientArgs, import.meta.path);
      if (exitCode !== undefined) return exitCode;
      const { runFrontend } = await import("./frontend/client.ts");
      const { loadConnectionProfile } = await import("./network/credentials.ts");
      await runFrontend(
        selected?.workspace,
        {
          deviceIndex:
            frontendFlags.values["device"] === undefined
              ? undefined
              : parseDeviceIndex("--device", frontendFlags.values["device"]),
          outputDeviceIndex:
            frontendFlags.values["output-device"] === undefined
              ? undefined
              : parseDeviceIndex("--output-device", frontendFlags.values["output-device"]),
        },
        frontendFlags.values["connect"]
          ? loadConnectionProfile(resolve(frontendFlags.values["connect"]))
          : undefined,
      );
    } else {
      const { runComposition } = await import("./composition/launch.ts");
      const deviceArgs: string[] = [];
      for (const flag of ["device", "output-device"]) {
        const value = frontendFlags.values[flag];
        if (value !== undefined) {
          parseDeviceIndex(`--${flag}`, value);
          deviceArgs.push(`--${flag}`, value);
        }
      }
      await runComposition(selected?.workspace, undefined, deviceArgs);
    }
    return 0;
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
