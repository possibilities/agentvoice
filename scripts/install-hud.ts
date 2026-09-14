#!/usr/bin/env bun
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
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { checkoutHead, directory } from "./install.ts";

type Options = {
  root?: string;
  binDir?: string;
  stateDir?: string;
  prepare?: (root: string) => Promise<void>;
};

function cleanHead(root: string): string {
  const sha = checkoutHead(root);
  const state = Bun.spawnSync(
    ["git", "-C", root, "status", "--porcelain", "--untracked-files=all"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (state.exitCode !== 0 || state.stdout.toString().trim())
    throw new Error("HUD installation requires a clean committed checkout");
  directory(join(root, "src/hud"));
  const source = join(root, "src/hud/main.ts");
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
    throw new Error("Unsafe HUD command source");
  accessSync(source, constants.X_OK);
  return sha;
}

async function prepare(root: string): Promise<void> {
  for (const argv of [
    [process.execPath, "install", "--frozen-lockfile"],
    ["npm", "--prefix", "hud", "ci"],
    ["npm", "--prefix", "hud", "run", "build"],
  ]) {
    const process = Bun.spawn(argv, {
      cwd: root,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await process.exited) !== 0)
      throw new Error("HUD dependency/build preparation failed; command unchanged");
  }
}

/** Installs only the sibling Work command and prepared web assets. No runtime, media, or service calls. */
export async function installHud(
  options: Options = {},
): Promise<{ source: string; target: string; sha: string }> {
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0)
    throw new Error("Run HUD installation as the target user, not root");
  const root = realpathSync(options.root ?? dirname(import.meta.dir));
  const sha = cleanHead(root);
  const binDir =
    options.binDir ?? process.env["AGENTHUD_INSTALL_BIN_DIR"] ?? join(homedir(), ".local/bin");
  const stateDir =
    options.stateDir ??
    process.env["AGENTHUD_INSTALL_STATE_DIR"] ??
    join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local/state"), "agenthud");
  const source = join(root, "src/hud/main.ts");
  const target = join(binDir, "agenthud");
  const receipt = join(stateDir, "deployed-sha");
  function validate(): void {
    directory(binDir);
    directory(stateDir);
    const receiptStat = lstatSync(receipt, { throwIfNoEntry: false });
    let installedSha: string | undefined;
    if (receiptStat) {
      if (
        !receiptStat.isFile() ||
        receiptStat.uid !== uid ||
        receiptStat.nlink !== 1 ||
        (receiptStat.mode & 0o777) !== 0o600
      )
        throw new Error("Unsafe HUD install receipt");
      const text = readFileSync(receipt, "utf8");
      if (!/^[0-9a-f]{40}\n$/.test(text)) throw new Error("Malformed HUD install receipt");
      installedSha = text.trim();
    }
    const existing = lstatSync(target, { throwIfNoEntry: false });
    if (!existing) {
      if (installedSha) throw new Error("HUD receipt has no corroborating command");
      return;
    }
    if (!existing.isSymbolicLink() || existing.uid !== uid)
      throw new Error("Refusing unrelated agenthud command");
    const previous = readlinkSync(target);
    if (!isAbsolute(previous) || !previous.endsWith("/src/hud/main.ts"))
      throw new Error("Refusing unrelated agenthud link");
    const previousSha = checkoutHead(dirname(dirname(dirname(previous))));
    if (previous !== source && installedSha !== previousSha)
      throw new Error("Different HUD checkout requires its matching receipt");
  }
  validate();
  mkdirSync(binDir, { recursive: true, mode: 0o755 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  validate();
  const lock = join(stateDir, ".install-lock");
  mkdirSync(lock, { mode: 0o700 });
  let stage: string | undefined;
  let receiptStage: string | undefined;
  try {
    await (options.prepare ?? prepare)(root);
    if (cleanHead(root) !== sha)
      throw new Error("HUD source changed during preparation; command unchanged");
    validate();
    stage = mkdtempSync(join(binDir, ".agenthud-link-"));
    receiptStage = mkdtempSync(join(stateDir, ".agenthud-receipt-"));
    symlinkSync(source, join(stage, "command"));
    writeFileSync(join(receiptStage, "receipt"), `${sha}\n`, { mode: 0o600, flag: "wx" });
    renameSync(join(stage, "command"), target);
    renameSync(join(receiptStage, "receipt"), receipt);
    validate();
    return { source, target, sha };
  } finally {
    if (stage) rmSync(stage, { recursive: true });
    if (receiptStage) rmSync(receiptStage, { recursive: true });
    rmSync(lock, { recursive: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== "--install") {
    console.log(
      "Usage: scripts/install-hud.sh --install\nPrepare and install agenthud only; no services, voice runtime, or legacy data changes.",
    );
    process.exitCode = args[0] === "--help" || args[0] === "-h" ? 0 : 2;
  } else {
    try {
      const result = await installHud();
      console.log(
        `Installed ${result.target} -> ${result.source}\nPrepared HUD web assets. No services restarted.`,
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
