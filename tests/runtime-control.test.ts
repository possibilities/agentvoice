import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VoiceTuiState } from "../src/console/tui.ts";
import { CONTROL_MCP_SERVER_NAME, CONTROL_MCP_TOOLS } from "../src/control/types.ts";
import { lockThread } from "../src/core/thread-lock.ts";
import type { ControllerEvent } from "../src/events/contract.ts";
import { parseArgs } from "../src/main.ts";
import { RuntimeController } from "../src/runtime-control/controller.ts";
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

describe("persistent controller and disposable runtime", () => {
  test("real Bun + native children replace code/config on the exact leased thread and keep durable operation recovery", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "av-controller-")));
    const configPath = join(root, "server.json");
    const worker = join(root, "worker.ts");
    const prompt = join(root, "VOICE_ORCHESTRATOR_APPEND_SYSTEM_PROMPT.md");
    writeFileSync(configPath, JSON.stringify({ orchestrator: { model: "before" } }));
    writeFileSync(prompt, "old prompt");
    const library = buildLibrary(root, 1);
    writeFileSync(worker, workerSource("code one", library));
    const children: RuntimeProcess[] = [];
    const controller = new RuntimeController({
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
    });
    const mutation = (operationId: string) => ({
      operationId,
      expectedInstanceId: "integration",
      expectedGeneration: controller.status().generation,
      scope: "runtime" as const,
    });
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
      controller.microphone.setMuted(true);
      controller.syncMute();
      buildLibrary(root, 2);
      writeFileSync(worker, workerSource("code two", library));
      writeFileSync(
        configPath,
        JSON.stringify({ orchestrator: { model: "after", workspace: "/ignored-by-cli" } }),
      );
      writeFileSync(prompt, "new prompt");
      const promptText = "Inspect status after restart.\nA private handoff: 雪.";
      const request = { ...mutation("replace-one"), handoffPrompt: promptText };
      const accepted = await controller.restart(request);
      expect(accepted.phase).toBe("accepted");
      expect(accepted.handoff?.status).toBe("pending");
      expect(JSON.stringify(accepted)).not.toContain("private handoff");
      expect(readFileSync(join(root, "operations/integration.jsonl"), "utf8")).toContain(
        '"phase":"accepted"',
      );
      expect(controller.status().runtime.pid).toBe(first.runtime.pid);
      await until(
        () => controller.status().currentOperation?.handoff?.status === "accepted",
        10_000,
      );
      const second = controller.status();
      expect(second.currentOperation?.handoff?.turnId).toBe("handoff-turn");
      expect(JSON.stringify(second)).not.toContain("private handoff");
      expect(second.threadId).toBe(first.threadId);
      expect(second.generation).toBe(2);
      await until(() => {
        const thread = controller.lifecycle.snapshot().threads[0];
        return thread?.turn?.id === "handoff-turn" && thread.status === "active";
      });
      expect(controller.lifecycle.snapshot()).toMatchObject({
        generation: 2,
        threads: [{ id: first.threadId, status: "active" }],
      });
      expect(JSON.stringify(controller.lifecycle.snapshot())).not.toContain("private handoff");
      expect(second.runtime.pid).not.toBe(first.runtime.pid);
      expect(second.runtime.buildId).not.toBe(first.runtime.buildId);
      expect(() => process.kill(first.runtime.pid!, 0)).toThrow();
      expect(() => process.kill(firstNative, 0)).toThrow();
      expect(controller.state().mic.muted).toBe(true);
      await until(() => controller.state().notice?.includes("code two:2") === true);
      expect(await controller.restart(request)).toMatchObject({
        operationId: "replace-one",
        phase: "ready",
      });
      for (const handoffPrompt of [undefined, "changed task"]) {
        await expect(controller.restart({ ...request, handoffPrompt })).rejects.toThrow(
          "different immutable request",
        );
      }
      await expect(controller.restart({ ...request, operationId: "stale-new-id" })).rejects.toThrow(
        "Read status",
      );
      const audit = readFileSync(join(root, "native-audit.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const newCalls = audit.filter((call) => call.pid !== firstNative);
      const turns = newCalls.filter((call) => call.method === "turn/start");
      expect(turns).toHaveLength(1);
      expect(turns[0].params).toEqual({
        threadId: first.threadId,
        clientUserMessageId: accepted.handoff!.clientUserMessageId,
        input: [
          {
            type: "text",
            text: `AgentVoice restart handoff (agent-provided task):\n\n${promptText}`,
          },
        ],
      });
      expect(newCalls.findIndex((call) => call.method === "turn/start")).toBeGreaterThan(
        newCalls.findIndex((call) => call.method === "mcpServerStatus/list"),
      );
      await until(() => voiceEvents.length === 3);
      expect(voiceEvents.map((event) => event.event)).toEqual([
        "voice.item.started",
        "voice.item.transcript.delta",
        "voice.item.completed",
      ]);
      expect(voiceEvents.every((event) => event.data.generation === 2)).toBe(true);
      expect(voiceEvents[1]).toMatchObject({
        type: "event",
        data: {
          threadId: first.threadId,
          itemId: "voice-fixture-item",
          delta: "native voice fixture",
        },
      });
      expect(JSON.stringify(controller.lifecycle.snapshot())).not.toContain("native voice fixture");
      expect(readFileSync(join(root, "operations/integration.jsonl"), "utf8")).not.toContain(
        "native voice fixture",
      );
      expect(newCalls.some((call) => call.method === "thread/list")).toBe(false);
      expect(newCalls.find((call) => call.method === "thread/resume").params).toMatchObject({
        threadId: first.threadId,
        model: "after",
        developerInstructions: "new prompt",
      });
      expect(
        newCalls.some(
          (call) =>
            call.method === "mcpServerStatus/list" && call.params.threadId === first.threadId,
        ),
      ).toBe(true);
      const redial = await controller.redial(mutation("redial-only"));
      expect(redial.scope).toBe("voice");
      await until(() => controller.status().currentOperation?.phase === "ready");
      expect(controller.status().generation).toBe(2);
      expect(controller.status().runtime.pid).toBe(second.runtime.pid);
      expect(
        readFileSync(join(root, "native-audit.jsonl"), "utf8").match(/"method":"turn\/start"/gu),
      ).toHaveLength(1);
      // Invalid local config is rejected in the candidate before touching the live generation.
      writeFileSync(configPath, '{"accounts":{}}');
      await controller.restart(mutation("invalid-config"));
      await until(() => controller.status().currentOperation?.phase === "failed");
      expect(controller.status().generation).toBe(2);
      expect(controller.status().runtime.pid).toBe(second.runtime.pid);
      expect(controller.status().runtime.phase).toBe("ready");
      expect(() => lockThread(join(root, "thread-locks"), first.threadId)).toThrow("already open");
      writeFileSync(configPath, "{}");
      await controller.fresh();
      await until(() => controller.status().threadId === "test-thread-2");
      expect(() => lockThread(join(root, "thread-locks"), first.threadId)).toThrow("already open");
      expect(() => lockThread(join(root, "thread-locks"), "test-thread-2")).toThrow("already open");
      for (const [mode, outcome] of [
        ["refused", "failed"],
        ["malformed", "unknown"],
      ] as const) {
        writeFileSync(join(root, "handoff-mode"), mode);
        await controller.restart({ ...mutation(`handoff-${mode}`), handoffPrompt: promptText });
        await until(
          () => controller.status().currentOperation?.handoff?.status === outcome,
          10_000,
        );
        expect(controller.status().runtime.phase).toBe("ready");
        expect(controller.status().currentOperation?.phase).toBe("ready");
        expect(controller.status().threadId).toBe("test-thread-2");
        expect(JSON.stringify(controller.status())).not.toContain("private handoff");
        expect(() => process.kill(controller.status().runtime.pid!, 0)).not.toThrow();
      }
    } finally {
      await controller.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("failed activation is retryable, force survives outcome, and old events cannot retarget the controller", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "av-controller-fake-")));
    const callbacks: Array<(method: string, params: unknown) => void> = [];
    const activations: unknown[] = [];
    const releases: string[] = [];
    let spawned = 0;
    const ready: VoiceTuiState = {
      available: true,
      phase: "live",
      liveForMs: 12,
      mic: { muted: false, effectiveMuted: false, db: -8 },
      speaker: { muted: false, effectiveMuted: false, db: -4 },
      conversation: {
        workspace: root,
        threadId: "saved",
        model: null,
        effort: null,
        conversationMode: "continued",
        voiceVersion: null,
        prompts: [],
      },
    };
    const controller = new RuntimeController({
      instanceId: "fake",
      stateDir: root,
      version: "test",
      provenance: {
        parsed: parseArgs([]),
        options: { debug: false, fresh: false, continue: false },
        launchCwd: root,
      },
      control: registration,
      lease: (id) => () => {
        releases.push(id);
      },
      spawn: (_generation, onEvent, lease) => {
        const index = spawned++;
        callbacks.push(onEvent);
        const exited = deferred();
        return {
          pid: 100 + index,
          nativePid: undefined,
          exited: exited.promise,
          notify() {},
          stop: async () => {
            exited.resolve();
            return index === 0;
          },
          request: async <T>(method: string, params: unknown): Promise<T> => {
            if (method === "preflight")
              return { workspace: root, pid: 100 + index, buildId: String(index) } as T;
            if (method === "activate") {
              activations.push(params);
              await lease("saved");
              if (index === 1) throw new Error("native resume rejected permissions");
              onEvent("state", ready);
            }
            return null as T;
          },
        };
      },
    });
    const request = (id: string) => ({
      operationId: id,
      scope: "runtime" as const,
      expectedGeneration: controller.status().generation,
      expectedInstanceId: "fake",
    });
    try {
      await controller.start();
      const first = request("first");
      await controller.restart(first);
      await expect(controller.restart(request("concurrent"))).rejects.toThrow("in progress");
      await until(() => controller.status().currentOperation?.phase === "failed");
      expect(controller.status().runtime.phase).toBe("failed");
      expect(controller.status().currentOperation?.forced).toBe(true);
      expect(controller.status().threadId).toBe("saved");
      expect(releases).toEqual([]);
      callbacks[0]!("state", {
        ...ready,
        conversation: { ...ready.conversation, threadId: "stale" },
      });
      expect(controller.status().threadId).toBe("saved");
      callbacks[0]!("threads", {
        complete: true,
        threads: [
          {
            id: "stale",
            name: null,
            parentThreadId: null,
            status: "active",
            activeFlags: [],
            turn: null,
          },
        ],
      });
      expect(controller.lifecycle.snapshot()).toMatchObject({
        inventory: "unavailable",
        threads: [],
      });
      const retryRequest = request("retry");
      await controller.restart(retryRequest);
      await until(() => controller.status().currentOperation?.phase === "ready");
      expect(activations.slice(1)).toEqual([
        { threadId: "saved", mute: { mic: false, speaker: false } },
        { threadId: "saved", mute: { mic: false, speaker: false } },
      ]);
      expect((await controller.restart(first)).phase).toBe("failed");
      const completedRetry = await controller.restart(retryRequest);
      const voiceEvents: ControllerEvent[] = [];
      controller.lifecycle.listen((event) => {
        if (event.event.startsWith("voice.")) voiceEvents.push(event);
      });
      const voice = {
        event: "voice.item.transcript.delta",
        data: { threadId: "saved", itemId: "native", delta: "private voice" },
      };
      callbacks[0]!("voice", voice);
      expect(voiceEvents).toHaveLength(0);
      callbacks[2]!("voice", voice);
      expect(voiceEvents).toHaveLength(1);
      callbacks[2]!("voice", { ...voice, data: { ...voice.data, audio: "must not leak" } });
      expect(voiceEvents).toHaveLength(1);
      callbacks[2]!("threads", {
        complete: true,
        threads: [
          {
            id: "saved",
            name: null,
            parentThreadId: null,
            status: "active",
            activeFlags: [],
            turn: null,
          },
        ],
      });
      expect(controller.lifecycle.snapshot().threads).toHaveLength(1);
      callbacks[2]!("threads", { complete: true, threads: [], privatePrompt: "must not leak" });
      expect(controller.lifecycle.snapshot().inventory).toBe("incomplete");
      expect(JSON.stringify(controller.lifecycle.snapshot())).not.toContain("must not leak");
      callbacks[2]!("fatal", { message: "terminal native failure" });
      callbacks[2]!("voice", voice);
      expect(voiceEvents).toHaveLength(1);
      callbacks[2]!("state", ready);
      callbacks[2]!("threads", { complete: true, threads: [] });
      expect(controller.lifecycle.snapshot()).toMatchObject({
        inventory: "unavailable",
        threads: [],
      });
      expect(controller.state().phase).toBe("failed");
      expect(controller.state().notice).toBe("terminal native failure");
      await controller.restart(request("retry-after-fatal"));
      await until(() => controller.status().currentOperation?.phase === "ready");
      expect(controller.state().phase).toBe("live");
      expect((await controller.restart(retryRequest)).result).toEqual(completedRetry.result);
      expect(controller.status().currentOperation?.result?.pid).not.toBe(
        completedRetry.result?.pid,
      );
    } finally {
      await controller.shutdown();
      expect(releases).toEqual(["saved"]);
      rmSync(root, { recursive: true, force: true });
    }
  });
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

