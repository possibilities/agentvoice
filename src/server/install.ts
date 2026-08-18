/**
 * Installing and operating the Server under launchd, as the sibling of the
 * resident's LaunchAgent. The plist runs `agentvoice server run` directly —
 * there is no per-spawn pick here, so no wrapper script. Everything launchd
 * needs is resolved to an absolute path at install time (launchd provides no
 * shell environment); rerun install after moving the checkout or bun.
 *
 * Installing the Server ensures the resident is installed too: the pair is
 * the daemon contract, and a Server with no resident would only log reattach
 * failures.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "../core/config.ts";
import { controlSocketPath, serverDirectory } from "../paths.ts";
import {
  guiDomain,
  installResident,
  launchctl,
  residentInstalled,
  xmlEscape,
} from "../resident/install.ts";

export const SERVER_LABEL = "com.agentvoice.server";

export class ServerInstallError extends Error {}

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${SERVER_LABEL}.plist`);
}

function renderPlist(options: {
  bunBin: string;
  entry: string;
  runArgs: string[];
  logPath: string;
  path: string;
}): string {
  const programArguments = [options.bunBin, options.entry, "server", "run", ...options.runArgs]
    .map((argument) => `    <string>${xmlEscape(argument)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
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

/**
 * `runArgs` are the config-layer flags baked verbatim into the LaunchAgent
 * (`--config`, `--model`, …, `--debug`): the Server has no interactive CLI
 * moment, so overrides ride its spawn contract the way the resident's ride
 * its wrapper.
 */
export async function installServer(
  config: ServerConfig,
  runArgs: string[],
  explicitConfigPath?: string,
): Promise<number> {
  const home = homedir();
  if (!residentInstalled()) {
    console.log("resident not installed; installing it first");
    const residentExit = await installResident(config, explicitConfigPath);
    if (residentExit !== 0) return residentExit;
  }

  const serverDir = serverDirectory(process.env, home);
  mkdirSync(serverDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(plistPath()), { recursive: true });

  const bunBin = process.execPath;
  const entry = fileURLToPath(new URL("../main.ts", import.meta.url));
  const logPath = join(serverDir, "server.log");
  const socketPath = controlSocketPath(process.env, home);
  const path = process.env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin";

  writeFileSync(plistPath(), renderPlist({ bunBin, entry, runArgs, logPath, path }));

  const domain = guiDomain();
  await launchctl(["bootout", `${domain}/${SERVER_LABEL}`]); // idempotent reinstall
  const bootstrap = await launchctl(["bootstrap", domain, plistPath()]);
  if (bootstrap.code !== 0) {
    throw new ServerInstallError(`launchctl bootstrap failed: ${bootstrap.output.trim()}`);
  }
  await launchctl(["kickstart", `${domain}/${SERVER_LABEL}`]);

  console.log(`server installed (${SERVER_LABEL})`);
  console.log(`  plist     ${plistPath()}`);
  console.log(`  log       ${logPath}`);
  console.log(`  socket    ${socketPath}`);
  if (await waitForSocket(socketPath, 15_000)) {
    console.log("  running   yes");
    return 0;
  }
  console.error(`  running   no — control socket never appeared; check ${logPath}`);
  return 1;
}

export async function serverStatus(): Promise<number> {
  const home = homedir();
  const plist = plistPath();
  const socket = controlSocketPath(process.env, home);
  const installed = existsSync(plist);
  console.log(`plist     ${installed ? plist : "(not installed — agentvoice server install)"}`);
  if (!installed) return 1;
  const print = await launchctl(["print", `${guiDomain()}/${SERVER_LABEL}`]);
  if (print.code !== 0) {
    console.log("launchd   not loaded (launchctl bootstrap failed or booted out)");
  } else {
    const state = print.output.match(/state = (.+)/)?.[1]?.trim() ?? "unknown";
    const pid = print.output.match(/pid = (\d+)/)?.[1];
    console.log(`launchd   ${state}${pid ? ` (pid ${pid})` : ""}`);
  }
  console.log(`socket    ${existsSync(socket) ? socket : "(absent)"}`);
  console.log(
    `resident  ${residentInstalled() ? "installed" : "NOT installed — agentvoice resident install"}`,
  );
  return existsSync(socket) ? 0 : 1;
}

export async function restartServer(): Promise<number> {
  const result = await launchctl(["kickstart", "-k", `${guiDomain()}/${SERVER_LABEL}`]);
  if (result.code !== 0) {
    throw new ServerInstallError(`launchctl kickstart failed: ${result.output.trim()}`);
  }
  console.log("server restarting");
  return 0;
}

export async function uninstallServer(): Promise<number> {
  const domain = guiDomain();
  const bootout = await launchctl(["bootout", `${domain}/${SERVER_LABEL}`]);
  if (bootout.code !== 0) {
    // bootout also fails when the job simply isn't loaded; only a job that
    // is verifiably still loaded makes deleting its plist unsafe.
    const print = await launchctl(["print", `${domain}/${SERVER_LABEL}`]);
    if (print.code === 0) {
      throw new ServerInstallError(
        `launchctl bootout failed while the job is still loaded: ${bootout.output.trim()}`,
      );
    }
  }
  rmSync(plistPath(), { force: true });
  console.log(`server uninstalled (${SERVER_LABEL}); the resident is left installed`);
  return 0;
}
