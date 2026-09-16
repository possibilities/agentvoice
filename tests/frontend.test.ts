import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuteGate } from "../src/console/audio-control.ts";
import { saveSessionMarker } from "../src/core/session-marker.ts";
import { connectFrontend } from "../src/frontend/client.ts";
import { observeFrontend } from "../src/frontend/observer.ts";
import {
  type FrontendState,
  frontendSocketPath,
  frontendState,
  frontendStateSchema,
} from "../src/frontend/protocol.ts";
import { type Call, VoiceServer } from "../src/frontend/server.ts";
import { ControlSocket, SocketFailure } from "../src/ipc/control-client.ts";
import { currentWorkspace } from "../src/workspace.ts";

async function until(predicate: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}
function fakeCall(changed: () => void) {
  const mic = new MuteGate();
  const speaker = new MuteGate();
  let phase: FrontendState["phase"] = "waiting-ready";
  let starts = 0;
  let closes = 0;
  const attachments: boolean[] = [];
  const call: Call = {
    state: () => ({
      available: closes === 0,
      codingActivity: "unknown" as const,
      phase,
      mic: mic.state(),
      speaker: speaker.state(),
    }),
    start: async () => {
      starts++;
      phase = "live";
      changed();
    },
    close: async () => {
      closes++;
      phase = "stopped";
    },
    setFrontendAttached: async (attached) => {
      attachments.push(attached);
      if (!attached) mic.releaseUnmute("frontend");
      changed();
    },
    command: (command) => {
      if (command.action === "mute")
        (command.target === "mic" ? mic : speaker).setMuted(command.muted);
      else if (command.action === "hold") mic.beginUnmute("frontend");
      else mic.releaseUnmute("frontend");
      changed();
    },
  };
  return { call, mic, speaker, attachments, starts: () => starts, closes: () => closes };
}

