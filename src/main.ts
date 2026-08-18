#!/usr/bin/env bun
/** CLI entry: `agentvoice console [options]` is the voice console; sibling
 *  subcommands manage the resident app-server, account profiles, and the
 *  Remote console. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import packageJson from "../package.json";
import { RemoteError, type RemoteTarget, runRemote } from "./console/remote-ui.ts";
import { ConsoleError, type ConsoleOptions, runConsole } from "./console/ui.ts";
import {
  AUTH_FILE,
  accountsDirectory,
  discoverProfiles,
  listPoolAccounts,
  onboardingCommands,
  reconcileFarm,
} from "./core/accounts.ts";
import {
  ConfigError,
  cliToConfigValues,
  DEFAULT_REMOTE_PORT,
  loadConfigFile,
  resolveConfig,
} from "./core/config.ts";
import { consoleControlSocketPath, defaultConfigPath, expandTilde } from "./paths.ts";
import {
  installResident,
  ResidentError,
  residentStatus,
  restartResident,
  runPickHome,
  uninstallResident,
} from "./resident/install.ts";

export const VERSION: string = packageJson.version;

const USAGE = `agentvoice — talk to a Codex orchestrator agent, hands-free

Usage:
  agentvoice console [options]    Open the voice console
  agentvoice resident <command>   Manage the launchd-resident codex app-server
  agentvoice accounts <command>   Manage account profiles for balancing
  agentvoice remote               Open the phone-sized remote console

Run \`agentvoice <command> --help\` for options. First run: install the
resident with \`agentvoice resident install\`, then run \`agentvoice console\`.
`;

const ACCOUNTS_USAGE = `agentvoice accounts — account profiles for multi-account balancing

A profile is a per-account CODEX_HOME under the state directory: its own
auth.json and private app-server control directory, with session/config state
symlinked to the canonical ~/.codex so all accounts share one session store.
Enable selection with accounts.balance in server.json.

Usage:
  agentvoice accounts add <slug>   Create a profile and log it in
                                   (runs codex login --device-auth inside it)
  agentvoice accounts list         Show profiles and their identities

The slug is a local label (lowercase letters, digits, hyphens) — pick one
per ChatGPT account, e.g. "personal" or "work".
`;

const CONSOLE_USAGE = `agentvoice console — open the voice console

Usage:
  agentvoice console [options]

Attaches to the resident app-server, resumes the persisted orchestrator
agent (or starts one), and opens a full-duplex voice session against it.
Requires the resident: agentvoice resident install.

Options (the full surface lives in server.json; see server.json.example
and server.schema.json):
  --config <path>          Config file (default: ~/.config/agentvoice/server.json)
  --model <id>             Orchestrator agent model (default: codex config)
  --effort <level>         Orchestrator agent reasoning effort (default: codex config)
  --voice-model <id>       Voice agent model (default: codex config)
  --voice <name>           Voice timbre (default: upstream default)
  --workspace <dir>        Orchestrator agent working directory
                           (default: your home directory)
  --sandbox <mode>         read-only | workspace-write | danger-full-access
                           (default: danger-full-access)
  --approval-policy <p>    never | on-request | untrusted (default: never)
  --codex <path>           Codex binary (default: $CODEX_PATH or "codex")
  --device <index>         Microphone device index (default: system default)
  --output-device <index>  Speaker device index (default: system default)
  --fresh                  Abandon the persisted agent; start a fresh thread
  --debug                  Write a debug log to the state directory

Keys: [m] mute mic · [s] mute speaker · [r] redial voice · [f] fresh thread · [q] quit

Prompts are files in the config file's directory, all optional:
  VOICE.md, VOICE_SEED_{DEVELOPER,USER,ASSISTANT}.md   prime the voice agent
  ORCHESTRATOR.md, ORCHESTRATOR_BASE.md,               prime the orchestrator
  ORCHESTRATOR_SESSION_{START,END}.md                    agent
`;

const RESIDENT_USAGE = `agentvoice resident — the launchd-resident codex app-server

The resident is a bare \`codex app-server\` kept alive by launchd, serving a
private unix socket the console attaches to. Threads and workers live in it,
so they survive console restarts. Its wrapper consults the account balancer
at every spawn (accounts.balance).

Usage:
  agentvoice resident install [--config <path>]   Render the wrapper and
                                                  LaunchAgent, load, and start
  agentvoice resident status                      Report launchd, socket, and
                                                  account state
  agentvoice resident restart                     Restart onto a fresh
                                                  balancer pick
  agentvoice resident uninstall                   Unload and remove the
                                                  LaunchAgent
  agentvoice resident pick-home                   (wrapper-internal) print the
                                                  balancer's CODEX_HOME pick
`;

const REMOTE_USAGE = `agentvoice remote — the phone-sized control surface for a running Console

Usage:
  agentvoice remote                          attach on this machine
  agentvoice remote --host <addr> [--port N] attach across the tailnet

Options:
  --host <address>  The Console's tailnet address (\`tailscale ip -4\` on that
                    machine). Omitted, the Remote console attaches through the
                    owner-only unix socket on this machine.
  --port <port>     Defaults to ${DEFAULT_REMOTE_PORT}; must match remote.port there.
  --token <secret>  Must match remote.token in the Console's server.json.
                    Defaults to $AGENTVOICE_REMOTE_TOKEN. Required with --host.

The Remote console carries mute controls, Redial, Fresh, and signal state;
audio remains on the Console's own device. Serving --host needs remote.listen
and remote.token set in the Console's server.json.

Keys: [m] mute mic · [s] mute speaker · [r] redial voice · [f] fresh thread · [q] quit
`;

export interface FlagSpec {
  value: ReadonlySet<string>;
  bool: ReadonlySet<string>;
}

const CONSOLE_FLAGS: FlagSpec = {
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
  ]),
  bool: new Set(["--debug", "--fresh", "--help"]),
};

const RESIDENT_FLAGS: FlagSpec = {
  value: new Set(["--config"]),
  bool: new Set(["--help"]),
};

export class UsageError extends Error {}

export interface ParsedArgs {
  values: Record<string, string>;
  configPath?: string;
  debug: boolean;
  fresh: boolean;
  help: boolean;
}

export function parseArgs(argv: string[], spec: FlagSpec = CONSOLE_FLAGS): ParsedArgs {
  const seen = new Set<string>();
  const values: Record<string, string> = {};
  let configPath: string | undefined;
  let debug = false;
  let fresh = false;
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
      else if (flag === "--fresh") fresh = true;
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

  return { values, configPath, debug, fresh, help };
}

function parseDeviceIndex(flag: string, value: string): number {
  const index = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(index) || index > 0x7fffffff) {
    throw new UsageError(`${flag} must be a non-negative 32-bit integer; got "${value}"`);
  }
  return index;
}

function configLoader(parsed: ParsedArgs): {
  configPath: string;
  loadResolvedConfig: () => ReturnType<typeof loadAndResolve>;
} {
  const home = homedir();
  const configPath = parsed.configPath
    ? resolve(expandTilde(parsed.configPath, home))
    : defaultConfigPath(process.env, home);
  const explicitConfig = parsed.configPath !== undefined;
  const cliValues = cliToConfigValues(parsed.values);
  const loadResolvedConfig = () =>
    loadAndResolve(configPath, explicitConfig, cliValues, parsed.debug);
  return { configPath, loadResolvedConfig };
}

async function loadAndResolve(
  configPath: string,
  explicitConfig: boolean,
  cliValues: ReturnType<typeof cliToConfigValues>,
  debug: boolean,
) {
  const fileValues = await loadConfigFile(configPath, explicitConfig);
  return resolveConfig(cliValues, fileValues, process.env, homedir(), {
    debug,
    configDir: dirname(configPath),
  });
}

export type ParsedConsoleCommand =
  | { help: true }
  | { help: false; options: ConsoleOptions; parsed: ParsedArgs };

export function parseConsoleCommand(argv: string[]): ParsedConsoleCommand {
  const parsed = parseArgs(argv, CONSOLE_FLAGS);
  if (parsed.help) return { help: true };
  const device = parsed.values["device"];
  const outputDevice = parsed.values["output-device"];
  const options: ConsoleOptions = {
    ...(device === undefined ? {} : { deviceIndex: parseDeviceIndex("--device", device) }),
    ...(outputDevice === undefined
      ? {}
      : { outputDeviceIndex: parseDeviceIndex("--output-device", outputDevice) }),
    debug: parsed.debug,
    fresh: parsed.fresh,
  };
  // Device flags are console-side; keep them out of the config layer.
  delete parsed.values["device"];
  delete parsed.values["output-device"];
  return { help: false, options, parsed };
}

async function runConsoleCommand(argv: string[]): Promise<number> {
  const command = parseConsoleCommand(argv);
  if (command.help) {
    console.log(CONSOLE_USAGE);
    return 0;
  }
  const { configPath, loadResolvedConfig } = configLoader(command.parsed);
  // Prompt files live beside the config file, so --config relocates the bundle.
  const config = await loadResolvedConfig();
  await runConsole(config, command.options, VERSION, {
    path: configPath,
    load: loadResolvedConfig,
  });
  return 0;
}

async function runResidentCommand(argv: string[]): Promise<number> {
  const subcommand = argv[0];
  if (subcommand === undefined || subcommand === "--help" || subcommand === "help") {
    console.log(RESIDENT_USAGE);
    return subcommand === undefined ? 2 : 0;
  }
  const parsed = parseArgs(argv.slice(1), RESIDENT_FLAGS);
  if (parsed.help) {
    console.log(RESIDENT_USAGE);
    return 0;
  }
  const { configPath, loadResolvedConfig } = configLoader(parsed);
  switch (subcommand) {
    case "install":
      // Bake --config into the wrapper only when the operator gave one: the
      // default path resolves at every spawn, so a config created later is
      // picked up — and a missing default never errors the pick.
      return installResident(
        await loadResolvedConfig(),
        parsed.configPath !== undefined ? configPath : undefined,
      );
    case "status":
      return residentStatus();
    case "restart":
      return restartResident();
    case "uninstall":
      return uninstallResident();
    case "pick-home":
      return runPickHome(await loadResolvedConfig());
    default:
      throw new UsageError(`unknown resident command "${subcommand}"`);
  }
}

/**
 * Which Console a Remote console attaches to: a unix socket path on this
 * machine, or a network Console. Returns null for `--help`.
 */
