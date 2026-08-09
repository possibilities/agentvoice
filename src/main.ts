#!/usr/bin/env bun
/** CLI entry: `agentvoice server|client|accounts [options]`. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import packageJson from "../package.json";
import { type ClientConfig, ClientError, runClient } from "./client/ui.ts";
import { defaultConfigPath, expandTilde } from "./paths.ts";
import {
  AUTH_FILE,
  accountsDirectory,
  discoverProfiles,
  listPoolAccounts,
  onboardingCommands,
  reconcileFarm,
} from "./server/accounts.ts";
import { ConfigError, cliToConfigValues, loadConfigFile, resolveConfig } from "./server/config.ts";
import { runServer } from "./server/server.ts";

export const VERSION: string = packageJson.version;
const DEFAULT_CLIENT_URL = "ws://127.0.0.1:7890/ws";

const USAGE = `agentvoice — minimal voice server and terminal client for Codex

Usage:
  agentvoice server [options]     Start the voice server
  agentvoice client [options]     Open the terminal voice client
  agentvoice accounts <command>   Manage account profiles for balancing

Run \`agentvoice <command> --help\` for options.
`;

const ACCOUNTS_USAGE = `agentvoice accounts — account profiles for multi-account balancing

A profile is a per-account CODEX_HOME under the state directory: its own
auth.json, everything else symlinked to the canonical ~/.codex so all
accounts share one session store. Enable selection with accounts.balance
in server.json.

Usage:
  agentvoice accounts add <slug>   Create a profile and log it in
                                   (runs codex login --device-auth inside it)
  agentvoice accounts list         Show profiles and their identities

The slug is a local label (lowercase letters, digits, hyphens) — pick one
per ChatGPT account, e.g. "personal" or "work".
`;

const SERVER_USAGE = `agentvoice server — start the voice server

Usage:
  agentvoice server [options]

Options (the full surface lives in server.json; see server.json.example
and server.schema.json):
  --config <path>          Config file (default: ~/.config/agentvoice/server.json)
  --model <id>             Orchestrator agent model (default: codex config)
  --effort <level>         Orchestrator agent reasoning effort (default: codex config)
  --voice-model <id>       Voice agent model (default: codex config)
  --voice <name>           Voice timbre (default: upstream default)
  --workspace <dir>        Orchestrator agent working directory
                           (default: ~/.local/state/agentvoice/workspace)
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
`;

const CLIENT_USAGE = `agentvoice client — open the terminal voice client

Usage:
  agentvoice client [options]

Options:
  --url <ws-url>           Server WebSocket (default: ${DEFAULT_CLIENT_URL})
  --token <secret>         Connection token (default: the server-written token file
                           in the state directory)
  --device <index>         Microphone device index (default: system default)
  --output-device <index>  Speaker device index (default: system default)
  --debug                  Write a debug log to the state directory

Keys: [m] mute mic · [s] mute speaker · [r] redial voice · [q] quit
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
  value: new Set(["--url", "--token", "--device", "--output-device"]),
  bool: new Set(["--debug", "--help"]),
};

export class UsageError extends Error {}

export interface ParsedArgs {
  values: Record<string, string>;
  configPath?: string;
  debug: boolean;
  help: boolean;
}

export type ParsedClientCommand = { help: true } | { help: false; config: ClientConfig };

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
    console.log(SERVER_USAGE);
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
  const command = parseClientArgs(argv);
  if (command.help) {
    console.log(CLIENT_USAGE);
    return 0;
  }
  await runClient(command.config);
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
      console.log("\nevery codex-swap account has a profile; restart the server to balance");
    }
    return 0;
  }

  throw new UsageError(`unknown accounts command "${subcommand}"`);
}

export function parseClientArgs(argv: string[]): ParsedClientCommand {
  const parsed = parseArgs(argv, CLIENT_FLAGS);
  if (parsed.help) return { help: true };

  const device = parsed.values["device"];
  const deviceIndex = device === undefined ? undefined : parseDeviceIndex("--device", device);
  const outputDevice = parsed.values["output-device"];
  const outputDeviceIndex =
    outputDevice === undefined ? undefined : parseDeviceIndex("--output-device", outputDevice);
  const token = parsed.values["token"];
  return {
    help: false,
    config: {
      url: parsed.values["url"] ?? DEFAULT_CLIENT_URL,
      ...(token !== undefined ? { token } : {}),
      ...(deviceIndex !== undefined ? { deviceIndex } : {}),
      ...(outputDeviceIndex !== undefined ? { outputDeviceIndex } : {}),
      debug: parsed.debug,
    },
  };
}

function parseDeviceIndex(flag: string, value: string): number {
  const index = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(index) || index > 0x7fffffff) {
    throw new UsageError(`${flag} must be a non-negative 32-bit integer; got "${value}"`);
  }
  return index;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }

  const commands: Record<string, { run: (argv: string[]) => Promise<number>; usage: string }> = {
    server: { run: runServerCommand, usage: SERVER_USAGE },
    client: { run: runClientCommand, usage: CLIENT_USAGE },
    accounts: { run: runAccountsCommand, usage: ACCOUNTS_USAGE },
  };
  const entry = commands[command];
  if (entry === undefined) {
    console.error(`unknown command "${command}"\n`);
    console.error(USAGE);
    return 2;
  }

  try {
    return await entry.run(argv.slice(1));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n`);
      console.error(entry.usage);
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
