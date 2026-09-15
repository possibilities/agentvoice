import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export const MACOS_APP_IDENTIFIER = "io.arthack.agentvoice.menu";
export const MACOS_APP_INSTALLER = "agentvoice/scripts/install.sh";
export const MACOS_APP_NAME = "AgentVoice.app";
export const MACOS_APP_CONTROL_PROTOCOL = 1;
const MACOS_APP_CONTROL_TIMEOUT_MS = 7_000;
const MACOS_APP_LAUNCH_TIMEOUT_MS = 5_000;

export interface MacAppInspection {
  controlProtocol?: number;
  executable: string;
  revision: string;
}

export interface MacAppChecks {
  plistValue(app: string, key: string): string;
  verifySignature(app: string): void;
  running(executable: string): boolean;
}

export interface MacAppLifecycle {
  requestQuit(executable: string, revision: string): Promise<void>;
  launch(app: string): Promise<void>;
  wait?(milliseconds: number): Promise<void>;
}

export class MacAppQuitFailure extends Error {
  constructor(
    message: string,
    readonly appStopped: boolean,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}

const defaultChecks: MacAppChecks = {
  plistValue(app, key) {
    return execFileSync(
      "/usr/bin/plutil",
      ["-extract", key, "raw", "-o", "-", join(app, "Contents", "Info.plist")],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
      .toString()
      .trim();
  },
  verifySignature(app) {
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", app], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const requirement = spawnSync("/usr/bin/codesign", ["-dr", "-", app], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    if (
      requirement.status !== 0 ||
      !`${requirement.stdout ?? ""}\n${requirement.stderr ?? ""}`
        .split("\n")
        .some((line) => line.trim() === `designated => identifier "${MACOS_APP_IDENTIFIER}"`)
    ) {
      throw new Error("unexpected application signing requirement");
    }
  },
  running(executable) {
    const result = spawnSync("/usr/sbin/lsof", ["-t", executable], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    throw new Error("Could not determine whether the AgentVoice menu app is running", {
      cause: result.error,
    });
  },
};

const defaultLifecycle: MacAppLifecycle = {
  async requestQuit(executable, revision) {
    const result = spawnSync(
      executable,
      ["--menu-control", "quit-for-update", "--expected-revision", revision, "--json"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: MACOS_APP_CONTROL_TIMEOUT_MS,
      },
    );
    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
        throw new Error("AgentVoice menu did not quit before the update timeout");
      }
      throw new Error(`Could not ask the AgentVoice menu to quit: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || "menu control request failed").trim();
      throw new Error(`AgentVoice menu refused to quit for update: ${detail}`);
    }
  },
  async launch(app) {
    const result = spawnSync("/usr/bin/open", ["-g", app], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) {
      const detail =
        result.error?.message ?? (result.stderr || result.stdout || "open failed").trim();
      throw new Error(`Could not reopen the AgentVoice menu: ${detail}`);
    }
  },
  wait: Bun.sleep,
};

function ownedDirectory(path: string): void {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (
    !info?.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o022) !== 0
  ) {
    throw new Error(`Refusing unsafe or foreign AgentVoice application: ${path}`);
  }
}

function ownedFile(path: string): void {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.nlink !== 1 ||
    (info.mode & 0o022) !== 0
  ) {
    throw new Error(`Refusing unsafe or foreign AgentVoice application file: ${path}`);
  }
}

export function inspectMacApp(
  app: string,
  checks: MacAppChecks = defaultChecks,
): MacAppInspection | undefined {
  if (!lstatSync(app, { throwIfNoEntry: false })) return;
  ownedDirectory(app);
  ownedDirectory(join(app, "Contents"));
  ownedDirectory(join(app, "Contents", "MacOS"));
  const executable = join(app, "Contents", "MacOS", "AgentVoice");
  ownedFile(join(app, "Contents", "Info.plist"));
  ownedFile(executable);
  try {
    if (checks.plistValue(app, "CFBundleIdentifier") !== MACOS_APP_IDENTIFIER)
      throw new Error("unexpected bundle identifier");
    if (checks.plistValue(app, "AgentVoiceInstaller") !== MACOS_APP_INSTALLER)
      throw new Error("missing installer marker");
    const revision = checks.plistValue(app, "AgentVoiceSourceRevision");
    if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("invalid source revision");
    let controlProtocol: number | undefined;
    try {
      const raw = checks.plistValue(app, "AgentVoiceMenuControlProtocol");
      if (/^[1-9][0-9]*$/.test(raw)) controlProtocol = Number(raw);
    } catch {
      // Existing AgentVoice releases predate installer-controlled menu lifecycle.
    }
    checks.verifySignature(app);
    return { controlProtocol, executable, revision };
  } catch (error) {
    throw new Error(`Refusing unrelated or modified AgentVoice application: ${app}`, {
      cause: error,
    });
  }
}

export function preflightMacApp(
  app: string,
  revision: string,
  checks: MacAppChecks = defaultChecks,
  quitMenu = false,
): "missing" | "current" | "replace" {
  const existing = inspectMacApp(app, checks);
  if (!existing) return "missing";
  if (existing.revision === revision) return "current";
  if (checks.running(existing.executable)) {
    if (!quitMenu)
      throw new Error(
        "AgentVoice menu app is running; choose Quit AgentVoice menu or rerun with --quit-menu",
      );
    if (existing.controlProtocol !== MACOS_APP_CONTROL_PROTOCOL) {
      throw new Error(
        "This AgentVoice menu version cannot quit itself for an update. Choose Quit AgentVoice menu, then run the installer again",
      );
    }
  }
  return "replace";
}

export async function quitMacAppForUpdate(
  app: string,
  revision: string,
  quitMenu: boolean,
  checks: MacAppChecks = defaultChecks,
  lifecycle: MacAppLifecycle = defaultLifecycle,
): Promise<boolean> {
  const disposition = preflightMacApp(app, revision, checks, quitMenu);
  if (disposition !== "replace") return false;
  const existing = inspectMacApp(app, checks)!;
  if (!checks.running(existing.executable)) return false;
  try {
    await lifecycle.requestQuit(existing.executable, existing.revision);
  } catch (error) {
    throw new MacAppQuitFailure(
      error instanceof Error ? error.message : String(error),
      !checks.running(existing.executable),
      error,
    );
  }
  if (checks.running(existing.executable)) {
    throw new Error("AgentVoice menu control returned before the running app quit");
  }
  return true;
}

export async function relaunchMacApp(
  app: string,
  checks: MacAppChecks = defaultChecks,
  lifecycle: MacAppLifecycle = defaultLifecycle,
): Promise<void> {
  const installed = inspectMacApp(app, checks);
  if (!installed) throw new Error("Cannot reopen a missing AgentVoice menu app");
  await lifecycle.launch(app);
  const interval = 100;
  for (let elapsed = 0; elapsed <= MACOS_APP_LAUNCH_TIMEOUT_MS; elapsed += interval) {
    if (checks.running(installed.executable)) return;
    if (elapsed < MACOS_APP_LAUNCH_TIMEOUT_MS) {
      await (lifecycle.wait?.(interval) ?? Bun.sleep(interval));
    }
  }
  throw new Error("AgentVoice menu did not reopen before the launch timeout");
}

export function installMacApp(
  candidate: string,
  app: string,
  revision: string,
  checks: MacAppChecks = defaultChecks,
): "current" | "installed" {
  if (preflightMacApp(app, revision, checks) === "current") return "current";
  const inspectedCandidate = inspectMacApp(candidate, checks);
  if (!inspectedCandidate || inspectedCandidate.revision !== revision)
    throw new Error("Built AgentVoice application does not match the source revision");

  const stage = mkdtempSync(join(dirname(app), ".agentvoice-app-install-"));
  const next = join(stage, MACOS_APP_NAME);
  const previous = join(stage, "previous.app");
  let movedPrevious = false;
  let published = false;
  try {
    cpSync(candidate, next, { recursive: true, verbatimSymlinks: true });
    const copied = inspectMacApp(next, checks);
    if (!copied || copied.revision !== revision)
      throw new Error("Copied AgentVoice application failed verification");
    // Close the launch/tampering window while the candidate was copied. A
    // concurrently installed current app wins; a newly running old app or an
    // unrelated destination must remain untouched.
    if (preflightMacApp(app, revision, checks) === "current") return "current";
    if (lstatSync(app, { throwIfNoEntry: false })) {
      renameSync(app, previous);
      movedPrevious = true;
    }
    renameSync(next, app);
    published = true;
    const installed = inspectMacApp(app, checks);
    if (!installed || installed.revision !== revision)
      throw new Error("Installed AgentVoice application failed verification");
    return "installed";
  } catch (error) {
    if (published && lstatSync(app, { throwIfNoEntry: false })) renameSync(app, next);
    if (movedPrevious) renameSync(previous, app);
    throw error;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
