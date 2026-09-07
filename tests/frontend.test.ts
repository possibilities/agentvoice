import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuteGate } from "../src/console/audio-control.ts";
import { connectFrontend } from "../src/frontend/client.ts";
import {
  type FrontendState,
  frontendSocketPath,
  frontendState,
  frontendStateSchema,
} from "../src/frontend/protocol.ts";
import { type Call, VoiceServer } from "../src/frontend/server.ts";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}
function fakeCall(changed: () => void) {
  const mic = new MuteGate();
  const speaker = new MuteGate();
  let phase: FrontendState["phase"] = "waiting-ready";
  let starts = 0;
  let closes = 0;
  const call: Call = {
    state: () => ({ available: closes === 0, phase, mic: mic.state(), speaker: speaker.state() }),
    start: async () => {
      starts++;
      phase = "live";
      changed();
    },
    close: async () => {
      closes++;
      phase = "stopped";
    },
    command: (command) => {
      if (command.action === "mute")
        (command.target === "mic" ? mic : speaker).setMuted(command.muted);
      else if (command.action === "hold") mic.beginUnmute("frontend");
      else mic.releaseUnmute("frontend");
      changed();
    },
  };
  return { call, mic, speaker, starts: () => starts, closes: () => closes };
}

test("server waits, grants one call, releases PTT on disconnect and accepts a subsequent call", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-frontend-"));
  const path = frontendSocketPath(root, root);
  const calls: ReturnType<typeof fakeCall>[] = [];
  const server = new VoiceServer(path, async (changed) => {
    const call = fakeCall(changed);
    calls.push(call);
    return call.call;
  });
  let client: Awaited<ReturnType<typeof connectFrontend>> | undefined;
  let second: typeof client;
  try {
    await server.start();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(calls).toHaveLength(0);
    await expect(
      new VoiceServer(path, async () => {
        throw new Error("unreachable");
      }).start(),
    ).rejects.toThrow("owns");
    client = await connectFrontend(path);
    await until(() => client!.state().phase === "live");
    expect(calls).toHaveLength(1);
    await expect(connectFrontend(path)).rejects.toThrow("busy");
    client.command({ action: "mute", target: "mic", muted: true });
    await until(() => client!.state().mic.muted);
    client.command({ action: "hold" });
    await until(() => !client!.state().mic.effectiveMuted);
    await client.close();
    await until(() => calls[0]!.closes() === 1);
    expect(calls[0]!.mic.effectiveMuted).toBe(true);
    second = await connectFrontend(path);
    await until(() => second!.state().phase === "live");
    expect(calls).toHaveLength(2);
    await server.close();
    await second.done;
    expect(calls[1]!.closes()).toBe(1);
  } finally {
    await client?.close();
    await second?.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("disconnect during asynchronous call creation prevents startup and reserves the slot until cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-frontend-"));
  const created = Promise.withResolvers<Call>();
  const called = Promise.withResolvers<void>();
  const call = fakeCall(() => {});
  const server = new VoiceServer(frontendSocketPath(root, root), async () => {
    called.resolve();
    return created.promise;
  });
  try {
    await server.start();
    const client = await connectFrontend(server.path);
    await called.promise;
    await client.close();
    await Bun.sleep(10);
    await expect(connectFrontend(server.path)).rejects.toThrow("busy");
    created.resolve(call.call);
    await until(() => call.closes() === 1);
    expect(call.starts()).toBe(0);
  } finally {
    created.resolve(call.call);
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("disconnect interrupts activation and server waits for complete teardown", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-frontend-"));
  const boot = Promise.withResolvers<void>();
  const stopping = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const call = fakeCall(() => {});
  call.call.start = () => boot.promise;
  call.call.close = async () => {
    stopping.resolve();
    await stopped.promise;
    boot.resolve();
  };
  const server = new VoiceServer(frontendSocketPath(root, root), async () => call.call);
  try {
    await server.start();
    const client = await connectFrontend(server.path);
    await client.close();
    await stopping.promise;
    await expect(connectFrontend(server.path)).rejects.toThrow("busy");
    let closed = false;
    const closing = server.close().then(() => {
      closed = true;
    });
    await Bun.sleep(10);
    expect(closed).toBe(false);
    stopped.resolve();
    await closing;
  } finally {
    stopped.resolve();
    boot.resolve();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("frontend state projection excludes diagnostics, volume and native capabilities", () => {
  const state = {
    ...fakeCall(() => {}).call.state(),
    token: "secret",
    notice: "private",
    conversation: { threadId: "thread" },
    mic: { muted: true, effectiveMuted: true, db: 42 },
  };
  const projected = frontendState(state);
  expect(frontendStateSchema.parse(projected)).toEqual({
    available: true,
    phase: "waiting-ready",
    mic: { muted: true, effectiveMuted: true },
    speaker: { muted: false, effectiveMuted: false },
  });
  expect(JSON.stringify(projected)).not.toMatch(/secret|private|thread|42/);
});

test("server rejects invalid configuration before binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-waiting-"));
  const child = Bun.spawn(
    [
      process.execPath,
      "src/main.ts",
      "server",
      "--workspace",
      root,
      "--config",
      join(root, "config.json"),
      "--codex",
      "/must-not-launch-codex",
    ],
    {
      cwd: new URL("../", import.meta.url).pathname,
      env: { ...process.env, XDG_STATE_HOME: root },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  // Explicit config validation happens before binding, even without a frontend.
  try {
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("config");
  } finally {
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test("real server CLI waits without Codex or audio and removes its socket on termination", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "av-waiting-")));
  writeFileSync(join(root, "config.json"), "{}");
  const child = Bun.spawn(
    [
      process.execPath,
      "src/main.ts",
      "server",
      "--workspace",
      root,
      "--config",
      join(root, "config.json"),
      "--codex",
      "/must-not-launch-codex",
    ],
    {
      cwd: new URL("../", import.meta.url).pathname,
      env: { ...process.env, XDG_STATE_HOME: root },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const path = frontendSocketPath(join(root, "agentvoice"), root);
  try {
    await until(() => existsSync(path));
    expect(child.exitCode).toBeNull();
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toContain("server waiting");
    expect(await new Response(child.stderr).text()).toBe("");
    expect(existsSync(path)).toBe(false);
  } finally {
    child.kill();
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
});

test("server recovers a private stale socket left by an exited owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-stale-"));
  const path = join(root, "stale.sock");
  const stale = Bun.spawn(
    [
      process.execPath,
      "-e",
      'import { chmodSync } from "node:fs"; const path = process.env["STALE_SOCKET"]!; Bun.listen({ unix: path, socket: { data() {} } }); chmodSync(path, 0o600); console.log("bound");',
    ],
    {
      env: { ...process.env, STALE_SOCKET: path },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  await stale.stdout.getReader().read();
  stale.kill("SIGKILL");
  await stale.exited;
  const server = new VoiceServer(path, async (changed) => fakeCall(changed).call);
  try {
    expect(existsSync(path)).toBe(true);
    await server.start();
    const client = await connectFrontend(path);
    await until(() => client.state().phase === "live");
    await client.close();
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rejected startup cleans up and returns the server to waiting", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-failed-call-"));
  let attempts = 0;
  const errors: string[] = [];
  const server = new VoiceServer(
    frontendSocketPath(root, root),
    async (changed) => {
      const call = fakeCall(changed).call;
      if (++attempts === 1)
        call.start = async () => {
          throw new Error("startup refused");
        };
      return call;
    },
    (message) => errors.push(message),
  );
  try {
    await server.start();
    const first = await connectFrontend(server.path);
    await first.done;
    const second = await connectFrontend(server.path);
    await until(() => second.state().phase === "live");
    await second.close();
    expect(attempts).toBe(2);
    expect(errors).toEqual(["Call failed: Error: startup refused"]);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup failure prevents a new call even after the frontend disconnects", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-cleanup-failure-"));
  const errors: string[] = [];
  const server = new VoiceServer(
    frontendSocketPath(root, root),
    async (changed) => ({
      ...fakeCall(changed).call,
      close: async () => {
        throw new Error("owned child survived");
      },
    }),
    (message) => errors.push(message),
  );
  try {
    await server.start();
    const client = await connectFrontend(server.path);
    await until(() => client.state().phase === "live");
    await client.close();
    await until(() => errors.length === 1);
    await expect(connectFrontend(server.path)).rejects.toThrow("unavailable");
    expect(errors[0]).toContain("cleanup failed");
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
