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

const IDENTIFIER = "io.arthack.agentvoice";
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
export function checkServiceRuntime(stateDir: string): void {
  const root = serviceRuntimeRoot(stateDir);
  safeAncestors(root);
  if (!lstatSync(root, { throwIfNoEntry: false })) return;
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

/** Stage only an owned copy of Bun. Never re-sign the package manager's executable. */
export function stageServiceRuntime(stateDir: string, bun: string) {
  checkServiceRuntime(stateDir);
  const parent = join(stateDir, "default", "service");
  ownedDirectory(parent);
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
<key>CFBundleIdentifier</key><string>${IDENTIFIER}</string>
<key>CFBundleName</key><string>AgentVoice</string>
<key>CFBundleDisplayName</key><string>AgentVoice</string>
<key>CFBundleExecutable</key><string>agentvoice</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
<key>NSMicrophoneUsageDescription</key><string>AgentVoice uses your microphone during voice calls that you start in its terminal frontend.</string>
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
        IDENTIFIER,
        "--requirements",
        `=designated => identifier "${IDENTIFIER}"`,
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
