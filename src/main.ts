#!/usr/bin/env bun
import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
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
  agentvoice serve [--production]   Live Voice | Agent web transcripts at https://agentvoice.localhost
  agentvoice server [options]       Restore saved work or wait for a frontend
  agentvoice service status|load|unload|restart|remove [--json]
                                   Manage the default macOS LaunchAgent
  agentvoice [--workspace <dir>]    Open voice controls, transcript and agent panes
  agentvoice --attach [--host <ssh-host>] [--workspace <dir>]
                                   Desktop transcript and agent panes for another client's call
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
  agentvoice threads [--workspace <dir>] [--thread <root-id>] [--json]
                                   Show loaded threads and activity for watch

Server options:
  --workspace <dir>        Explicit conversation root (default: managed workspace)
  --config <path>          Config file (default: ~/.config/agentvoice/server.json)
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
  --debug                 Private runtime protocol/media log
  --help                  Show help

Client options (agentvoice or agentvoice client):
  --device <index>         This client's microphone device
  --output-device <index>  This client's speaker device

The macOS installer starts the default server as a LaunchAgent. Connect with agentvoice.
For manual use, run agentvoice server. It opens no audio; a valid saved marker restores
its Codex child immediately, while an unmarked workspace waits for a frontend.
Closing the frontend stops media; the server retains native work for the next client.
The client has pointer controls only: microphone, speaker and hold-to-talk.
Terminate its process or close its terminal to detach media. There are no app keybindings.
Server settings and prompt files load for each runtime. Permissions follow native
configuration unless explicitly overridden; native managed requirements still apply.
Server startup resumes a valid workspace .agentvoice-session thread without media;
the first frontend creates an unmarked session, and reconnects retain either one.
Use the agentvoice_new_session MCP/control operation for an explicit new session.
Stopping the server ends native work; runtime restart also replaces the native child.
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
    "--role",
  ]),
  bool: new Set(["--allow-full-access", "--debug", "--fast", "--no-fast", "--help"]),
};

export class UsageError extends Error {}

export interface ParsedArgs {
  values: Record<string, string>;
  codexConfig?: string[];
  configPath?: string;
  debug: boolean;
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
      if (["--resume", "--continue", "--fresh", "--no-continue"].includes(flag))
        throw new UsageError(
          `${flag} is retired; the workspace .agentvoice-session marker selects the session. Remove it or use agentvoice_new_session to start a new one.`,
        );
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

  if (!help && seen.has("--fast") && seen.has("--no-fast"))
    throw new UsageError("--fast cannot be combined with --no-fast");
  return {
    values,
    ...(codexConfig.length > 0 ? { codexConfig } : {}),
    configPath,
    debug,
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
  return {
    help: false,
    parsed,
    options: {
      debug: parsed.debug,
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
    if (command === "__attach-bridge" || command === "__attach-agent") {
      const { runAttachmentBridge, runPinnedAttachment } = await import(
        "./attachment/bridge-command.ts"
      );
      return await (command === "__attach-bridge" ? runAttachmentBridge : runPinnedAttachment)(
        argv.slice(1),
        stateDirectory(process.env, homedir()),
      );
    }
    if (command === "help") {
      console.log(USAGE);
      return 0;
    }
    if (command === "serve") {
      if (argv.length === 2 && argv[1] === "--help") {
        console.log(
          "Usage: agentvoice serve [--production]\nLive transcripts at https://agentvoice.localhost; Vite dev by default.",
        );
        return 0;
      }
      if (argv.length > 2 || (argv[1] !== undefined && argv[1] !== "--production"))
        throw new UsageError("Usage: agentvoice serve [--production]");
      const { serveWeb } = await import("./web-serve.ts");
      return await serveWeb(process.env, argv[1] === "--production");
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
      const json = argv.length === 3 && argv[2] === "--json";
      if (
        (!json && argv.length !== 2) ||
        !["status", "load", "unload", "restart", "remove"].includes(action ?? "")
      )
        throw new UsageError(
          "Usage: agentvoice service status|load|unload|restart|remove [--json]",
        );
      const { VoiceService, serviceOptions } = await import("./service.ts");
      const service = new VoiceService(serviceOptions(import.meta.path));
      if (action === "load" || action === "unload" || action === "restart" || action === "remove")
        await service.change(action);
      console.log(json ? JSON.stringify(await service.snapshot()) : await service.status());
      return 0;
    }
    if (command === "network") {
      const { networkCommand } = await import("./network/command.ts");
      await networkCommand(argv.slice(1), stateDirectory(process.env, homedir()));
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
      value: new Set(["--workspace", "--device", "--output-device", "--connect", "--host"]),
      bool: new Set(command === "client" ? ["--help"] : ["--help", "--attach"]),
    });
    if (frontendFlags.help) {
      console.log(USAGE);
      return 0;
    }
    const attach = clientArgs.includes("--attach");
    const host = frontendFlags.values["host"];
    if (host !== undefined && !attach) throw new UsageError("--host requires agentvoice --attach");
    if (attach) {
      for (const flag of ["device", "output-device", "connect"]) {
        if (frontendFlags.values[flag] !== undefined)
          throw new UsageError(
            `--${flag} cannot be combined with --attach; this view owns no audio`,
          );
      }
      const { validateSshHost } = await import("./attachment/ssh.ts");
      if (host !== undefined) {
        try {
          validateSshHost(host);
        } catch (error) {
          throw new UsageError((error as Error).message);
        }
      }
      let workspace = frontendFlags.values["workspace"];
      if (workspace !== undefined) {
        if (host) {
          if (!isAbsolute(workspace) || /[\0\r\n]/.test(workspace))
            throw new UsageError(
              "Remote --workspace requires an absolute path on the backend host",
            );
        } else {
          const selected = parseMcpConfigCommand(["--workspace", workspace]);
          if (selected.help) return 0;
          workspace = selected.workspace;
        }
      }
      const { runComposition } = await import("./composition/launch.ts");
      await runComposition(workspace, undefined, [], { attach: true, host });
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
