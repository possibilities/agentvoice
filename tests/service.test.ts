import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SERVICE_LABEL,
  type ServiceOptions,
  servicePaths,
  servicePlist,
  VoiceService,
} from "../src/service.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "av-service-")));
  roots.push(home);
  let loaded = false;
  let loadedPath: string | undefined;
  let failure: string | undefined;
  let failPublication = false;
  let delayUnload = false;
  let unregistering = 0;
  const calls: string[][] = [];
  const options: ServiceOptions = {
    home,
    stateDir: join(home, "state"),
    uid: process.getuid!(),
    bun: process.execPath,
    entrypoint: join(home, "checkout & spaces", "main.ts"),
    env: {
      PATH: "/tools:/usr/bin:/bin",
      CODEX_HOME: join(home, "codex home"),
      XDG_STATE_HOME: home,
      UNRELATED_SECRET: "must-not-copy",
    },
    launchctl: async (args) => {
      calls.push(args);
      if (args[0] === failure) {
        failure = undefined;
        return { code: 5, out: "", err: "injected failure" };
      }
      if (args[0] === "print" && args[1]?.endsWith("/dev.agentvoice.default"))
        return { code: 113, out: "", err: "Could not find service" };
      if (args[0] === "print")
        return loaded || unregistering-- > 0
          ? {
              code: 0,
              out: `path = ${loadedPath ?? servicePaths(options).plist}\nstate = running\npid = 123\n`,
              err: "",
            }
          : { code: 113, out: "", err: "Could not find service" };
      if (args[0] === "bootstrap") {
        if (unregistering > 0) return { code: 5, out: "", err: "job still unregistering" };
        chmodSync(servicePaths(options).directory, 0o755);
        loaded = true;
      }
      if (args[0] === "bootout") {
        loaded = false;
        if (delayUnload) unregistering = 2;
        if (failPublication) {
          failPublication = false;
          chmodSync(servicePaths(options).directory, 0o500);
        }
      }
      return { code: 0, out: "", err: "" };
    },
  };
  return {
    options,
    calls,
    service: new VoiceService(options),
    paths: servicePaths(options),
    loaded: () => loaded,
    delayUnload: () => {
      delayUnload = true;
    },
    failPublication: () => {
      failPublication = true;
    },
    fail: (command: string) => {
      failure = command;
    },
    foreign: () => {
      loaded = true;
      loadedPath = "/someone/else.plist";
    },
  };
}

test("plist has explicit argv, login lifecycle, private logs and only selected environment", () => {
  const f = fixture();
  const text = servicePlist(f.options);
  expect(text).toContain("checkout &amp; spaces");
  expect(text).toContain("<string>server</string></array>");
  expect(text).not.toContain("--workspace");
  expect(text).toContain("<key>KeepAlive</key><true/>");
  expect(text).toContain("<key>RunAtLoad</key><true/>");
  expect(text).toContain("<key>CODEX_HOME</key>");
  expect(text).not.toMatch(/UNRELATED_SECRET|must-not-copy/);
  expect(servicePlist({ ...f.options, env: {} })).not.toContain("CODEX_HOME");
  if (process.platform === "darwin") {
    const path = join(f.options.home, "test.plist");
    writeFileSync(path, text);
    const result = Bun.spawnSync(["/usr/bin/plutil", "-lint", path]);
    expect(result.exitCode, result.stdout.toString()).toBe(0);
  }
});

