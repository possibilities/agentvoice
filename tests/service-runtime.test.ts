import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  checkServiceRuntime,
  serviceRuntimeExecutable,
  serviceRuntimeRoot,
  stageServiceRuntime,
} from "../src/service-runtime.ts";

const entitlements = (path: string) =>
  execFileSync("/usr/bin/codesign", ["-d", "--entitlements", ":-", path], {
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();

test.skipIf(process.platform !== "darwin")(
  "owned service runtime preserves Bun entitlements, adds microphone identity and rolls back updates",
  () => {
    const state = realpathSync(mkdtempSync("/tmp/av-signed-runtime-"));
    try {
      const sourceEntitlements = entitlements(process.execPath);
      const first = stageServiceRuntime(state, process.execPath);
      expect(existsSync(serviceRuntimeRoot(state))).toBe(false);
      first.publish();
      first.commit();
      checkServiceRuntime(state);
      const executable = serviceRuntimeExecutable(state);
      const signed = entitlements(executable);
      const values = JSON.parse(
        execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], {
          input: signed,
        }).toString(),
      );
      expect(values["com.apple.security.device.audio-input"]).toBe(true);
      expect(signed).toContain("com.apple.security.cs.allow-jit");
      expect(entitlements(process.execPath)).toBe(sourceEntitlements);
      const infoPath = join(serviceRuntimeRoot(state), "AgentVoice.app/Contents/Info.plist");
      const info = readFileSync(infoPath, "utf8");
      expect(info).toContain("NSMicrophoneUsageDescription");
      expect(info).toContain("io.arthack.agentvoice");
      const requirement = execFileSync("/usr/bin/codesign", ["-d", "-r-", executable], {
        stdio: ["ignore", "pipe", "pipe"],
      }).toString();
      expect(requirement).toContain('identifier "io.arthack.agentvoice"');
      // This exercises only executable packaging; no audio hardware or inference.
      expect(execFileSync(executable, ["--version"]).toString().trim()).toBe(Bun.version);
      const second = stageServiceRuntime(state, process.execPath);
      second.publish();
      second.rollback();
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
