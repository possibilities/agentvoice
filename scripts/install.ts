#!/usr/bin/env bun
/** Editable command and macOS waiting-server LaunchAgent installation. */
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import {
  inspectMacApp,
  installMacApp,
  MACOS_APP_NAME,
  type MacAppChecks,
  type MacAppLifecycle,
  MacAppQuitFailure,
  preflightMacApp,
  quitMacAppForUpdate,
  relaunchMacApp,
} from "../src/macos-app.ts";
import { serviceOptions, VoiceService } from "../src/service.ts";
import { checkPrerequisites } from "./prerequisites.ts";

const root = realpathSync(dirname(import.meta.dir));
const uid = process.getuid?.();
const usage = `Usage: scripts/install.sh --install [--quit-menu] [--menu-only | --command-only] | --help

Install frozen dependencies, build native audio, and atomically link the editable
agentvoice command to this checkout. On macOS also install AgentVoice.app and start
the default waiting-server LaunchAgent (replacing this installer's existing job).
No audio or Codex child opens until a frontend calls. --command-only skips the app
and service. --menu-only updates only the menu app and never restarts the server.
For an outdated running menu, --quit-menu asks the owned app to quit gracefully and
reopens it after publication. Requires a clean Git checkout, Bun 1.3+, stock Codex
and a C11 compiler for a full or command-only install.

Destinations (absolute paths; no application-controlled symlink components):
  AGENTVOICE_INSTALL_BIN_DIR    default: ~/.local/bin
  AGENTVOICE_INSTALL_STATE_DIR  default: $XDG_STATE_HOME/agentvoice
                                      or ~/.local/state/agentvoice
  AGENTVOICE_INSTALL_APP_DIR    default: ~/Applications (macOS only)
Receipt: deployed-sha (the commit installed, not a pin on later source edits).
An unrelated existing command is never overwritten. No uninstall or migration.
`;

export interface InstallOptions {
  appChecks?: MacAppChecks;
  appLifecycle?: MacAppLifecycle;
  menuOnly?: boolean;
  quitMenu?: boolean;
}

function info(path: string) {
  return lstatSync(path, { throwIfNoEntry: false });
}

function refuse(message: string): never {
  throw new Error(message);
}

function safePath(path: string): void {
  if (!isAbsolute(path) || path === "/" || normalize(path) !== path) {
    refuse(`unsafe path (use an absolute, normalized path): ${path}`);
  }
  let current = "";
  for (const component of path.slice(1).split("/")) {
    current += `/${component}`;
    const stat = info(current);
    if (!stat) continue;
    // macOS's system aliases are not user-controlled destination redirection.
    if (
      process.platform === "darwin" &&
      (current === "/tmp" || current === "/var") &&
      stat.isSymbolicLink() &&
      stat.uid === 0 &&
      realpathSync(current) === `/private${current}`
    )
      continue;
    if (!stat.isDirectory()) refuse(`non-directory or symlink path component: ${current}`);
    if (stat.uid !== uid && stat.uid !== 0) refuse(`foreign path component: ${current}`);
    const systemTemporary = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if ((stat.mode & 0o022) !== 0 && !systemTemporary) {
      refuse(`unsafe writable path component: ${current}`);
    }
  }
}

export function directory(path: string): void {
  safePath(path);
  const stat = info(path);
  if (stat && (stat.uid !== uid || (stat.mode & 0o022) !== 0)) {
    refuse(`foreign or unsafe writable directory: ${path}`);
  }
}

function safeFile(path: string): void {
  const stat = info(path);
  if (!stat?.isFile() || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
    refuse(`unsafe or foreign file: ${path}`);
  }
}

function git(checkout: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", checkout, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) refuse(`Git check failed: ${args[0]} in ${checkout}`);
  return result.stdout.toString().trim();
}

export function checkoutHead(checkout: string): string {
  directory(checkout);
  if (git(checkout, "rev-parse", "--show-toplevel") !== realpathSync(checkout)) {
    refuse(`source must be an exact Git checkout: ${checkout}`);
  }
  const origin = git(checkout, "remote", "get-url", "origin");
  if (
    !/^(https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)possibilities\/agentvoice(?:\.git)?\/?$/.test(
      origin,
    )
  ) {
    refuse(`foreign AgentVoice checkout origin: ${checkout}`);
  }
  safePath(join(checkout, "src"));
  const source = join(checkout, "src/main.ts");
  safeFile(source);
  accessSync(source, constants.X_OK);
  const sha = git(checkout, "rev-parse", "--verify", "HEAD");
  if (!/^[0-9a-f]{40}$/.test(sha)) refuse(`invalid checkout commit: ${checkout}`);
  return sha;
}

