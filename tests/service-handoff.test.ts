import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockFile } from "../src/core/thread-lock.ts";
import { SERVICE_LABEL, type ServiceOptions, servicePaths, VoiceService } from "../src/service.ts";
import {
  runInstallerHandoff,
  runServiceHandoff,
  type ServiceHandoffStatus,
  submitInstallerHandoff,
  submitServiceHandoff,
} from "../src/service-handoff.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a launchd-owned installer handoff accepts before caller exit and finishes independently", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "av-installer-handoff-")));
  roots.push(home);
  let releaseInitiator!: () => void;
  let installCalls = 0;
  let worker: Promise<ServiceHandoffStatus> | undefined;
  let requestPath: string | undefined;
  const options: ServiceOptions = {
    home,
    stateDir: join(home, "state"),
    uid: process.getuid!(),
    bun: process.execPath,
    entrypoint: join(import.meta.dir, "../src/main.ts"),
    env: {
      PATH: "/usr/bin:/bin",
      AGENTVOICE_INSTALL_STATE_DIR: join(home, "installer-state"),
      UNRELATED_SECRET: "do-not-forward",
    },
    packageRuntime: true,
    launchctl: async (args) => {
      if (args[0] === "submit") {
        requestPath = args.at(-1)!;
        worker = runInstallerHandoff(requestPath, {
          waitForInitiatorExit: () =>
            new Promise<void>((resolve) => {
              releaseInitiator = resolve;
            }),
          install: async (quitMenu) => {
            expect(quitMenu).toBe(true);
            installCalls++;
          },
        });
      }
      return { code: 0, out: "", err: "" };
    },
  };

  const outcome = await submitInstallerHandoff(options, SERVICE_LABEL, true);
  expect(outcome.kind).toBe("handedOff");
  expect(installCalls).toBe(0);
  expect(worker).toBeDefined();
  expect(readFileSync(requestPath!, "utf8")).not.toContain("UNRELATED_SECRET");
  expect(JSON.parse(readFileSync(outcome.statusPath, "utf8")).state).toBe("accepted");
  const installLock = join(home, "installer-state/.install-lock");
  expect(() => lockFile(installLock, "helper owns installer lock")).toThrow(
    "helper owns installer lock",
  );

  releaseInitiator();
  expect((await worker!).state).toBe("succeeded");
  expect(installCalls).toBe(1);
  lockFile(installLock, "installer lock was not released")();
});

test.skipIf(process.platform !== "darwin")(
  "a killed helper between bootout and bootstrap is resumed from its durable request",
  async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "av-service-handoff-recovery-")));
    roots.push(home);
    const stateFile = join(home, "launchd-state.json");
    const marker = join(home, "bootout-reached");
    const setLoaded = (loaded: boolean) => writeFileSync(stateFile, JSON.stringify({ loaded }));
    const isLoaded = () => JSON.parse(readFileSync(stateFile, "utf8")).loaded as boolean;
    setLoaded(false);
    let helper: ReturnType<typeof Bun.spawn> | undefined;
    let requestPath: string | undefined;
    const baseLaunchctl = async (args: string[]) => {
      if (args[0] === "print" && args[1]?.endsWith("/dev.agentvoice.default"))
        return { code: 113, out: "", err: "missing" };
      if (args[0] === "print")
        return isLoaded()
          ? {
              code: 0,
              out: `path = ${servicePaths(options).plist}\nstate = running\npid = 999999\n`,
              err: "",
            }
          : { code: 113, out: "", err: "missing" };
      if (args[0] === "bootout") setLoaded(false);
      if (args[0] === "bootstrap") setLoaded(true);
      return { code: 0, out: "", err: "" };
    };
    const options: ServiceOptions = {
      home,
      stateDir: join(home, "state"),
      uid: process.getuid!(),
      bun: process.execPath,
      entrypoint: join(import.meta.dir, "../src/main.ts"),
      env: { PATH: "/usr/bin:/bin" },
      packageRuntime: true,
      launchctl: baseLaunchctl,
    };
    await new VoiceService(options).change("install", { forceDirect: true });
    expect(isLoaded()).toBe(true);

    options.launchctl = async (args) => {
      if (args[0] !== "submit") return baseLaunchctl(args);
      requestPath = args.at(-1)!;
      helper = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
            const { readFileSync, writeFileSync } = await import("node:fs");
            const { runServiceHandoff } = await import(process.env.MODULE);
            const launchctl = async (args) => {
              const loaded = JSON.parse(readFileSync(process.env.STATE, "utf8")).loaded;
              if (args[0] === "print") return loaded
                ? { code: 0, out: "path = " + process.env.PLIST + "\\nstate = running\\npid = 999999\\n", err: "" }
                : { code: 113, out: "", err: "missing" };
              if (args[0] === "bootout") {
                writeFileSync(process.env.STATE, JSON.stringify({ loaded: false }));
                writeFileSync(process.env.MARKER, "reached");
                process.kill(process.pid, "SIGKILL");
                await new Promise(() => {});
              }
              if (args[0] === "bootstrap") writeFileSync(process.env.STATE, JSON.stringify({ loaded: true }));
              return { code: 0, out: "", err: "" };
            };
            await runServiceHandoff(process.env.REQUEST, { launchctl, waitForInitiatorExit: async () => {} });
          `,
        ],
        {
          env: {
            MODULE: join(import.meta.dir, "../src/service-handoff.ts"),
            STATE: stateFile,
            PLIST: servicePaths(options).plist,
            MARKER: marker,
            REQUEST: requestPath,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      return { code: 0, out: "", err: "" };
    };

    const outcome = await submitServiceHandoff(options, SERVICE_LABEL, "restart");
    expect(outcome.kind).toBe("handedOff");
    await helper!.exited;
    expect(existsSync(marker)).toBe(true);
    expect(isLoaded()).toBe(false);
    expect(JSON.parse(readFileSync(outcome.statusPath, "utf8")).state).toBe("running");

    const recovered = await runServiceHandoff(requestPath!, {
      launchctl: baseLaunchctl,
      waitForInitiatorExit: async () => {},
    });
    expect(recovered.state).toBe("succeeded");
    expect(recovered.snapshot?.state).toBe("running");
    expect(isLoaded()).toBe(true);
  },
  30_000,
);
