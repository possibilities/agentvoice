import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export const MACOS_APP_IDENTIFIER = "io.arthack.agentvoice.menu";
export const MACOS_APP_INSTALLER = "agentvoice/scripts/install.sh";
export const MACOS_APP_NAME = "AgentVoice.app";

export interface MacAppInspection {
  executable: string;
  revision: string;
}

export interface MacAppChecks {
  plistValue(app: string, key: string): string;
  verifySignature(app: string): void;
  running(executable: string): boolean;
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
    checks.verifySignature(app);
    return { executable, revision };
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
): "missing" | "current" | "replace" {
  const existing = inspectMacApp(app, checks);
  if (!existing) return "missing";
  if (existing.revision === revision) return "current";
  if (checks.running(existing.executable))
    throw new Error("AgentVoice menu app is running; quit its menu before installation");
  return "replace";
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
