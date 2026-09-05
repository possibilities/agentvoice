#!/usr/bin/env bun
/** Editable, command-only install. Never launches AgentVoice or changes Codex configuration. */
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
import { checkPrerequisites } from "./prerequisites.ts";

const root = realpathSync(dirname(import.meta.dir));
const uid = process.getuid?.();
const usage = `Usage: scripts/install.sh --install | --help

Install frozen dependencies, build native audio, and atomically link the editable
agentvoice command to this checkout. No services, configuration, login or audio use.
Requires a clean Git checkout, Bun 1.3+, stock Codex and a C11 compiler.

Destinations (absolute paths; no application-controlled symlink components):
  AGENTVOICE_INSTALL_BIN_DIR    default: ~/.local/bin
  AGENTVOICE_INSTALL_STATE_DIR  default: $XDG_STATE_HOME/agentvoice
                                      or ~/.local/state/agentvoice
Receipt: deployed-sha (the commit installed, not a pin on later source edits).
An unrelated existing command is never overwritten. No uninstall or migration.
`;

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

function directory(path: string): void {
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

function checkoutHead(checkout: string): string {
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

async function install(): Promise<void> {
  if (uid === undefined || uid === 0) refuse("run as the target user, not root (POSIX required)");
  checkPrerequisites();
  const sha = cleanHead();
  safeFile(join(root, "bun.lock"));
  safePath(join(root, "build", "native", `${process.platform}-${process.arch}`));
  const binDir = process.env["AGENTVOICE_INSTALL_BIN_DIR"] ?? join(homedir(), ".local/bin");
  const stateDir =
    process.env["AGENTVOICE_INSTALL_STATE_DIR"] ??
    join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local/state"), "agentvoice");
  directory(binDir);
  directory(stateDir);
  const target = join(binDir, "agentvoice");
  const source = join(root, "src/main.ts");
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

  validateDestination();
  mkdirSync(binDir, { recursive: true, mode: 0o755 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  validateDestination();
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
  try {
    await run([process.execPath, "install", "--frozen-lockfile"]);
    safePath(join(root, "build", "native", `${process.platform}-${process.arch}`));
    await run([process.execPath, "run", join(root, "scripts/build-native.ts")]);
    if (cleanHead() !== sha)
      refuse("checkout changed during installation; command link not changed");
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
    console.log(
      "No services, prompts, credentials or Codex settings changed. Launch separately with --allow-full-access.",
    );
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

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  console.log(usage);
} else if (args.length !== 1 || args[0] !== "--install") {
  console.error(usage);
  process.exitCode = 2;
} else {
  try {
    await install();
  } catch (error) {
    console.error(`agentvoice install: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
