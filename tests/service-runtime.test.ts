import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  checkServiceRuntime,
  cleanupStagedServiceRuntimes,
  SERVICE_RUNTIME_IDENTIFIER,
  SERVICE_RUNTIME_LOCAL_NETWORK_USAGE,
  serviceRuntimeExecutable,
  serviceRuntimeRoot,
  stageServiceRuntime,
} from "../src/service-runtime.ts";

const entitlements = (path: string) =>
  execFileSync("/usr/bin/codesign", ["-d", "--entitlements", ":-", path], {
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();

test("stale runtime stages are removed only after private-tree validation", () => {
  const state = realpathSync(mkdtempSync("/tmp/av-runtime-stage-cleanup-"));
  const parent = join(state, "default/service");
  try {
    const safe = join(parent, ".runtime-stage-a1B2c3");
    mkdirSync(join(safe, "next"), { recursive: true, mode: 0o700 });
    writeFileSync(join(safe, "next/partial"), "staged", { mode: 0o644 });
    cleanupStagedServiceRuntimes(state);
    expect(existsSync(safe)).toBe(false);

    const unsafe = join(parent, ".runtime-stage-d4E5f6");
    mkdirSync(unsafe, { mode: 0o700 });
    symlinkSync(join(state, "outside"), join(unsafe, "redirect"));
    expect(() => cleanupStagedServiceRuntimes(state)).toThrow("Unsafe AgentVoice runtime stage");
    expect(existsSync(unsafe)).toBe(true);

    rmSync(unsafe, { recursive: true });
    const ambiguous = join(parent, ".runtime-stage-g7H8i9");
    mkdirSync(join(ambiguous, "previous"), { recursive: true, mode: 0o700 });
    expect(() => cleanupStagedServiceRuntimes(state)).toThrow(
      "unrelated AgentVoice service runtime",
    );
    expect(existsSync(ambiguous)).toBe(true);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin")(
  "owned service runtime preserves Bun entitlements and privacy identity across publication",
  () => {
    const state = realpathSync(mkdtempSync("/tmp/av-signed-runtime-"));
    try {
      const sourceEntitlements = entitlements(process.execPath);
      const sourceValues = JSON.parse(
        execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], {
          input: sourceEntitlements,
        }).toString(),
      );
      const first = stageServiceRuntime(state, process.execPath);
      expect(existsSync(serviceRuntimeRoot(state))).toBe(false);
      const firstStage = readdirSync(join(state, "default/service")).find((name) =>
        name.startsWith(".runtime-stage-"),
      );
      expect(firstStage).toBeDefined();
      const preparedInfoPath = join(
        state,
        "default/service",
        firstStage!,
        "next/AgentVoice.app/Contents/Info.plist",
      );
      const preparedInfo = readFileSync(preparedInfoPath, "utf8");
      expect(preparedInfo).toContain("NSLocalNetworkUsageDescription");
      expect(preparedInfo).toContain(SERVICE_RUNTIME_LOCAL_NETWORK_USAGE);
      expect(preparedInfo).toContain(SERVICE_RUNTIME_IDENTIFIER);
      first.publish();
      first.commit();
      checkServiceRuntime(state);
      const interrupted = join(state, "default/service/.runtime-stage-rEc0vR");
      mkdirSync(interrupted, { mode: 0o700 });
      renameSync(serviceRuntimeRoot(state), join(interrupted, "previous"));
      cleanupStagedServiceRuntimes(state);
      expect(existsSync(interrupted)).toBe(false);
      checkServiceRuntime(state);
      const executable = serviceRuntimeExecutable(state);
      const signed = entitlements(executable);
      const values = JSON.parse(
        execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], {
          input: signed,
        }).toString(),
      );
      expect(values).toEqual({
        ...sourceValues,
        "com.apple.security.device.audio-input": true,
      });
      expect(signed).toContain("com.apple.security.cs.allow-jit");
      expect(entitlements(process.execPath)).toBe(sourceEntitlements);
      const infoPath = join(serviceRuntimeRoot(state), "AgentVoice.app/Contents/Info.plist");
      const info = readFileSync(infoPath, "utf8");
      expect(info).toBe(preparedInfo);
      expect(info).toContain("NSMicrophoneUsageDescription");
      expect(info).toContain("NSLocalNetworkUsageDescription");
      expect(info).toContain(SERVICE_RUNTIME_LOCAL_NETWORK_USAGE);
      expect(info).toContain(SERVICE_RUNTIME_IDENTIFIER);
      const requirement = execFileSync("/usr/bin/codesign", ["-d", "-r-", executable], {
        stdio: ["ignore", "pipe", "pipe"],
      }).toString();
      expect(requirement).toContain('identifier "io.arthack.agentvoice"');
      // This exercises only executable packaging; no audio hardware or inference.
      expect(execFileSync(executable, ["--version"]).toString().trim()).toBe(Bun.version);
      const second = stageServiceRuntime(state, process.execPath);
      second.publish();
      const parent = join(state, "default/service");
      const secondStage = readdirSync(parent).find((name) => name.startsWith(".runtime-stage-"));
      expect(secondStage).toBeDefined();
      unlinkSync(join(parent, secondStage!, "previous/receipt.json"));
      cleanupStagedServiceRuntimes(state);
      checkServiceRuntime(state);
      const third = stageServiceRuntime(state, process.execPath);
      third.publish();
      third.rollback();
      checkServiceRuntime(state);
      expect(readFileSync(infoPath, "utf8")).toBe(info);
      writeFileSync(infoPath, "changed locally");
      expect(() => checkServiceRuntime(state)).toThrow("modified AgentVoice");
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  },
  30_000,
);