export function parseRemoteTarget(
  argv: string[],
  env: NodeJS.ProcessEnv,
  home: string,
): RemoteTarget | null {
  const parsed = parseArgs(argv, {
    value: new Set(["--host", "--port", "--token"]),
    bool: new Set(["--help"]),
  });
  if (parsed.help) return null;
  // parseArgs keys values by the bare flag name, without the leading dashes.
  const host = parsed.values["host"];
  if (host === undefined) {
    if (parsed.values["port"] !== undefined || parsed.values["token"] !== undefined) {
      throw new UsageError("--port and --token only apply with --host");
    }
    return consoleControlSocketPath(env, home);
  }
  const token = parsed.values["token"] ?? env["AGENTVOICE_REMOTE_TOKEN"];
  if (token === undefined || token === "") {
    throw new UsageError(
      "--host needs --token (or $AGENTVOICE_REMOTE_TOKEN); it must match remote.token in the Console's server.json",
    );
  }
  const rawPort = parsed.values["port"];
  const port = rawPort === undefined ? DEFAULT_REMOTE_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError(`--port must be a port number, got "${rawPort}"`);
  }
  return { host, port, token };
}

async function runRemoteCommand(argv: string[]): Promise<number> {
  const target = parseRemoteTarget(argv, process.env, homedir());
  if (target === null) {
    console.log(REMOTE_USAGE);
    return 0;
  }
  await runRemote(target);
  return 0;
}

