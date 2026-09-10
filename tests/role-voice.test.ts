import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlOperationSchema, dispatchControl } from "../src/control/contract.ts";
import { CONTROL_MCP_TOOLS } from "../src/control/types.ts";
import { parseArgs } from "../src/main.ts";
import { dataDirectory } from "../src/paths.ts";
import { createRole, readRole, rolePath, type VoiceEdit } from "../src/roles/store.ts";
import { RuntimeController } from "../src/runtime-control/controller.ts";
import { spawnRuntimeProcess } from "../src/runtime-control/process.ts";
import { deferred, runtimeHarness } from "./fixtures/runtime-harness.ts";

async function until(predicate: () => boolean) {
  for (let n = 0; n < 200 && !predicate(); n++) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

test("real worker IPC applies the saved voice to its existing native child and cleans its projection", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "av-voice-worker-")));
  const oldData = process.env["XDG_DATA_HOME"];
  process.env["XDG_DATA_HOME"] = join(root, "data");
  const path = rolePath(dataDirectory(process.env, root), root);
  createRole(path, {
    settings: { voice: { name: "cove" }, orchestrator: { model: "unchanged" } },
    hasRole: false,
    files: [],
  });
  const worker = join(root, "worker.ts");
  writeFileSync(
    worker,
    `
    import {runRuntimeWorker} from ${JSON.stringify(new URL("../src/runtime-control/worker.ts", import.meta.url).pathname)};
    process.env.XDG_CACHE_HOME = ${JSON.stringify(join(root, "cache"))};
    process.env.XDG_STATE_HOME = ${JSON.stringify(join(root, "state"))};
    runRuntimeWorker({mediaFactory:{
      check(){},
      audio(){return {micMuted:true,speakerMuted:false,async start(){},async stop(){},attachRemote(){},detachRemote(){}}},
      transport(options){return {
        sendOpusFrame(){},async stop(){},
        async redialAndWait(){await options.signal.offer('fake-sdp');options.onPhase('live')},
        handleReady(info){options.onReady(info);options.onPhase('live')},
        async handleAnswer(){},handleClosed(){},handleSignalLost(){},handleError(){}
      }}
    }});
  `,
  );
  const controller = new RuntimeController({
    instanceId: "real-worker",
    stateDir: join(root, "controller"),
    version: "test",
    provenance: {
      parsed: parseArgs([
        "--workspace",
        root,
        "--codex",
        join(import.meta.dir, "fixtures/controller-codex.ts"),
      ]),
      options: { fresh: false, continue: false, debug: false },
      launchCwd: root,
    },
    control: {
      name: "agentvoice_control",
      server: { enabled_tools: CONTROL_MCP_TOOLS },
      tools: CONTROL_MCP_TOOLS,
      env: {},
    },
    spawn: (generation, event, lease) => spawnRuntimeProcess(generation, event, lease, worker),
  });
  try {
    await controller.start();
    const before = controller.status();
    expect(before.runtime.phase).toBe("ready");
    await controller.voiceSet({
      operationId: "real-change",
      expectedInstanceId: "real-worker",
      expectedGeneration: before.generation,
      expectedRoleRevision: 1,
      voice: "maple",
      apply: "voice",
    });
    await until(() => controller.status().currentOperation?.phase === "ready");
    expect(controller.status().currentOperation?.voiceEdit?.application).toBe("applied");
    expect(controller.status().runtime.pid).toBe(before.runtime.pid);
    const audit = readFileSync(join(root, "native-audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const realtime = audit.filter((row) => row.method === "thread/realtime/start");
    expect(realtime).toHaveLength(1);
    expect(realtime[0].params.voice).toBe("maple");
    expect(new Set(audit.map((row) => row.pid)).size).toBe(1);
    expect(audit.filter((row) => row.method === "thread/start")).toHaveLength(1);
    expect(audit.some((row) => row.method === "thread/resume")).toBe(false);
    expect(readdirSync(join(root, "cache/agentvoice/roles"))).toHaveLength(1);
  } finally {
    await controller.shutdown();
    expect(readdirSync(join(root, "cache/agentvoice/roles"))).toHaveLength(0);
    if (oldData === undefined) delete process.env["XDG_DATA_HOME"];
    else process.env["XDG_DATA_HOME"] = oldData;
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "av-voice-edit-")));
  const previous = process.env["XDG_DATA_HOME"];
  process.env["XDG_DATA_HOME"] = join(root, "data");
  const workspace = join(root, "work");
  mkdirSync(workspace);
  const path = rolePath(dataDirectory(process.env, root), workspace);
  createRole(path, {
    settings: { voice: { name: "cove" }, orchestrator: { model: "work-model" } },
    hasRole: false,
    files: [],
  });
  const calls: Array<{ method: string; params: unknown }> = [];
  const application = deferred();
  let mode: "success" | "failure" | "lost" | "wait" = "success";
  let spawned = 0,
    stops = 0;
  const controller = new RuntimeController({
    instanceId: "test-call",
    stateDir: join(root, "state"),
    version: "test",
    provenance: {
      parsed: parseArgs(["--workspace", workspace]),
      options: { fresh: false, continue: false, debug: false },
      launchCwd: root,
    },
    control: { name: "agentvoice_control", server: {}, tools: [], env: {} },
    lease: () => () => {},
    spawn: (_generation, event, lease) => {
      const pid = ++spawned;
      const exited = deferred();
      return {
        pid,
        nativePid: pid + 100,
        exited: exited.promise,
        notify() {},
        stop: async () => {
          stops++;
          exited.resolve();
          return false;
        },
        request: async <T>(method: string, params: unknown): Promise<T> => {
          calls.push({ method, params });
          if (method === "preflight") {
            const saved = readRole(path);
            return {
              workspace,
              pid,
              buildId: "test",
              role: saved.ref,
              voice: saved.settings.voice?.name ?? null,
            } as T;
          }
          if (method === "activate") {
            await lease("thread");
            event("state", {
              available: true,
              phase: "live",
              mic: { muted: true, effectiveMuted: true },
              speaker: { muted: false, effectiveMuted: false },
              conversation: {
                threadId: "thread",
                workspace,
                model: "work-model",
                effort: null,
                conversationMode: "started",
                voiceVersion: "v3",
                prompts: [],
              },
            });
          }
          if (method === "voice-apply") {
            if (mode === "wait") await application.promise;
            if (mode === "lost") throw new Error("IPC disconnected");
            return { applied: mode !== "failure" } as T;
          }
          return null as T;
        },
      };
    },
  });
  await controller.start();
  const request = (operationId: string, apply: VoiceEdit["apply"] = "voice"): VoiceEdit => ({
    operationId,
    expectedInstanceId: "test-call",
    expectedGeneration: controller.status().generation,
    expectedRoleRevision: readRole(path).ref.revision,
    voice: "maple",
    apply,
  });
  return {
    controller,
    path,
    calls,
    request,
    application,
    mode: (value: typeof mode) => {
      mode = value;
    },
    spawned: () => spawned,
    stops: () => stops,
    async close() {
      application.resolve();
      await controller.shutdown();
      if (previous === undefined) delete process.env["XDG_DATA_HOME"];
      else process.env["XDG_DATA_HOME"] = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("voice API saves first, deduplicates, reconnects only voice and preserves native identity", async () => {
  const f = await fixture();
  try {
    f.mode("wait");
    const request = f.request("change");
    const initial = f.controller.status();
    const accepted = controlOperationSchema.parse(
      await dispatchControl(f.controller, "agentvoice.voice_set", request),
    );
    expect(accepted).toMatchObject({
      phase: "accepted",
      voiceEdit: { application: "pending", saved: { revision: 2 } },
    });
    expect(readRole(f.path).settings.voice?.name).toBe("maple");
    expect(f.controller.status().role).toMatchObject({
      loaded: { revision: 1 },
      desired: { revision: 2 },
      voice: "cove",
      voiceRevision: 1,
    });
    expect(await f.controller.voiceSet(request)).toEqual(accepted);
    await expect(f.controller.voiceSet({ ...request, voice: "sol" })).rejects.toThrow(
      "different immutable request",
    );
    await expect(
      f.controller.restart({
        operationId: "overlap",
        expectedGeneration: 1,
        expectedInstanceId: "test-call",
        scope: "runtime",
      }),
    ).rejects.toThrow("in progress");
    await until(() => f.calls.some((call) => call.method === "voice-apply"));
    f.application.resolve();
    await until(() => f.controller.status().currentOperation?.phase === "ready");
    const final = f.controller.status();
    expect(final.role).toMatchObject({
      loaded: { revision: 1 },
      desired: { revision: 2 },
      voice: "maple",
      voiceRevision: 2,
    });
    expect(final.runtime.pid).toBe(initial.runtime.pid);
    expect(final.threadId).toBe(initial.threadId);
    expect(final.generation).toBe(initial.generation);
    expect(f.controller.state().mic.muted).toBe(true);
    expect(f.spawned()).toBe(1);
    expect(f.stops()).toBe(0);
    expect(f.calls.filter((call) => call.method === "voice-apply")).toHaveLength(1);
    expect(await f.controller.voiceSet(request)).toMatchObject({
      voiceEdit: { application: "applied" },
    });
    await expect(
      f.controller.voiceSet({ ...f.request("stale"), expectedRoleRevision: 1 }),
    ).rejects.toThrow("Stale role revision");
    await expect(
      f.controller.voiceSet({ ...f.request("foreign"), expectedInstanceId: "other-call" }),
    ).rejects.toThrow("another controller");
  } finally {
    await f.close();
  }
});

test("save-only defers application, explicit restart reloads the desired revision", async () => {
  const f = await fixture();
  try {
    await f.controller.voiceSet(f.request("defer", "next-session"));
    await until(() => f.controller.status().currentOperation?.phase === "ready");
    expect(f.controller.status().currentOperation?.voiceEdit?.application).toBe("deferred");
    expect(f.calls.some((call) => call.method.startsWith("voice-"))).toBe(false);
    expect(f.controller.status().role?.voice).toBe("cove");
    await f.controller.restart({
      operationId: "reload",
      expectedInstanceId: "test-call",
      expectedGeneration: 1,
      scope: "runtime",
    });
    await until(
      () =>
        f.controller.status().generation === 2 &&
        f.controller.status().currentOperation?.phase === "ready",
    );
    expect(f.controller.status().role).toMatchObject({
      loaded: { revision: 2 },
      voice: "maple",
      voiceRevision: 2,
    });
    expect(f.spawned()).toBe(2);
  } finally {
    await f.close();
  }
});

test("failed or ambiguous voice application retains the edit without automatic resubmission", async () => {
  const f = await fixture();
  try {
    for (const mode of ["failure", "lost"] as const) {
      f.mode(mode);
      const request = f.request(mode);
      await f.controller.voiceSet(request);
      await until(() => f.controller.status().currentOperation?.phase === "failed");
      expect(f.controller.status().currentOperation?.voiceEdit?.application).toBe(
        mode === "lost" ? "unknown" : "failed",
      );
      expect(f.controller.status().role?.voice).toBe("cove");
      expect(readRole(f.path).settings.voice?.name).toBe("maple");
      await f.controller.voiceSet(request);
    }
    expect(f.calls.filter((call) => call.method === "voice-apply")).toHaveLength(2);
    expect(f.spawned()).toBe(1);
  } finally {
    await f.close();
  }
});

test("closing after save never starts a replacement session", async () => {
  const f = await fixture();
  try {
    await f.controller.voiceSet(f.request("close"));
    await f.controller.shutdown();
    expect(readRole(f.path).settings.voice?.name).toBe("maple");
    expect(f.calls.some((call) => call.method === "voice-apply")).toBe(false);
  } finally {
    await f.close();
  }
});

test("runtime changes only the realtime voice field and rejects a masked name", async () => {
  const h = runtimeHarness({ voice: { name: "cove" }, orchestrator: { model: "unchanged" } });
  try {
    await h.runtime.start();
    expect(h.runtime.setVoice("maple")).toBe("cove");
    await h.runtime.offer("offer");
    const start = h.native.calls.find((call) => call.method === "thread/realtime/start");
    expect(start?.params["voice"]).toBe("maple");
    expect(h.native.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
    expect(h.config.orchestrator.model).toBe("unchanged");
    expect(h.runtime.setVoice(null)).toBe("maple");
    expect(h.config.voice.name).toBeUndefined();
    h.config.voice.extra = { voice: "sol" };
    expect(() => h.runtime.setVoice("maple")).toThrow("masks");
  } finally {
    await h.cleanup();
  }
});
