import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ownedDirectory, safeAncestors } from "./private-files.ts";

export const SERVICE_RUNTIME_IDENTIFIER = "io.arthack.agentvoice";
export const SERVICE_RUNTIME_LOCAL_NETWORK_USAGE =
  "AgentVoice connects to trusted devices and development services on your local network when you ask it to.";
export function serviceRuntimeRoot(stateDir: string): string {
  return join(stateDir, "default", "service", "runtime");
}
export function serviceRuntimeExecutable(stateDir: string): string {
  return join(serviceRuntimeRoot(stateDir), "AgentVoice.app", "Contents", "MacOS", "agentvoice");
}
function digestFile(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(1 << 20);
  try {
    for (;;) {
      const count = readSync(fd, buffer);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
function inventory(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  function visit(relative: string) {
    const path = join(root, relative);
    const info = lstatSync(path);
    if (info.uid !== process.getuid?.() || info.isSymbolicLink() || info.mode & 0o022)
      throw new Error(`Unsafe AgentVoice runtime: ${path}`);
    if (info.isDirectory())
      for (const name of readdirSync(path).sort()) visit(join(relative, name));
    else if (info.isFile() && info.nlink === 1) files[relative] = digestFile(path);
    else throw new Error(`Unsafe AgentVoice runtime: ${path}`);
  }
  visit("AgentVoice.app");
  return files;
}

function assertPrivateStageTree(path: string): void {
  const info = lstatSync(path);
  if (
    info.uid !== process.getuid?.() ||
    info.isSymbolicLink() ||
    (info.mode & 0o022) !== 0 ||
    (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))
  )
    throw new Error(`Unsafe AgentVoice runtime stage: ${path}`);
  if (info.isDirectory())
    for (const name of readdirSync(path)) assertPrivateStageTree(join(path, name));
}

function checkRuntimeRoot(root: string): void {
  const names = readdirSync(root).sort();
  if (JSON.stringify(names) !== JSON.stringify(["AgentVoice.app", "receipt.json"]))
    throw new Error("Refusing unrelated AgentVoice service runtime");
  const receiptPath = join(root, "receipt.json");
  const info = lstatSync(receiptPath);
  if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || info.mode & 0o077)
    throw new Error("Unsafe AgentVoice runtime receipt");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (receipt.version !== 1 || JSON.stringify(receipt.files) !== JSON.stringify(inventory(root)))
    throw new Error("Refusing modified AgentVoice service runtime");
}

/** Called while the service-operation lock is held. */
export function cleanupStagedServiceRuntimes(stateDir: string): void {
  const parent = join(stateDir, "default", "service");
  ownedDirectory(parent);
  const stages = readdirSync(parent)
    .filter((name) => /^\.runtime-stage-[A-Za-z0-9]{6}$/.test(name))
    .map((name) => join(parent, name));
  for (const path of stages) assertPrivateStageTree(path);
  const recoverable = stages.filter((path) =>
    lstatSync(join(path, "previous"), { throwIfNoEntry: false }),
  );
  if (recoverable.length > 1)
    throw new Error("Multiple interrupted AgentVoice runtime publications require inspection");
  const interrupted = recoverable[0];
  if (interrupted) {
    const previous = join(interrupted, "previous");
    const root = serviceRuntimeRoot(stateDir);
    if (lstatSync(root, { throwIfNoEntry: false })) checkRuntimeRoot(root);
    else {
      checkRuntimeRoot(previous);
      renameSync(previous, root);
      checkRuntimeRoot(root);
    }
  }
  for (const path of stages) rmSync(path, { recursive: true });
}
export function checkServiceRuntime(stateDir: string): void {
  const root = serviceRuntimeRoot(stateDir);
  safeAncestors(root);
  if (!lstatSync(root, { throwIfNoEntry: false })) return;
  checkRuntimeRoot(root);
}

/** Stage only an owned copy of Bun. Never re-sign the package manager's executable. */
export function stageServiceRuntime(stateDir: string, bun: string) {
  checkServiceRuntime(stateDir);
  const parent = join(stateDir, "default", "service");
  ownedDirectory(parent);
  cleanupStagedServiceRuntimes(stateDir);
  const stage = mkdtempSync(join(parent, ".runtime-stage-"));
  const root = serviceRuntimeRoot(stateDir);
  const backup = join(stage, "previous");
  const candidate = join(stage, "next");
  let published = false;
  let movedPrevious = false;
  try {
    const app = join(candidate, "AgentVoice.app");
    const contents = join(app, "Contents");
    const executable = join(contents, "MacOS", "agentvoice");
    mkdirSync(join(contents, "MacOS"), { recursive: true, mode: 0o700 });
    copyFileSync(bun, executable);
    chmodSync(executable, 0o700);
    const entitlements = execFileSync("/usr/bin/codesign", ["-d", "--entitlements", ":-", bun], {
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
    const values = JSON.parse(
      execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], {
        input: entitlements,
      }).toString(),
    );
    values["com.apple.security.device.audio-input"] = true;
    const entitled = execFileSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", "--", "-"], {
      input: JSON.stringify(values),
    });
    const entitlementPath = join(stage, "entitlements.plist");
    writeFileSync(entitlementPath, entitled, { mode: 0o600 });
    writeFileSync(
      join(contents, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${SERVICE_RUNTIME_IDENTIFIER}</string>
<key>CFBundleName</key><string>AgentVoice</string>
<key>CFBundleDisplayName</key><string>AgentVoice</string>
<key>CFBundleExecutable</key><string>agentvoice</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
<key>NSMicrophoneUsageDescription</key><string>AgentVoice uses your microphone during voice calls that you start in its terminal frontend.</string>
<key>NSLocalNetworkUsageDescription</key><string>${SERVICE_RUNTIME_LOCAL_NETWORK_USAGE}</string>
</dict></plist>\n`,
      { mode: 0o600 },
    );
    // A stable explicit requirement keeps the local app identity across Bun updates.
    execFileSync(
      "/usr/bin/codesign",
      [
        "--force",
        "--sign",
        "-",
        "--options",
        "runtime",
        "--identifier",
        SERVICE_RUNTIME_IDENTIFIER,
        "--requirements",
        `=designated => identifier "${SERVICE_RUNTIME_IDENTIFIER}"`,
        "--entitlements",
        entitlementPath,
        app,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", app], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    writeFileSync(
      join(candidate, "receipt.json"),
      `${JSON.stringify({ version: 1, files: inventory(candidate) })}\n`,
      { mode: 0o600 },
    );
  } catch (error) {
    rmSync(stage, { recursive: true });
    throw error;
  }
  return {
    publish() {
      checkServiceRuntime(stateDir);
      if (lstatSync(root, { throwIfNoEntry: false })) {
        renameSync(root, backup);
        movedPrevious = true;
      }
      renameSync(candidate, root);
      published = true;
    },
    rollback() {
      if (published) {
        checkServiceRuntime(stateDir);
        renameSync(root, candidate);
        published = false;
      }
      if (movedPrevious) {
        renameSync(backup, root);
        movedPrevious = false;
      }
      rmSync(stage, { recursive: true });
    },
    commit() {
      rmSync(stage, { recursive: true });
    },
  };
}