test("install, update, restart and removal operate only on the owned job; logs survive", async () => {
  const f = fixture();
  expect(await f.service.status()).toContain("not installed");
  await f.service.preflight();
  expect(existsSync(f.paths.directory)).toBe(false);
  await f.service.change("install");
  expect(f.loaded()).toBe(true);
  expect(await f.service.status()).toContain("running");
  expect(readFileSync(f.paths.plist, "utf8")).toBe(servicePlist(f.options));
  const log = join(f.paths.logs, "stderr.log");
  writeFileSync(log, "keep diagnostics");
  await f.service.change("install");
  await f.service.change("restart");
  expect(f.calls.filter((args) => args[0] === "bootout")).toEqual([
    ["bootout", `gui/${f.options.uid}/${SERVICE_LABEL}`],
    ["bootout", `gui/${f.options.uid}/${SERVICE_LABEL}`],
  ]);
  await f.service.change("remove");
  expect(f.loaded()).toBe(false);
  expect(existsSync(f.paths.plist)).toBe(false);
  expect(readFileSync(log, "utf8")).toBe("keep diagnostics");
  await f.service.change("remove");
});

test("failed registration restores prior plist and running job", async () => {
  const f = fixture();
  await f.service.change("install");
  const previous = readFileSync(f.paths.plist, "utf8");
  f.options.entrypoint = join(f.options.home, "new-checkout/main.ts");
  f.fail("bootstrap");
  await expect(f.service.change("install")).rejects.toThrow("injected failure");
  expect(readFileSync(f.paths.plist, "utf8")).toBe(previous);
  expect(f.loaded()).toBe(true);
});

test("failed first registration leaves no installed plist", async () => {
  const f = fixture();
  f.fail("bootstrap");
  await expect(f.service.change("install")).rejects.toThrow("injected failure");
  expect(existsSync(f.paths.plist)).toBe(false);
  expect(f.loaded()).toBe(false);
});

test("bootout failure preserves registration and prevents replacement or deletion", async () => {
  const f = fixture();
  await f.service.change("install");
  const previous = readFileSync(f.paths.plist, "utf8");
  f.fail("bootout");
  await expect(f.service.change("remove")).rejects.toThrow("injected failure");
  expect(readFileSync(f.paths.plist, "utf8")).toBe(previous);
  expect(f.loaded()).toBe(true);
});

test("unrelated loaded label is never stopped or adopted", async () => {
  const f = fixture();
  f.foreign();
  await expect(f.service.preflight()).rejects.toThrow("unrelated plist");
  await expect(f.service.change("install")).rejects.toThrow("unrelated plist");
  expect(f.calls.every((args) => args[0] === "print")).toBe(true);
});

test("edited and redirected plists and logs are refused before launchctl mutation", async () => {
  const f = fixture();
  await f.service.change("install");
  const original = readFileSync(f.paths.plist, "utf8");
  writeFileSync(f.paths.plist, original.replace("<true/>", "<false/>"));
  await expect(f.service.change("remove")).rejects.toThrow("edited LaunchAgent");
  writeFileSync(f.paths.plist, original);
  chmodSync(f.paths.plist, 0o644);
  await expect(f.service.preflight()).rejects.toThrow("Unsafe private file");
  chmodSync(f.paths.plist, 0o600);
  const path = join(f.paths.logs, "stderr.log");
  rmSync(path);
  symlinkSync(join(f.options.home, "unrelated.log"), path);
  await expect(f.service.preflight()).rejects.toThrow("Unsafe private file");
});

test("failed plist publication restores the previously running job", async () => {
  const f = fixture();
  await f.service.change("install");
  const previous = readFileSync(f.paths.plist, "utf8");
  f.failPublication();
  await expect(f.service.change("install")).rejects.toThrow();
  expect(readFileSync(f.paths.plist, "utf8")).toBe(previous);
  expect(f.loaded()).toBe(true);
});

test("restart checks persisted log destinations even when the invoking state directory changed", async () => {
  const f = fixture();
  await f.service.change("install");
  f.options.stateDir = join(f.options.home, "different-state");
  const path = join(f.paths.logs, "stderr.log");
  rmSync(path);
  symlinkSync(join(f.options.home, "unrelated.log"), path);
  const calls = f.calls.length;
  await expect(f.service.change("restart")).rejects.toThrow("Unsafe private file");
  expect(f.calls.slice(calls).every((args) => args[0] === "print")).toBe(true);
});