test("initial saved-thread MCP failure pins the verified ID before retry despite newer history", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "av-initial-mcp-")));
  const configPath = join(root, "server.json");
  const worker = join(root, "worker.ts");
  const saved = { id: "saved-exact", cwd: root, threadSource: "agentvoice-orchestrator" };
  writeFileSync(configPath, "{}");
  writeFileSync(join(root, "native-threads.json"), JSON.stringify([saved]));
  writeFileSync(join(root, "fail-mcp"), "");
  writeFileSync(worker, workerSource("test", buildLibrary(root, 1)));
  const controller = new RuntimeController({
    instanceId: "initial-mcp",
    stateDir: root,
    version: "test",
    control: registration,
    provenance: {
      parsed: parseArgs([
        "--config",
        configPath,
        "--workspace",
        root,
        "--codex",
        join(import.meta.dir, "fixtures/controller-codex.ts"),
      ]),
      options: { debug: false, fresh: false, continue: true },
      launchCwd: root,
    },
    spawn: (generation, event, lease) => spawnRuntimeProcess(generation, event, lease, worker),
  });
  try {
    await controller.start();
    expect(controller.status().runtime.phase).toBe("failed");
    expect(controller.status().threadId).toBe(saved.id);
    const before = readFileSync(join(root, "native-audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const firstPid = before[0].pid;
    writeFileSync(
      join(root, "native-threads.json"),
      JSON.stringify([{ ...saved, id: "newer-thread" }, saved]),
    );
    rmSync(join(root, "fail-mcp"));
    await controller.restart({
      operationId: "retry-ready",
      scope: "runtime",
      expectedGeneration: controller.status().generation,
      expectedInstanceId: "initial-mcp",
    });
    await until(() => controller.status().currentOperation?.phase === "ready");
    const after = readFileSync(join(root, "native-audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((call) => call.pid !== firstPid);
    expect(
      after.some((call) => call.method === "thread/list" || call.method === "thread/start"),
    ).toBe(false);
    expect(after.find((call) => call.method === "thread/resume").params.threadId).toBe(saved.id);
    expect(controller.status().threadId).toBe(saved.id);
  } finally {
    await controller.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
