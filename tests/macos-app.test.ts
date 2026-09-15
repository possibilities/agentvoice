import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectMacApp,
  installMacApp,
  MACOS_APP_CONTROL_PROTOCOL,
  MACOS_APP_IDENTIFIER,
  MACOS_APP_INSTALLER,
  type MacAppChecks,
  type MacAppLifecycle,
  MacAppQuitFailure,
  preflightMacApp,
  quitMacAppForUpdate,
  relaunchMacApp,
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
  const quitRequests: Array<{ executable: string; revision: string }> = [];
  const launches: string[] = [];
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
  const lifecycle: MacAppLifecycle = {
    async requestQuit(executable, revision) {
      quitRequests.push({ executable, revision });
      running.delete(executable);
    },
    async launch(app) {
      launches.push(app);
      running.add(join(app, "Contents", "MacOS", "AgentVoice"));
    },
  };
  function app(name: string, revision: string, values: Record<string, string | undefined> = {}) {
    const path = join(root, name);
    mkdirSync(join(path, "Contents", "MacOS"), { recursive: true });
    writeFileSync(
      join(path, "Contents", "Info.plist"),
      JSON.stringify({
        CFBundleIdentifier: MACOS_APP_IDENTIFIER,
        AgentVoiceInstaller: MACOS_APP_INSTALLER,
        AgentVoiceSourceRevision: revision,
        AgentVoiceMenuControlProtocol: String(MACOS_APP_CONTROL_PROTOCOL),
        ...values,
      }),
    );
    writeFileSync(join(path, "Contents", "MacOS", "AgentVoice"), "signed", { mode: 0o755 });
    return path;
  }
  return { root, applications, checks, lifecycle, running, quitRequests, launches, app };
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
      AgentVoiceMenuControlProtocol: String(MACOS_APP_CONTROL_PROTOCOL),
    }),
  );
  expect(() => preflightMacApp(installed, newRevision, f.checks)).toThrow("rerun with --quit-menu");
});

test("explicit opt-in asks the exact supported running app to quit", async () => {
  const f = fixture();
  const installed = f.app("Applications/AgentVoice.app", oldRevision);
  const executable = join(installed, "Contents", "MacOS", "AgentVoice");
  f.running.add(executable);

  expect(await quitMacAppForUpdate(installed, newRevision, true, f.checks, f.lifecycle)).toBe(true);
  expect(f.quitRequests).toEqual([{ executable, revision: oldRevision }]);
  expect(f.running.has(executable)).toBe(false);
});

test("legacy running app needs one manual bootstrap quit", async () => {
  const f = fixture();
  const installed = f.app("Applications/AgentVoice.app", oldRevision, {
    AgentVoiceMenuControlProtocol: undefined,
  });
  f.running.add(join(installed, "Contents", "MacOS", "AgentVoice"));

  await expect(
    quitMacAppForUpdate(installed, newRevision, true, f.checks, f.lifecycle),
  ).rejects.toThrow("cannot quit itself for an update");
  expect(f.quitRequests).toEqual([]);
});

test("quit refusal and a premature success both preserve the running app", async () => {
  const f = fixture();
  const installed = f.app("Applications/AgentVoice.app", oldRevision);
  const executable = join(installed, "Contents", "MacOS", "AgentVoice");
  f.running.add(executable);
  const refusal: MacAppLifecycle = {
    ...f.lifecycle,
    async requestQuit() {
      throw new Error("menu is busy");
    },
  };
  await expect(
    quitMacAppForUpdate(installed, newRevision, true, f.checks, refusal),
  ).rejects.toThrow("menu is busy");
  expect(f.running.has(executable)).toBe(true);

  const premature: MacAppLifecycle = {
    ...f.lifecycle,
    async requestQuit() {},
  };
  await expect(
    quitMacAppForUpdate(installed, newRevision, true, f.checks, premature),
  ).rejects.toThrow("returned before the running app quit");
  expect(f.running.has(executable)).toBe(true);
});

test("a lost quit reply refuses even when the exact old executable exited", async () => {
  const f = fixture();
  const installed = f.app("Applications/AgentVoice.app", oldRevision);
  const executable = join(installed, "Contents", "MacOS", "AgentVoice");
  f.running.add(executable);
  const lostReply: MacAppLifecycle = {
    ...f.lifecycle,
    async requestQuit(path, revision) {
      f.quitRequests.push({ executable: path, revision });
      f.running.delete(path);
      throw new Error("connection closed before acknowledgement");
    },
  };

  try {
    await quitMacAppForUpdate(installed, newRevision, true, f.checks, lostReply);
    throw new Error("lost quit reply was accepted");
  } catch (error) {
    expect(error).toBeInstanceOf(MacAppQuitFailure);
    expect((error as MacAppQuitFailure).appStopped).toBe(true);
  }
  expect(f.quitRequests).toEqual([{ executable, revision: oldRevision }]);
});

test("absent and stopped apps need no quit, and relaunch uses the exact bundle path", async () => {
  const f = fixture();
  const installed = join(f.applications, "AgentVoice.app");
  expect(await quitMacAppForUpdate(installed, newRevision, true, f.checks, f.lifecycle)).toBe(
    false,
  );
  f.app("Applications/AgentVoice.app", oldRevision);
  expect(await quitMacAppForUpdate(installed, newRevision, true, f.checks, f.lifecycle)).toBe(
    false,
  );
  expect(f.quitRequests).toEqual([]);

  await relaunchMacApp(installed, f.checks, f.lifecycle);
  expect(f.launches).toEqual([installed]);
});

test("relaunch requires the exact installed executable to become observable", async () => {
  const f = fixture();
  const installed = f.app("Applications/AgentVoice.app", newRevision);
  const missingLaunch: MacAppLifecycle = {
    async requestQuit() {},
    async launch(app) {
      f.launches.push(app);
    },
    async wait() {},
  };
  await expect(relaunchMacApp(installed, f.checks, missingLaunch)).rejects.toThrow(
    "did not reopen before the launch timeout",
  );
  expect(f.launches).toEqual([installed]);
});

test("ownership refusal happens before any quit request", async () => {
  const f = fixture();
  const installed = f.app("Applications/AgentVoice.app", oldRevision, {
    CFBundleIdentifier: "example.foreign",
  });
  f.running.add(join(installed, "Contents", "MacOS", "AgentVoice"));
  await expect(
    quitMacAppForUpdate(installed, newRevision, true, f.checks, f.lifecycle),
  ).rejects.toThrow("unrelated or modified");
  expect(f.quitRequests).toEqual([]);
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
  expect(() => installMacApp(candidate, installed, newRevision, checks)).toThrow(
    "rerun with --quit-menu",
  );
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
