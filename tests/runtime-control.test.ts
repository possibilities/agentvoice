import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTROL_MCP_SERVER_NAME, CONTROL_MCP_TOOLS } from "../src/control/types.ts";
import { lockThread } from "../src/core/thread-lock.ts";
import type { ControllerEvent } from "../src/events/contract.ts";
import { parseArgs } from "../src/main.ts";
import { type ControllerOptions, RuntimeController } from "../src/runtime-control/controller.ts";
import { type RuntimeProcess, spawnRuntimeProcess } from "../src/runtime-control/process.ts";
import { deferred } from "./fixtures/runtime-harness.ts";

const registration = {
  name: CONTROL_MCP_SERVER_NAME,
  server: { url: "http://127.0.0.1:1/mcp", enabled_tools: CONTROL_MCP_TOOLS },
  tools: CONTROL_MCP_TOOLS,
  env: {},
};
async function until(predicate: () => boolean, timeout = 5_000) {
  const end = Date.now() + timeout;
  while (!predicate() && Date.now() < end) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}
function workerSource(version: string, library: string) {
  return `import { runRuntimeWorker } from ${JSON.stringify(new URL("../src/runtime-control/worker.ts", import.meta.url).pathname)};
import { dlopen, FFIType } from "bun:ffi";
const native = dlopen(${JSON.stringify(library)}, { fixture_version: { args: [], returns: FFIType.i32 } });
const version = ${JSON.stringify(version)} + ":" + native.symbols.fixture_version();
let events;
runRuntimeWorker({mediaFactory:{check(){},audio(options){return {micMuted:false,speakerMuted:false,async start(){options.onWarning(version+':start-muted:'+this.micMuted+':'+this.speakerMuted)},async stop(){},attachRemote(){},detachRemote(){}}},transport(options){events=options;return {liveForMs:7,sendOpusFrame(){},async stop(){},redial(){options.onPhase('negotiating')},async redialAndWait(){options.onPhase('negotiating'); await new Promise(resolve=>setTimeout(resolve,40)); options.onPhase('live')},handleReady(info){options.onReady(info); options.onPhase('live')},async handleAnswer(){},handleClosed(){},handleSignalLost(){},handleError(){}}}}});`;
}

function buildLibrary(root: string, version: number): string {
  const source = join(root, "native.c");
  const staged = join(root, "staged.dylib");
  const library = join(root, "native.dylib");
  writeFileSync(source, `int fixture_version(void) { return ${version}; }`);
  const result = spawnSync("cc", [
    process.platform === "darwin" ? "-dynamiclib" : "-shared",
    "-fPIC",
    source,
    "-o",
    staged,
  ]);
  if (result.status !== 0) throw new Error(`fixture native build failed: ${result.stderr}`);
  renameSync(staged, library);
  return library;
}

