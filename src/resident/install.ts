/**
 * Installing and operating the resident app-server under launchd. AgentVoice
 * owns this plist as a deliberate fleet exception: the resident's spawn
 * contract (account pick, socket path, realtime flag) is this repo's own
 * load-bearing surface, so the LaunchAgent is rendered and versioned here
 * rather than in AgentStart.
 *
 * Everything the wrapper needs is resolved to an absolute path at install
 * time — launchd provides no shell environment, so PATH (for the balancer
 * CLIs), the bun binary, this checkout's entry point, and the codex binary
 * are all baked into the rendered files. Rerun install after moving any of
 * them.
 */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  accountsDirectory,
  discoverProfiles,
  reconcileFarm,
  runBalancerCommand,
  selectAccount,
} from "../core/accounts.ts";
import type { ServerConfig } from "../core/config.ts";
import {
  residentDirectory,
  residentSocketPath,
  residentStateFilePath,
  stateDirectory,
} from "../paths.ts";
import { RESIDENT_LABEL, readResidentState, residentArgv, writeResidentState } from "./contract.ts";

export class ResidentError extends Error {}

function guiDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new ResidentError("no uid; launchctl needs a gui domain");
  return `gui/${uid}`;
}

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${RESIDENT_LABEL}.plist`);
}

async function launchctl(args: string[]): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  const code = await child.exited;
  const output = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`;
  return { code, output };
}

function xmlEscape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

function renderWrapper(options: {
  bunBin: string;
  entry: string;
  pickLog: string;
  appServerCwd: string;
  codexBin: string;
  socketPath: string;
  explicitConfigPath?: string;
}): string {
  const pickArgs = [options.entry, "resident", "pick-home"];
  if (options.explicitConfigPath !== undefined) {
    pickArgs.push("--config", options.explicitConfigPath);
  }
  const pickCommand = [options.bunBin, ...pickArgs].map(shellQuote).join(" ");
  const execCommand = residentArgv(options.codexBin, options.socketPath).map(shellQuote).join(" ");
  return [
    "#!/bin/bash",
    "# Rendered by `agentvoice resident install` — do not edit; rerun install.",
    "set -u",
    // The pick is best-effort: an empty pick runs the canonical ~/.codex,
    // and the pick log carries the reason.
    `PICK="$(${pickCommand} 2>>${shellQuote(options.pickLog)})" || PICK=""`,
    'if [ -n "$PICK" ]; then',
    '  export CODEX_HOME="$PICK"',
    "fi",
    // app-server re-reads its own cwd on every thread start; this directory
    // must outlive the process.
    `/bin/mkdir -p ${shellQuote(options.appServerCwd)}`,
    `cd ${shellQuote(options.appServerCwd)}`,
    `exec ${execCommand}`,
    "",
  ].join("\n");
}