test("server retains one call across frontend reconnects, releases PTT, and closes it once", async () => {
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
    await until(() => calls[0]!.attachments.includes(false));
    expect(calls[0]!.mic.effectiveMuted).toBe(true);
    expect(calls[0]!.closes()).toBe(0);
    second = await connectFrontend(path);
    await until(() => second!.state().phase === "live");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.starts()).toBe(1);
    expect(calls[0]!.attachments).toEqual([true, false, true]);
    await server.close();
    await second.done;
    expect(calls[0]!.closes()).toBe(1);
  } finally {
    await client?.close();
    await second?.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("server restores native work before a frontend and later attaches media to the same call", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-frontend-restore-"));
  const path = frontendSocketPath(root, root);
  const calls: ReturnType<typeof fakeCall>[] = [];
  const server = new VoiceServer(path, async (changed) => {
    const fake = fakeCall(changed);
    calls.push(fake);
    return {
      ...fake.call,
      identity: () => ({ workspace: root, threadId: "saved-thread" }),
    };
  });
  let client: Awaited<ReturnType<typeof connectFrontend>> | undefined;
  try {
    await server.start();
    await server.restoreWorkspaceSession();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.starts()).toBe(1);
    expect(calls[0]!.attachments).toEqual([]);
    expect(calls[0]!.closes()).toBe(0);

    client = await connectFrontend(path);
    await until(() => client!.state().phase === "live");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.starts()).toBe(1);
    expect(calls[0]!.attachments).toEqual([true]);
    await client.close();
    await until(() => calls[0]!.attachments.at(-1) === false);
    expect(calls[0]!.closes()).toBe(0);
  } finally {
    await client?.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup disconnect retains its call and a later frontend reuses it", async () => {
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
    await expect(
      connectFrontend(server.path, () => {}, undefined, { timeoutMs: 20 }),
    ).rejects.toThrow("cleanup");
    created.resolve(call.call);
    await until(() => call.attachments.includes(false));
    expect(call.starts()).toBe(1);
    expect(call.closes()).toBe(0);
    const second = await connectFrontend(server.path);
    await until(() => second.state().phase === "live");
    expect(call.attachments).toEqual([false, true]);
    await second.close();
    await until(() => call.attachments.at(-1) === false);
    expect(call.closes()).toBe(0);
    await server.close();
    expect(call.closes()).toBe(1);
  } finally {
    created.resolve(call.call);
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a frontend can retry call creation after the factory rejects", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-create-retry-"));
  const errors: string[] = [];
  let attempts = 0;
  const successful = fakeCall(() => {});
  const server = new VoiceServer(
    frontendSocketPath(root, root),
    async () => {
      if (++attempts === 1) throw new Error("temporary creation failure");
      return successful.call;
    },
    (message) => errors.push(message),
  );
  try {
    await server.start();
    const first = await connectFrontend(server.path);
    await first.done;
    await until(() => errors.some((message) => message.includes("temporary creation failure")));

    const second = await connectFrontend(server.path);
    await until(() => second.state().phase === "live");
    expect(attempts).toBe(2);
    expect(successful.starts()).toBe(1);
    await second.close();
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("server shutdown waits for call creation and closes the late call without attaching it", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-create-shutdown-"));
  const creating = Promise.withResolvers<Call>();
  const entered = Promise.withResolvers<void>();
  const call = fakeCall(() => {});
  const server = new VoiceServer(frontendSocketPath(root, root), async () => {
    entered.resolve();
    return creating.promise;
  });
  try {
    await server.start();
    const client = await connectFrontend(server.path);
    await entered.promise;
    let finished = false;
    const closing = server.close().then(() => {
      finished = true;
    });
    await client.done;
    await Bun.sleep(10);
    expect(finished).toBe(false);
    creating.resolve(call.call);
    await closing;
    expect(call.attachments).toEqual([false]);
    expect(call.attachments).not.toContain(true);
    expect(call.starts()).toBe(0);
    expect(call.closes()).toBe(1);
    expect(existsSync(server.path)).toBe(false);
  } finally {
    creating.resolve(call.call);
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("disconnect waits for media detach while server shutdown closes the retained call", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-frontend-"));
  const boot = Promise.withResolvers<void>();
  const stopping = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const call = fakeCall(() => {});
  call.call.start = () => boot.promise;
  call.call.setFrontendAttached = async (attached) => {
    call.attachments.push(attached);
    if (attached) return;
    stopping.resolve();
    await stopped.promise;
    boot.resolve();
  };
  const server = new VoiceServer(frontendSocketPath(root, root), async () => call.call);
  try {
    await server.start();
    const client = await connectFrontend(server.path);
    await until(() => call.attachments.includes(true));
    await client.close();
    await stopping.promise;
    await expect(
      connectFrontend(server.path, () => {}, undefined, { timeoutMs: 20 }),
    ).rejects.toThrow("cleanup");
    let closed = false;
    const closing = server.close().then(() => {
      closed = true;
    });
    await Bun.sleep(10);
    expect(closed).toBe(false);
    stopped.resolve();
    await closing;
    expect(call.attachments).toEqual([true, false]);
    expect(call.closes()).toBe(1);
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
    codingActivity: "unknown" as const,
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

test("real default server restores a marked conversation before any media client connects", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "av-server-restore-")));
  const stateDir = join(root, "state", "agentvoice");
  const workspace = currentWorkspace(stateDir);
  const threadId = "saved-conversation";
  const configPath = join(root, "server.json");
  const auditPath = join(workspace, "native-audit.jsonl");
  writeFileSync(configPath, "{}");
  writeFileSync(
    join(workspace, "native-threads.json"),
    JSON.stringify([
      {
        id: threadId,
        cwd: workspace,
        threadSource: "agentvoice-orchestrator",
        parentThreadId: null,
        status: { type: "idle" },
      },
    ]),
  );
  saveSessionMarker(workspace, threadId);
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("../src/main.ts", import.meta.url).pathname,
      "server",
      "--config",
      configPath,
      "--codex",
      join(import.meta.dir, "fixtures/controller-codex.ts"),
    ],
    {
      cwd: root,
      env: { ...process.env, XDG_STATE_HOME: join(root, "state") },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const path = frontendSocketPath(stateDir);
  let observer: Awaited<ReturnType<typeof observeFrontend>> | undefined;
  let client: Awaited<ReturnType<typeof connectFrontend>> | undefined;
  let latest: Parameters<Parameters<typeof observeFrontend>[1]>[0] | undefined;
  try {
    await until(() => existsSync(path), 10_000);
    observer = await observeFrontend(path, (state) => {
      latest = state;
    });
    latest = observer.initial;
    await until(() => latest?.threadId === threadId && latest.generation === 1, 15_000);
    expect(latest).toMatchObject({
      availability: "idle",
      busy: false,
      workspace,
      threadId,
      generation: 1,
      state: null,
    });
    const beforeAttachment = readFileSync(auditPath, "utf8");
    expect(beforeAttachment).toContain('"method":"thread/read"');
    expect(beforeAttachment).toContain('"method":"thread/resume"');
    expect(beforeAttachment).not.toContain('"method":"thread/start"');
    expect(beforeAttachment).not.toContain('"method":"thread/realtime/start"');

    client = await connectFrontend(path);
    await until(() => latest?.availability === "connected");
    expect(latest).toMatchObject({ workspace, threadId, generation: 1 });
    expect(readFileSync(auditPath, "utf8")).not.toContain('"method":"thread/start"');
  } finally {
    await client?.close();
    observer?.socket.close();
    child.kill("SIGTERM");
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);

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

test("a rejected retained startup detaches the frontend without creating a replacement call", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-failed-call-"));
  let attempts = 0;
  let retained: ReturnType<typeof fakeCall> | undefined;
  const errors: string[] = [];
  const server = new VoiceServer(
    frontendSocketPath(root, root),
    async (changed) => {
      retained = fakeCall(changed);
      const call = retained.call;
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
    await until(() => errors.some((message) => message.includes("Frontend attachment failed")));
    expect(retained?.attachments).toEqual([true, false]);
    const second = await connectFrontend(server.path);
    await second.done;
    expect(attempts).toBe(1);
    expect(errors).toContain("Session startup failed: Error: startup refused");
    expect(errors).toContain("Frontend attachment failed: Error: startup refused");
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("media detach failure poisons admission while retaining workspace work", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-cleanup-failure-"));
  const errors: string[] = [];
  const server = new VoiceServer(
    frontendSocketPath(root, root),
    async (changed) => ({
      ...fakeCall(changed).call,
      setFrontendAttached: async (attached) => {
        if (!attached) throw new Error("media peer survived");
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
    expect(errors[0]).toContain("Media detach failed; workspace work is retained");
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("API restart retains the call and a disconnect during replacement leaves it reusable", async () => {
  const { RuntimeController } = await import("../src/runtime-control/controller.ts");
  const { parseArgs } = await import("../src/main.ts");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "av-frontend-restart-")));
  const replacement = Promise.withResolvers<void>();
  const entering = Promise.withResolvers<void>();
  const commands: Array<{ incarnation: number; method: string; params: unknown }> = [];
  let controller!: InstanceType<typeof RuntimeController>;
  let closed = false;
  const server = new VoiceServer(frontendSocketPath(root, root), async (changed) => {
    controller = new RuntimeController({
      instanceId: "frontend-restart",
      stateDir: root,
      provenance: {
        parsed: parseArgs([]),
        options: { debug: false },
        launchCwd: root,
      },
      version: "test",
      control: { name: "agentvoice_control", tools: [], server: {}, env: {} },
      lease: () => () => {},
      changed,
      frontendAttached: false,
      spawn: (incarnation, event, lease) => ({
        pid: incarnation,
        nativePid: undefined,
        exited: Promise.resolve(),
        notify: (method, params) => commands.push({ incarnation, method, params }),
        stop: async () => false,
        request: async <T>(method: string, params: unknown): Promise<T> => {
          commands.push({ incarnation, method, params });
          if (method === "preflight") return { workspace: root, buildId: "fake" } as T;
          if (method === "activate") {
            if (incarnation === 3) {
              entering.resolve();
              await replacement.promise;
            }
            await lease("same-thread");
            event("identity", { workspace: root, threadId: "same-thread" });
            event("state", {
              available: true,
              codingActivity: "unknown" as const,
              phase: "live",
              mic: { muted: true, effectiveMuted: true },
              speaker: { muted: false, effectiveMuted: false },
            });
          }
          return null as T;
        },
      }),
    });
    return {
      state: () => controller.state(),
      start: () => controller.start(),
      close: async () => {
        await controller.shutdown();
        closed = true;
      },
      setFrontendAttached: (attached) => controller.setFrontendAttached(attached),
      command: (command) => {
        if (command.action === "mute")
          (command.target === "mic" ? controller.microphone : controller.speaker).setMuted(
            command.muted,
          );
        else if (command.action === "hold") controller.microphone.beginUnmute("frontend");
        else controller.microphone.releaseUnmute("frontend");
        controller.syncMute();
      },
    };
  });
  let client: Awaited<ReturnType<typeof connectFrontend>> | undefined;
  let successor: Awaited<ReturnType<typeof connectFrontend>> | undefined;
  try {
    await server.start();
    client = await connectFrontend(server.path);
    await until(() => client!.state().phase === "live");
    client.command({ action: "mute", target: "mic", muted: true });
    await until(() => client!.state().mic.muted);
    client.command({ action: "hold" });
    await until(() => !client!.state().mic.effectiveMuted);
    const restart = (operationId: string) =>
      controller.restart({
        operationId,
        expectedInstanceId: controller.status().instanceId,
        expectedGeneration: controller.status().generation,
        scope: "runtime",
      });
    await restart("keep-frontend");
    await until(() => controller.status().currentOperation?.phase === "ready");
    await until(() => client!.state().phase === "live" && client!.state().mic.effectiveMuted);
    expect(controller.status()).toMatchObject({ generation: 2, threadId: "same-thread" });
    expect(controller.microphone.holding).toBe(false);
    expect(
      commands.find((command) => command.incarnation === 2 && command.method === "activate")
        ?.params,
    ).toEqual({
      threadId: "same-thread",
      frontendAttached: true,
      mute: { mic: true, speaker: false },
      routingIdentity: {
        controllerId: "frontend-restart",
        generation: 2,
        processInstanceId: "frontend-restart:2",
        buildId: "fake",
      },
    });
    expect(closed).toBe(false);
    client.command({ action: "mute", target: "speaker", muted: true });
    await until(() => controller.speaker.muted);
    const replacing = restart("disconnect-during-restart");
    await entering.promise;
    await client.close();
    expect(closed).toBe(false);
    successor = await connectFrontend(server.path);
    replacement.resolve();
    await replacing;
    await until(() => controller.status().currentOperation?.phase === "ready");
    expect(closed).toBe(false);
    expect(controller.status().currentOperation?.phase).toBe("ready");
    expect(
      commands.some(
        (command) =>
          command.incarnation === 3 &&
          command.method === "frontend" &&
          (command.params as { attached?: boolean }).attached === false,
      ),
    ).toBe(true);
    await until(() => successor!.state().phase === "live");
    expect(controller.status()).toMatchObject({ generation: 3, threadId: "same-thread" });
    await successor.close();
    await server.close();
    expect(closed).toBe(true);
  } finally {
    replacement.resolve();
    await client?.close();
    await successor?.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("default server CLI creates its generation and waits on the stable endpoint from any cwd", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "av-default-waiting-")));
  writeFileSync(join(root, "config.json"), "{}");
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("../src/main.ts", import.meta.url).pathname,
      "server",
      "--config",
      join(root, "config.json"),
      "--codex",
      "/must-not-launch-codex",
    ],
    { cwd: root, env: { ...process.env, XDG_STATE_HOME: root }, stdout: "pipe", stderr: "pipe" },
  );
  const path = frontendSocketPath(join(root, "agentvoice"));
  try {
    await until(() => existsSync(path));
    expect(child.exitCode).toBeNull();
    const { currentWorkspace } = await import("../src/workspace.ts");
    expect(currentWorkspace(join(root, "agentvoice"))).toContain("/default/workspaces/");
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    expect(existsSync(path)).toBe(false);
  } finally {
    child.kill();
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
});

test("clients wait for media detach, compete for one attachment, and never replace retained work", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-cleanup-"));
  const stopping = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  let calls = 0;
  const server = new VoiceServer(frontendSocketPath(root), async (changed) => {
    const fake = fakeCall(changed);
    if (++calls === 1)
      fake.call.setFrontendAttached = async (attached) => {
        fake.attachments.push(attached);
        if (attached) return;
        stopping.resolve();
        await cleanup.promise;
      };
    return fake.call;
  });
  const clients: Awaited<ReturnType<typeof connectFrontend>>[] = [];
  try {
    await server.start();
    const first = await connectFrontend(server.path);
    await first.close();
    await stopping.promise;
    const abort = new AbortController();
    const waiting = Promise.withResolvers<void>();
    const cancelled = connectFrontend(server.path, () => {}, undefined, {
      signal: abort.signal,
      waiting: waiting.resolve,
    });
    const rejected = cancelled.catch((error: Error) => error);
    await waiting.promise;
    abort.abort();
    expect(await rejected).toBeInstanceOf(Error);
    expect(((await rejected) as Error).message).toContain("cancelled");
    expect(calls).toBe(1);

    const waitingA = Promise.withResolvers<void>();
    const waitingB = Promise.withResolvers<void>();
    const results = Promise.allSettled([
      connectFrontend(server.path, () => {}, undefined, { waiting: waitingA.resolve }),
      connectFrontend(server.path, () => {}, undefined, { waiting: waitingB.resolve }),
    ]);
    await Promise.all([waitingA.promise, waitingB.promise]);
    expect(calls).toBe(1);
    cleanup.resolve();
    const settled = await results;
    for (const result of settled) if (result.status === "fulfilled") clients.push(result.value);
    expect(clients).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(calls).toBe(1);
  } finally {
    cleanup.resolve();
    for (const client of clients) await client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("media detach failure makes waiting clients fail without replacing retained work", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-cleanup-failure-"));
  const stopping = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  let calls = 0;
  const server = new VoiceServer(
    frontendSocketPath(root),
    async (changed) => {
      calls++;
      const fake = fakeCall(changed);
      fake.call.setFrontendAttached = async (attached) => {
        fake.attachments.push(attached);
        if (attached) return;
        stopping.resolve();
        await cleanup.promise;
        throw new Error("media detach failed");
      };
      return fake.call;
    },
    () => {},
  );
  try {
    await server.start();
    const first = await connectFrontend(server.path);
    await first.close();
    await stopping.promise;
    const waiting = Promise.withResolvers<void>();
    const next = connectFrontend(server.path, () => {}, undefined, { waiting: waiting.resolve });
    const rejected = next.catch((error: Error) => error);
    await waiting.promise;
    cleanup.resolve();
    expect(await rejected).toBeInstanceOf(Error);
    expect(((await rejected) as Error).message).toContain("unavailable");
    expect(calls).toBe(1);
  } finally {
    cleanup.resolve();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto takeover fences the old owner, serializes contenders, and preserves retained work", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-auto-takeover-"));
  const cleanupStarted = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const retained = fakeCall(() => {});
  let creates = 0;
  const server = new VoiceServer(frontendSocketPath(root), async () => {
    creates++;
    return {
      ...retained.call,
      identity: () => ({ workspace: root, threadId: "retained-thread", generation: 7 }),
      setFrontendAttached: async (attached) => {
        retained.attachments.push(attached);
        if (!attached) {
          cleanupStarted.resolve();
          await cleanup.promise;
        }
      },
    };
  });
  let owner: Awaited<ReturnType<typeof connectFrontend>> | undefined;
  let automatic: ControlSocket | undefined;
  let competingAutomatic: ControlSocket | undefined;
  let confirmer: ControlSocket | undefined;
  let observer: Awaited<ReturnType<typeof observeFrontend>> | undefined;
  const availability: string[] = [];
  try {
    await server.start();
    observer = await observeFrontend(server.path, (state) => availability.push(state.availability));
    owner = await connectFrontend(server.path);
    await until(() => owner!.state().phase === "live");
    owner.command({ action: "mute", target: "mic", muted: true });
    await until(() => retained.mic.muted);
    owner.command({ action: "hold" });
    await until(() => !retained.mic.effectiveMuted);

    automatic = await ControlSocket.connect(server.path, 3);
    const takeover = automatic.request(
      "call",
      { clientId: crypto.randomUUID(), takeover: "auto" },
      30_000,
    );
    await cleanupStarted.promise;
    await owner.done;
    expect(retained.mic.effectiveMuted).toBe(true);

    await expect(automatic.request("observe")).rejects.toThrow(
      "Call owners cannot become observers",
    );
    confirmer = await ControlSocket.connect(server.path, 3);
    await expect(
      confirmer.request("call", { clientId: crypto.randomUUID(), takeover: "confirm" }),
    ).rejects.toMatchObject({ code: "takeover_in_progress" });
    competingAutomatic = await ControlSocket.connect(server.path, 3);
    await expect(
      competingAutomatic.request("call", {
        clientId: crypto.randomUUID(),
        takeover: "auto",
      }),
    ).rejects.toMatchObject({ code: "takeover_in_progress" });

    cleanup.resolve();
    expect(await takeover).toBeNull();
    await until(() => retained.attachments.at(-1) === true);
    expect(retained.attachments).toEqual([true, false, true]);
    expect(creates).toBe(1);
    expect(retained.starts()).toBe(1);
    expect(retained.closes()).toBe(0);
    expect(availability).toContain("closing");
    expect(availability).not.toContain("idle");
    expect(await automatic.request("discover")).toEqual({
      busy: true,
      workspace: root,
      threadId: "retained-thread",
    });
    await expect(
      automatic.request("call", { clientId: crypto.randomUUID(), takeover: "auto" }),
    ).rejects.toMatchObject({ code: "already_owner" });
  } finally {
    cleanup.resolve();
    owner && (await owner.close());
    automatic?.close();
    competingAutomatic?.close();
    confirmer?.close();
    observer?.socket.close();
    await server.close();
    expect(retained.closes()).toBe(1);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a disconnected takeover requester cannot remain the media owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-cancelled-takeover-"));
  const cleanupStarted = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const retained = fakeCall(() => {});
  retained.call.setFrontendAttached = async (attached) => {
    retained.attachments.push(attached);
    if (!attached) {
      cleanupStarted.resolve();
      await cleanup.promise;
    }
  };
  const server = new VoiceServer(frontendSocketPath(root), async () => retained.call);
  let owner: Awaited<ReturnType<typeof connectFrontend>> | undefined;
  let cancelled: ControlSocket | undefined;
  let probe: ControlSocket | undefined;
  let successor: ControlSocket | undefined;
  try {
    await server.start();
    owner = await connectFrontend(server.path);
    await until(() => retained.attachments.at(-1) === true);
    cancelled = await ControlSocket.connect(server.path, 3);
    const request = cancelled.request(
      "call",
      { clientId: crypto.randomUUID(), takeover: "auto" },
      30_000,
    );
    const rejected = request.catch((error: Error) => error);
    await cleanupStarted.promise;
    cancelled.close();
    cleanup.resolve();
    expect(await rejected).toBeInstanceOf(Error);
    probe = await ControlSocket.connect(server.path, 3);
    let discovery: { busy: boolean } = { busy: true };
    const deadline = Date.now() + 3_000;
    while (discovery.busy && Date.now() < deadline) {
      discovery = (await probe.request("discover")) as { busy: boolean };
      if (discovery.busy) await Bun.sleep(5);
    }
    expect(discovery.busy).toBe(false);
    expect(retained.attachments.slice(0, 2)).toEqual([true, false]);
    expect(retained.attachments.at(-1)).toBe(false);
    probe.close();
    probe = undefined;

    successor = await ControlSocket.connect(server.path, 3);
    expect(
      await successor.request("call", { clientId: crypto.randomUUID(), takeover: "confirm" }),
    ).toBeNull();
    await until(() => retained.attachments.at(-1) === true);
    expect(retained.attachments.at(-1)).toBe(true);
  } finally {
    cleanup.resolve();
    await owner?.close();
    cancelled?.close();
    probe?.close();
    successor?.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("confirmation tokens are peer-bound and stale incumbent tokens require a fresh confirmation", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-confirm-takeover-"));
  const retained = fakeCall(() => {});
  let now = 1_000;
  const server = new VoiceServer(
    frontendSocketPath(root),
    async () => retained.call,
    console.error,
    undefined,
    () => now,
  );
  let owner: Awaited<ReturnType<typeof connectFrontend>> | undefined;
  let candidate: ControlSocket | undefined;
  let replacement: ControlSocket | undefined;
  let stranger: ControlSocket | undefined;
  try {
    await server.start();
    owner = await connectFrontend(server.path);
    candidate = await ControlSocket.connect(server.path, 3);
    const clientId = crypto.randomUUID();
    const first = (await candidate.request("call", {
      clientId,
      takeover: "confirm",
    })) as { takeoverRequired: true; token: string };
    expect(first.takeoverRequired).toBe(true);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    stranger = await ControlSocket.connect(server.path, 3);
    await expect(
      stranger.request("call", { clientId, takeover: { token: first.token } }),
    ).rejects.toMatchObject({ code: "invalid_takeover_token" });

    now += 30_001;
    const renewedAfterExpiry = (await candidate.request("call", {
      clientId,
      takeover: { token: first.token },
    })) as { takeoverRequired: true; token: string };
    expect(renewedAfterExpiry.takeoverRequired).toBe(true);
    expect(renewedAfterExpiry.token).not.toBe(first.token);

    replacement = await ControlSocket.connect(server.path, 3);
    expect(
      await replacement.request(
        "call",
        { clientId: crypto.randomUUID(), takeover: "auto" },
        30_000,
      ),
    ).toBeNull();
    await owner.done;
    const refreshed = (await candidate.request("call", {
      clientId,
      takeover: { token: renewedAfterExpiry.token },
    })) as { takeoverRequired: true; token: string };
    expect(refreshed.takeoverRequired).toBe(true);
    expect(refreshed.token).not.toBe(first.token);
    expect(await replacement.request("input", { action: "release" })).toBeNull();
  } finally {
    await owner?.close();
    candidate?.close();
    replacement?.close();
    stranger?.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("takeover reports media detach poison and never acknowledges a successor", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-takeover-detach-failure-"));
  const retained = fakeCall(() => {});
  retained.call.setFrontendAttached = async (attached) => {
    retained.attachments.push(attached);
    if (!attached) throw new Error("native stop outcome unknown");
  };
  const server = new VoiceServer(
    frontendSocketPath(root),
    async () => retained.call,
    () => {},
  );
  let owner: Awaited<ReturnType<typeof connectFrontend>> | undefined;
  let candidate: ControlSocket | undefined;
  try {
    await server.start();
    owner = await connectFrontend(server.path);
    candidate = await ControlSocket.connect(server.path, 3);
    let failure: unknown;
    try {
      await candidate.request("call", { clientId: crypto.randomUUID(), takeover: "auto" }, 30_000);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SocketFailure);
    expect(failure).toMatchObject({
      code: "media_detach_failed",
      message:
        "Previous media cleanup failed. Conversation and agent work are retained; restart the server before connecting again.",
    });
    expect(retained.attachments).toEqual([true, false]);
    await expect(
      candidate.request("call", { clientId: crypto.randomUUID(), takeover: "confirm" }),
    ).rejects.toMatchObject({ code: "media_detach_failed" });
  } finally {
    await owner?.close();
    candidate?.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