async function runAccountsCommand(argv: string[]): Promise<number> {
  const subcommand = argv[0];
  if (subcommand === undefined || subcommand === "--help" || subcommand === "help") {
    console.log(ACCOUNTS_USAGE);
    return subcommand === undefined ? 2 : 0;
  }
  const home = homedir();
  const canonicalHome = process.env["CODEX_HOME"] ?? join(home, ".codex");
  const accountsDir = accountsDirectory(process.env, home);

  if (subcommand === "list") {
    const profiles = discoverProfiles(accountsDir);
    if (profiles.length === 0) console.log(`no account profiles in ${accountsDir}`);
    for (const profile of profiles) {
      const identity = profile.identity;
      console.log(
        identity
          ? `${profile.slug}  ${identity.email}  ${identity.plan ?? "(unknown plan)"}`
          : `${profile.slug}  (not logged in — rerun \`agentvoice accounts add ${profile.slug}\`)`,
      );
    }
    const missing = onboardingCommands(await listPoolAccounts(), profiles);
    if (missing.length > 0) {
      console.log("\nregistered with codex-swap but still without a profile:");
      for (const command of missing) console.log(`  ${command}`);
    }
    return 0;
  }

  if (subcommand === "add") {
    const slug = argv[1];
    if (slug === undefined || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      throw new UsageError("accounts add requires a slug of lowercase letters, digits, hyphens");
    }
    if (!existsSync(canonicalHome)) {
      throw new UsageError(`canonical codex home ${canonicalHome} does not exist; run codex once`);
    }
    const profileDir = join(accountsDir, slug);
    reconcileFarm(canonicalHome, profileDir, (message) => console.error(`accounts: ${message}`));
    const authPath = join(profileDir, AUTH_FILE);
    if (!existsSync(authPath)) {
      // codex owns the whole OAuth flow; the profile only scopes where the
      // grant lands. Device auth works headless and never binds port 1455.
      console.log(`logging in profile ${slug} (codex login --device-auth)…`);
      console.log(
        "This profile binds to whichever ChatGPT account approves the device\ncode — use a browser window signed into the account you mean.\n",
      );
      const child = Bun.spawn(["codex", "login", "--device-auth"], {
        env: { ...process.env, CODEX_HOME: profileDir },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      if ((await child.exited) !== 0) {
        console.error(`codex login failed for profile ${slug}`);
        return 1;
      }
    }
    const profile = discoverProfiles(accountsDir).find((candidate) => candidate.slug === slug);
    const identity = profile?.identity;
    if (!identity) {
      console.error(`profile ${slug} has no readable identity; login may not have completed`);
      return 1;
    }
    console.log(`${slug}  ${identity.email}  ${identity.plan ?? "(unknown plan)"}`);
    const profiles = discoverProfiles(accountsDir);
    const duplicate = profiles.find(
      (candidate) => candidate.slug !== slug && candidate.identity?.email === identity.email,
    );
    if (duplicate) {
      console.error(
        `warning: ${duplicate.slug} holds the same account; selection maps by email and needs one profile per account`,
      );
    }
    const pool = await listPoolAccounts();
    const missing = onboardingCommands(pool, profiles);
    if (missing.length > 0) {
      console.log("\nstill without a profile:");
      for (const command of missing) console.log(`  ${command}`);
    } else if (pool.length > 0) {
      console.log(
        "\nevery codex-swap account has a profile; restart the resident to balance:\n  agentvoice resident restart",
      );
    }
    return 0;
  }

  throw new UsageError(`unknown accounts command "${subcommand}"`);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command === undefined || command === "help" || command === "--help") {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }

  const commands: Record<string, { run: (argv: string[]) => Promise<number>; usage: string }> = {
    console: { run: runConsoleCommand, usage: CONSOLE_USAGE },
    resident: { run: runResidentCommand, usage: RESIDENT_USAGE },
    remote: { run: runRemoteCommand, usage: REMOTE_USAGE },
    accounts: { run: runAccountsCommand, usage: ACCOUNTS_USAGE },
  };
  const entry = command.startsWith("-") ? undefined : commands[command];
  if (entry === undefined) {
    if (command === "server" || command === "client") {
      console.error(
        `the two-app split is gone: run \`agentvoice console\` after \`agentvoice resident install\`\n`,
      );
    } else if (command.startsWith("-")) {
      console.error(`the console is a subcommand now: run \`agentvoice console ${command} …\`\n`);
    } else {
      console.error(`unknown command "${command}"\n`);
    }
    console.error(USAGE);
    return 2;
  }
  const run = () => entry.run(argv.slice(1));
  const usage = entry.usage;

  try {
    return await run();
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n`);
      console.error(usage);
      return 2;
    }
    if (
      error instanceof ConfigError ||
      error instanceof ConsoleError ||
      error instanceof RemoteError ||
      error instanceof ResidentError
    ) {
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