describe("call controller and disposable runtime", () => {
  test("real Bun and native children start muted, retain leases and shut down cleanly", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "av-controller-")));
    const configPath = join(root, "server.json");
    const worker = join(root, "worker.ts");
    const prompt = join(root, "VOICE_ORCHESTRATOR_APPEND_SYSTEM_PROMPT.md");
    writeFileSync(configPath, JSON.stringify({ orchestrator: { model: "before" } }));
    writeFileSync(prompt, "old prompt");
    const library = buildLibrary(root, 1);
    writeFileSync(worker, workerSource("code one", library));
    const children: RuntimeProcess[] = [];
    const options: ControllerOptions = {
      instanceId: "integration",
      stateDir: root,
      provenance: {
        parsed: parseArgs([
          "--allow-full-access",
          "--config",
          configPath,
          "--workspace",
          root,
          "--codex",
          join(import.meta.dir, "fixtures/controller-codex.ts"),
        ]),
        options: { debug: false, fresh: false, continue: false },
        launchCwd: root,
      },
      version: "test",
      control: registration,
      spawn: (generation, event, lease) => {
        const child = spawnRuntimeProcess(generation, event, lease, worker);
        children.push(child);
        return child;
      },
    };
    const controller = new RuntimeController(options);
    let later: RuntimeController | undefined;
    const voiceEvents: ControllerEvent[] = [];
    controller.lifecycle.listen((event) => {
      if (event.event.startsWith("voice.")) voiceEvents.push(event);
    });
    try {
      await controller.start();
      expect(controller.status().runtime.phase).toBe("ready");
      await until(() => controller.state().notice?.includes("code one:1") === true);
      expect(controller.state().notice).toContain("start-muted:true:true");
      const first = controller.status();
      expect(first.threadId).toBe("test-thread-1");
      await until(() => controller.lifecycle.snapshot().inventory === "ready");
      expect(controller.lifecycle.snapshot().threads).toMatchObject([
        { id: first.threadId, status: "idle" },
      ]);
      const firstNative = children[0]!.nativePid!;
      expect(firstNative).toBeGreaterThan(0);
      expect(() => lockThread(join(root, "thread-locks"), first.threadId)).toThrow("already open");
      await controller.shutdown();
      expect(children.every((child) => !child.nativePid)).toBe(true);
      const release = lockThread(join(root, "thread-locks"), first.threadId);
      release();
      writeFileSync(configPath, JSON.stringify({ orchestrator: { model: "after" } }));
      writeFileSync(prompt, "next call prompt");
      later = new RuntimeController({ ...options, instanceId: "later-call" });
      await later.start();
      expect(later.status().runtime.phase).toBe("ready");
      expect(later.status().threadId).not.toBe(first.threadId);
      expect(later.state().conversation?.model).toBe("after");
      expect(later.status().instanceId).not.toBe(first.instanceId);
      await expect(later.start()).rejects.toThrow("already started");
    } finally {
      await later?.shutdown();
      await controller.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

test("mute preferences changed during activation reach the worker and its final media enable handshake", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "av-controller-mute-")));
  const activation = deferred();
  const entered = deferred();
  const messages: Array<{ method: string; params: unknown }> = [];
  const controller = new RuntimeController({
    instanceId: "muting",
    stateDir: root,
    version: "test",
    provenance: {
      parsed: parseArgs([]),
      options: { debug: false, fresh: false, continue: false },
      launchCwd: root,
    },
    control: registration,
    spawn: (_generation, _event, _lease) => ({
      pid: 10,
      nativePid: undefined,
      exited: Promise.resolve(),
      stop: async () => false,
      notify: (method, params) => {
        messages.push({ method, params });
      },
      request: async <T>(method: string, params: unknown): Promise<T> => {
        messages.push({ method, params });
        if (method === "preflight") return { workspace: root, buildId: "fixture", pid: 10 } as T;
        if (method === "activate") {
          entered.resolve();
          await activation.promise;
        }
        return null as T;
      },
    }),
  });
  try {
    const boot = controller.start();
    await entered.promise;
    controller.microphone.setMuted(true);
    controller.speaker.setMuted(true);
    controller.syncMute();
    expect(messages.at(-1)).toEqual({ method: "mute", params: { mic: true, speaker: true } });
    activation.resolve();
    await boot;
    expect(messages.find((message) => message.method === "enable-media")).toEqual({
      method: "enable-media",
      params: { mic: true, speaker: true },
    });
    expect(controller.state().mic).toMatchObject({ muted: true, effectiveMuted: true });
    expect(controller.state().speaker).toMatchObject({ muted: true, effectiveMuted: true });
  } finally {
    activation.resolve();
    await controller.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller reaps captured detached process sessions after the runtime dies during shutdown", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "av-runtime-detached-")));
  const workerPath = join(root, "worker.ts");
  const pidPath = join(root, "descendants.json");
  const detachedProgram = `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
writeFileSync(${JSON.stringify(pidPath)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`;
  writeFileSync(
    workerPath,
    `import { spawn } from 'node:child_process'; import { existsSync,readFileSync } from 'node:fs';
spawn(process.execPath,['-e',${JSON.stringify(detachedProgram)}],{detached:true,stdio:'ignore'});
process.on('message',async message=>{
 if(message.method==='shutdown')process.kill(process.pid,'SIGKILL');
 if(message.method==='tree'){
  while(!existsSync(${JSON.stringify(pidPath)}))await Bun.sleep(5);
  process.send({version:1,generation:Number(process.argv[2]),id:message.id,result:JSON.parse(readFileSync(${JSON.stringify(pidPath)},'utf8'))});
 }
});`,
  );
  const runtime = spawnRuntimeProcess(
    1,
    () => {},
    async () => {},
    workerPath,
  );
  let descendants: number[] = [];
  try {
    descendants = await runtime.request<number[]>("tree");
    expect(descendants).toHaveLength(2);
    expect(await runtime.stop()).toBe(true);
    expect(() => process.kill(runtime.pid!, 0)).toThrow();
    for (const pid of descendants) expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await runtime.stop().catch(() => {});
    for (const pid of descendants) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