function renderPlist(options: { wrapperPath: string; logPath: string; path: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${RESIDENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${xmlEscape(options.wrapperPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(options.path)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(options.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(options.logPath)}</string>
</dict>
</plist>
`;
}

async function waitForSocket(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export async function installResident(
  config: ServerConfig,
  explicitConfigPath?: string,
): Promise<number> {
  const home = homedir();
  const residentDir = residentDirectory(process.env, home);
  mkdirSync(residentDir, { recursive: true, mode: 0o700 });
  const appServerCwd = join(stateDirectory(process.env, home), "app-server");
  mkdirSync(appServerCwd, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(plistPath()), { recursive: true });

  const codexBin = Bun.which(config.codex);
  if (!codexBin) {
    throw new ResidentError(
      `codex binary "${config.codex}" not found on PATH — install codex or set --codex/$CODEX_PATH`,
    );
  }
  const bunBin = process.execPath;
  const entry = fileURLToPath(new URL("../main.ts", import.meta.url));
  const socketPath = residentSocketPath(process.env, home);
  const wrapperPath = join(residentDir, "run.sh");
  const pickLog = join(residentDir, "pick.log");
  const logPath = join(residentDir, "resident.log");
  const path = process.env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin";

  writeFileSync(
    wrapperPath,
    renderWrapper({
      bunBin,
      entry,
      pickLog,
      appServerCwd,
      codexBin,
      socketPath,
      ...(explicitConfigPath !== undefined ? { explicitConfigPath } : {}),
    }),
  );
  chmodSync(wrapperPath, 0o700);
  writeFileSync(plistPath(), renderPlist({ wrapperPath, logPath, path }));

  const domain = guiDomain();
  await launchctl(["bootout", `${domain}/${RESIDENT_LABEL}`]); // idempotent reinstall
  const bootstrap = await launchctl(["bootstrap", domain, plistPath()]);
  if (bootstrap.code !== 0) {
    throw new ResidentError(`launchctl bootstrap failed: ${bootstrap.output.trim()}`);
  }
  await launchctl(["kickstart", `${domain}/${RESIDENT_LABEL}`]);

  console.log(`resident installed (${RESIDENT_LABEL})`);
  console.log(`  wrapper   ${wrapperPath}`);
  console.log(`  plist     ${plistPath()}`);
  console.log(`  codex     ${codexBin}`);
  console.log(`  socket    ${socketPath}`);
  if (await waitForSocket(socketPath, 15_000)) {
    const account = readResidentState(residentStateFilePath(process.env, home))?.account;
    console.log(`  running   yes (account: ${account ?? "canonical"})`);
    return 0;
  }
  console.error(`  running   no — socket never appeared; check ${logPath} and ${pickLog}`);
  return 1;
}

export async function residentStatus(): Promise<number> {
  const home = homedir();
  const plist = plistPath();
  const socket = residentSocketPath(process.env, home);
  const installed = existsSync(plist);
  console.log(`plist     ${installed ? plist : "(not installed — agentvoice resident install)"}`);
  if (!installed) return 1;
  const print = await launchctl(["print", `${guiDomain()}/${RESIDENT_LABEL}`]);
  if (print.code !== 0) {
    console.log("launchd   not loaded (launchctl bootstrap failed or booted out)");
  } else {
    const state = print.output.match(/state = (.+)/)?.[1]?.trim() ?? "unknown";
    const pid = print.output.match(/pid = (\d+)/)?.[1];
    console.log(`launchd   ${state}${pid ? ` (pid ${pid})` : ""}`);
  }
  console.log(`socket    ${existsSync(socket) ? socket : "(absent)"}`);
  const state = readResidentState(residentStateFilePath(process.env, home));
  if (state) {
    const picked = state.pickedAt > 0 ? new Date(state.pickedAt).toISOString() : "unknown";
    console.log(`account   ${state.account ?? "canonical"} (picked ${picked})`);
  } else {
    console.log("account   (no pick recorded yet)");
  }
  return existsSync(socket) ? 0 : 1;
}

export async function restartResident(): Promise<number> {
  const result = await launchctl(["kickstart", "-k", `${guiDomain()}/${RESIDENT_LABEL}`]);
  if (result.code !== 0) {
    throw new ResidentError(`launchctl kickstart failed: ${result.output.trim()}`);
  }
  console.log("resident restarting; the wrapper re-consults the balancer");
  return 0;
}

export async function uninstallResident(): Promise<number> {
  await launchctl(["bootout", `${guiDomain()}/${RESIDENT_LABEL}`]);
  rmSync(plistPath(), { force: true });
  console.log(`resident uninstalled (${RESIDENT_LABEL}); state directory left in place`);
  return 0;
}

/**
 * The wrapper's per-spawn account pick: consult the balancer, reconcile the
 * chosen profile's symlink farm, record the pick, and print the CODEX_HOME
 * to stdout — nothing for the canonical home. Errors degrade to canonical,
 * loudly on stderr (the wrapper routes it to pick.log).
 */
export async function runPickHome(config: ServerConfig): Promise<number> {
  const home = homedir();
  const residentDir = residentDirectory(process.env, home);
  mkdirSync(residentDir, { recursive: true, mode: 0o700 });
  const stateFile = residentStateFilePath(process.env, home);
  const log = (line: string) => console.error(`${new Date().toISOString()} ${line}`);

  let account: string | null = null;
  let codexHome: string | null = null;
  if (config.accounts.balance) {
    try {
      const selection = await selectAccount(
        discoverProfiles(accountsDirectory(process.env, home)),
        runBalancerCommand,
      );
      if (selection.kind === "canonical") {
        log(`canonical home fallback — ${selection.reason}`);
      } else {
        const canonicalHome = process.env["CODEX_HOME"] ?? join(home, ".codex");
        reconcileFarm(canonicalHome, selection.profile.directory, log);
        account = selection.email;
        codexHome = selection.profile.directory;
        log(`selected ${selection.email} (${selection.profile.slug}) — ${selection.reason}`);
      }
    } catch (error) {
      log(`balancer failed (${error instanceof Error ? error.message : String(error)}); canonical`);
    }
  }
  writeResidentState(stateFile, { account, codexHome, pickedAt: Date.now() });
  if (codexHome !== null) console.log(codexHome);
  return 0;
}