function cleanHead(): string {
  const sha = checkoutHead(root);
  if (git(root, "status", "--porcelain", "--untracked-files=all")) {
    refuse("checkout is dirty; commit or set aside source changes before installing");
  }
  return sha;
}

async function run(argv: string[]): Promise<void> {
  const child = Bun.spawn(argv, {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) refuse(`build/dependency step failed (exit ${code}); command link not changed`);
}

export async function install(
  serviceOverride?: VoiceService | false,
  appOverride?: boolean,
  options: InstallOptions = {},
): Promise<void> {
  if (uid === undefined || uid === 0) refuse("run as the target user, not root (POSIX required)");
  const menuOnly = options.menuOnly ?? false;
  if (!menuOnly) checkPrerequisites();
  const sha = cleanHead();
  if (!menuOnly) {
    safeFile(join(root, "bun.lock"));
    safePath(join(root, "build", "native", `${process.platform}-${process.arch}`));
  }
  const binDir = process.env["AGENTVOICE_INSTALL_BIN_DIR"] ?? join(homedir(), ".local/bin");
  const stateDir =
    process.env["AGENTVOICE_INSTALL_STATE_DIR"] ??
    join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local/state"), "agentvoice");
  if (!menuOnly) directory(binDir);
  directory(stateDir);
  const target = join(binDir, "agentvoice");
  const source = join(root, "src/main.ts");
  const service =
    menuOnly || serviceOverride === false
      ? undefined
      : (serviceOverride ??
        (process.platform === "darwin" ? new VoiceService(serviceOptions(source)) : undefined));
  const installApp =
    appOverride ?? (process.platform === "darwin" && (menuOnly || service !== undefined));
  if (menuOnly && !installApp) refuse("--menu-only requires macOS");
  const appDir = process.env["AGENTVOICE_INSTALL_APP_DIR"] ?? join(homedir(), "Applications");
  const app = join(appDir, MACOS_APP_NAME);
  let appDisposition: "missing" | "current" | "replace" | undefined;
  if (installApp) {
    directory(appDir);
    safePath(join(root, "build", "macos"));
    safePath(join(root, "dist"));
    for (const command of ["swift", "iconutil", "codesign"]) {
      if (!Bun.which(command)) refuse(`${command} is required to build AgentVoice.app`);
    }
    appDisposition = preflightMacApp(app, sha, options.appChecks, options.quitMenu);
  }
  await service?.preflight();
  const receipt = join(stateDir, "deployed-sha");

  function validateDestination(): void {
    directory(binDir);
    directory(stateDir);
    let receiptSha: string | undefined;
    const receiptStat = info(receipt);
    if (receiptStat) {
      safeFile(receipt);
      if (receiptStat.nlink !== 1 || (receiptStat.mode & 0o777) !== 0o600) {
        refuse(`unsafe deployed receipt: ${receipt}`);
      }
      const contents = readFileSync(receipt, "utf8");
      if (!/^[0-9a-f]{40}\n$/.test(contents)) refuse(`malformed deployed receipt: ${receipt}`);
      receiptSha = contents.trim();
    }
    const targetStat = info(target);
    if (!targetStat) {
      if (receiptSha) refuse(`uncorroborated deployed receipt: ${receipt}`);
      return;
    }
    if (!targetStat.isSymbolicLink() || targetStat.uid !== uid) {
      refuse(`refusing unrelated command: ${target}`);
    }
    const previous = readlinkSync(target);
    if (!isAbsolute(previous) || !previous.endsWith("/src/main.ts")) {
      refuse(`refusing unrelated command link: ${target}`);
    }
    const previousSha = checkoutHead(dirname(dirname(previous)));
    // The same editable checkout can advance after installation or recover from
    // interruption between link and receipt. Moving from another checkout needs proof.
    if (previous !== source && receiptSha !== previousSha) {
      refuse(`different checkout requires a matching deployed receipt: ${target}`);
    }
  }

  if (!menuOnly) validateDestination();
  if (!menuOnly) mkdirSync(binDir, { recursive: true, mode: 0o755 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (!menuOnly) validateDestination();
  const lock = join(stateDir, ".install-lock");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    refuse(
      `install lock exists or cannot be created: ${lock}; check for another installer before removing a stale lock`,
    );
  }
  let linkStage: string | undefined;
  let receiptStage: string | undefined;
  let menuWasRunning = false;
  let menuRestoreAttempted = false;
  try {
    if (!menuOnly) {
      await run([process.execPath, "install", "--frozen-lockfile"]);
      safePath(join(root, "build", "native", `${process.platform}-${process.arch}`));
      await run([process.execPath, "run", join(root, "scripts/build-native.ts")]);
    }
    if (installApp && appDisposition !== "current") {
      await run(["/bin/bash", join(root, "scripts/build-macos-app.sh")]);
    }
    if (cleanHead() !== sha)
      refuse("checkout changed during installation; command link not changed");
    if (installApp && appDisposition !== "current") {
      const candidate = inspectMacApp(join(root, "dist", MACOS_APP_NAME), options.appChecks);
      if (!candidate || candidate.revision !== sha)
        refuse("Built AgentVoice application does not match the source revision");
      try {
        menuWasRunning = await quitMacAppForUpdate(
          app,
          sha,
          options.quitMenu ?? false,
          options.appChecks,
          options.appLifecycle,
        );
      } catch (error) {
        if (error instanceof MacAppQuitFailure && error.appStopped) menuWasRunning = true;
        throw error;
      }
    }
    if (!menuOnly) {
      validateDestination();
      linkStage = mkdtempSync(join(binDir, ".agentvoice-link-"));
      receiptStage = mkdtempSync(join(stateDir, ".agentvoice-receipt-"));
      symlinkSync(source, join(linkStage, "command"));
      writeFileSync(join(receiptStage, "receipt"), `${sha}\n`, { mode: 0o600, flag: "wx" });
      renameSync(join(linkStage, "command"), target);
      renameSync(join(receiptStage, "receipt"), receipt);
      validateDestination();
      console.log(`Installed ${target} -> ${source}\nRecorded ${sha} in ${receipt}`);
      const onPath = Bun.which("agentvoice");
      if (!onPath || realpathSync(onPath) !== source) {
        console.warn(
          `PATH does not select this command${onPath ? ` (currently ${onPath})` : ""}; put ${binDir} first. No other command was changed.`,
        );
      }
    }
    if (installApp) {
      try {
        mkdirSync(appDir, { recursive: true, mode: 0o755 });
        directory(appDir);
        const result = installMacApp(
          join(root, "dist", MACOS_APP_NAME),
          app,
          sha,
          options.appChecks,
        );
        console.log(
          result === "current"
            ? `AgentVoice menu app is already current at ${app}`
            : `Installed ${app}`,
        );
      } catch (error) {
        throw new Error(
          `${menuOnly ? "Menu app installation failed" : "Command installed, but menu app installation failed"}: ${String(error)}`,
        );
      }
      if (menuWasRunning) {
        menuRestoreAttempted = true;
        try {
          await relaunchMacApp(app, options.appChecks, options.appLifecycle);
          console.log(`Reopened ${app}`);
        } catch (error) {
          throw new Error(`Installed ${app}, but could not reopen it: ${String(error)}`);
        }
      }
    }
    if (service) {
      try {
        await service.change("install");
      } catch (error) {
        throw new Error(`Command installed, but LaunchAgent installation failed: ${String(error)}`);
      }
      console.log(await service.status());
    }
    console.log(
      menuOnly
        ? "Updated the AgentVoice menu. The server and any call were left unchanged."
        : "No prompts, credentials or Codex settings changed. Connect with agentvoice.",
    );
  } catch (error) {
    if (installApp && menuWasRunning && !menuRestoreAttempted) {
      menuRestoreAttempted = true;
      try {
        await relaunchMacApp(app, options.appChecks, options.appLifecycle);
        console.warn("Menu update failed after quit; reopened the preserved AgentVoice menu app.");
      } catch (relaunchError) {
        throw new Error(
          `${String(error)}; the preserved menu app also could not be reopened: ${String(relaunchError)}`,
        );
      }
    }
    throw error;
  } finally {
    for (const [stage, name] of [
      [linkStage, "command"],
      [receiptStage, "receipt"],
    ] as const) {
      if (!stage) continue;
      if (info(join(stage, name))) unlinkSync(join(stage, name));
      rmdirSync(stage);
    }
    rmdirSync(lock);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(usage);
  } else if (args[0] !== "--install") {
    console.error(usage);
    process.exitCode = 2;
  } else {
    const flags = args.slice(1);
    const unique = new Set(flags);
    const commandOnly = unique.has("--command-only");
    const menuOnly = unique.has("--menu-only");
    const quitMenu = unique.has("--quit-menu");
    if (
      unique.size !== flags.length ||
      [...unique].some(
        (flag) => !["--command-only", "--menu-only", "--quit-menu"].includes(flag),
      ) ||
      (commandOnly && menuOnly) ||
      (commandOnly && quitMenu)
    ) {
      console.error(usage);
      process.exitCode = 2;
    } else {
      try {
        await install(
          commandOnly || menuOnly ? false : undefined,
          commandOnly ? false : undefined,
          {
            menuOnly,
            quitMenu,
          },
        );
      } catch (error) {
        console.error(
          `agentvoice install: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
      }
    }
  }
}