test("restart waits for launchd to unregister the old job before bootstrap", async () => {
  const f = fixture();
  await f.service.change("install");
  f.delayUnload();
  const start = f.calls.length;
  await f.service.change("restart");
  expect(f.loaded()).toBe(true);
  expect(f.calls.slice(start).map((args) => args[0])).toEqual([
    "print",
    "bootout",
    "print",
    "print",
    "print",
    "enable",
    "bootstrap",
  ]);
});

for (const failRegistration of [false, true])
  test(`rename preserves service ownership, failed registration=${failRegistration}`, async () => {
    const f = fixture();
    const oldLabel = "dev.agentvoice.default";
    const loaded = new Map<string, string>();
    const calls: string[][] = [];
    f.options.launchctl = async (args) => {
      calls.push(args);
      if (args[0] === "print") {
        const path = loaded.get(args[1]!);
        return path
          ? { code: 0, out: `path = ${path}\nstate = running\n`, err: "" }
          : { code: 113, out: "", err: "" };
      }
      if (args[0] === "bootout") loaded.delete(args[1]!);
      if (args[0] === "bootstrap") {
        if (failRegistration && args[2]?.endsWith(`${SERVICE_LABEL}.plist`))
          return { code: 5, out: "", err: "rename failed" };
        const label = args[2]!.endsWith(`${oldLabel}.plist`) ? oldLabel : SERVICE_LABEL;
        loaded.set(`gui/${f.options.uid}/${label}`, args[2]!);
      }
      return { code: 0, out: "", err: "" };
    };
    const old = new VoiceService(f.options, oldLabel);
    await old.change("install");
    const oldPath = servicePaths(f.options, oldLabel).plist;
    expect(existsSync(oldPath)).toBe(true);
    if (failRegistration) {
      await expect(f.service.change("install")).rejects.toThrow("rename failed");
      expect(existsSync(oldPath)).toBe(true);
      expect(loaded.has(`gui/${f.options.uid}/${oldLabel}`)).toBe(true);
      expect(existsSync(f.paths.plist)).toBe(false);
      return;
    }
    await f.service.change("install");
    expect(existsSync(oldPath)).toBe(false);
    expect(loaded.has(`gui/${f.options.uid}/${oldLabel}`)).toBe(false);
    expect(loaded.has(`gui/${f.options.uid}/${SERVICE_LABEL}`)).toBe(true);
    expect(
      calls.findIndex((args) => args[0] === "bootout" && args[1]?.endsWith(oldLabel)),
    ).toBeLessThan(
      calls.findIndex(
        (args) => args[0] === "bootstrap" && args[2]?.endsWith(`${SERVICE_LABEL}.plist`),
      ),
    );
  });

test("packaged LaunchAgent starts its microphone-entitled executable rather than shared Bun", () => {
  const f = fixture();
  f.options.packageRuntime = true;
  const plist = servicePlist(f.options);
  expect(plist).toContain("/runtime/AgentVoice.app/Contents/MacOS/agentvoice</string>");
  expect(plist).not.toContain(`<string>${f.options.bun}</string>`);
  expect(plist).toContain("<string>server</string>");
});

test.skipIf(process.platform !== "darwin")(
  "restart verifies the persisted packaged runtime even from a different XDG state root",
  async () => {
    const f = fixture();
    f.options.packageRuntime = true;
    await f.service.change("install");
    const info = join(f.paths.logs, "runtime/AgentVoice.app/Contents/Info.plist");
    writeFileSync(info, "modified bundle");
    f.options.stateDir = join(f.options.home, "different-state");
    const before = f.calls.length;
    await expect(f.service.change("restart")).rejects.toThrow(
      "modified AgentVoice service runtime",
    );
    expect(f.calls.slice(before).every((args) => args[0] === "print")).toBe(true);
  },
  30_000,
);
