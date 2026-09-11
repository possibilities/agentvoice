import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectMacApp,
  installMacApp,
  MACOS_APP_IDENTIFIER,
  MACOS_APP_INSTALLER,
  type MacAppChecks,
  preflightMacApp,
} from "../src/macos-app.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentvoice-macos-app-"));
  roots.push(root);
  const applications = join(root, "Applications");
  mkdirSync(applications);
  const running = new Set<string>();
  const checks: MacAppChecks = {
    plistValue(app, key) {
      return JSON.parse(readFileSync(join(app, "Contents", "Info.plist"), "utf8"))[key];
    },
    verifySignature(app) {
      if (readFileSync(join(app, "Contents", "MacOS", "AgentVoice"), "utf8") !== "signed")
        throw new Error("invalid signature");
    },
    running(executable) {
      return running.has(executable);
    },
  };
  function app(name: string, revision: string, values: Record<string, string> = {}) {
    const path = join(root, name);
    mkdirSync(join(path, "Contents", "MacOS"), { recursive: true });
    writeFileSync(
      join(path, "Contents", "Info.plist"),
      JSON.stringify({
        CFBundleIdentifier: MACOS_APP_IDENTIFIER,
        AgentVoiceInstaller: MACOS_APP_INSTALLER,
        AgentVoiceSourceRevision: revision,
        ...values,
      }),
    );
    writeFileSync(join(path, "Contents", "MacOS", "AgentVoice"), "signed", { mode: 0o755 });
    return path;
  }
  return { root, applications, checks, running, app };
}

const oldRevision = "1".repeat(40);
const newRevision = "2".repeat(40);

test("menu app ownership requires its exact identifier, marker, revision and signature", () => {
  const f = fixture();
  const app = f.app("AgentVoice.app", newRevision);
  expect(inspectMacApp(app, f.checks)?.revision).toBe(newRevision);
  writeFileSync(join(app, "Contents", "MacOS", "AgentVoice"), "modified");
  expect(() => inspectMacApp(app, f.checks)).toThrow("unrelated or modified");
  writeFileSync(join(app, "Contents", "MacOS", "AgentVoice"), "signed");
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    JSON.stringify({
      CFBundleIdentifier: "example.foreign",
      AgentVoiceInstaller: MACOS_APP_INSTALLER,
      AgentVoiceSourceRevision: newRevision,
    }),
  );
  expect(() => inspectMacApp(app, f.checks)).toThrow("unrelated or modified");
});

test("current menu app stays untouched while an obsolete running app is refused", () => {
  const f = fixture();
  const installed = f.app("Applications/AgentVoice.app", newRevision);
  f.running.add(join(installed, "Contents", "MacOS", "AgentVoice"));
  expect(preflightMacApp(installed, newRevision, f.checks)).toBe("current");
  writeFileSync(
    join(installed, "Contents", "Info.plist"),
    JSON.stringify({
      CFBundleIdentifier: MACOS_APP_IDENTIFIER,
      AgentVoiceInstaller: MACOS_APP_INSTALLER,
      AgentVoiceSourceRevision: oldRevision,
    }),
  );
  expect(() => preflightMacApp(installed, newRevision, f.checks)).toThrow("quit its menu");
});

test("menu app publication replaces only an owned stopped bundle", () => {
  const f = fixture();
  const installed = f.app("Applications/AgentVoice.app", oldRevision);
  const candidate = f.app("candidate.app", newRevision);
  expect(installMacApp(candidate, installed, newRevision, f.checks)).toBe("installed");
  expect(inspectMacApp(installed, f.checks)?.revision).toBe(newRevision);
  expect(existsSync(candidate)).toBe(true);
  expect(installMacApp(candidate, installed, newRevision, f.checks)).toBe("current");
});

test("menu app publication rechecks a stopped bundle after staging", () => {
  const f = fixture();
  const installed = f.app("Applications/AgentVoice.app", oldRevision);
  const candidate = f.app("candidate.app", newRevision);
  let runningChecks = 0;
  const checks: MacAppChecks = {
    ...f.checks,
    running() {
      runningChecks += 1;
      return runningChecks > 1;
    },
  };
  expect(() => installMacApp(candidate, installed, newRevision, checks)).toThrow("quit its menu");
  expect(inspectMacApp(installed, f.checks)?.revision).toBe(oldRevision);
  expect(existsSync(candidate)).toBe(true);
});

test("menu app publication restores the previous bundle when final verification fails", () => {
  const f = fixture();
  const installed = f.app("Applications/AgentVoice.app", oldRevision);
  const candidate = f.app("candidate.app", newRevision);
  let installedVerifications = 0;
  const checks: MacAppChecks = {
    ...f.checks,
    verifySignature(app) {
      f.checks.verifySignature(app);
      if (app === installed && ++installedVerifications > 2)
        throw new Error("fixture final verification failure");
    },
  };
  expect(() => installMacApp(candidate, installed, newRevision, checks)).toThrow(
    "unrelated or modified",
  );
  expect(inspectMacApp(installed, f.checks)?.revision).toBe(oldRevision);
  expect(existsSync(candidate)).toBe(true);
});
