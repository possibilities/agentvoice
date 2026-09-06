import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAttachment } from "../src/attachment/bootstrap.ts";
import { startControlServer } from "../src/control/index.ts";
import { CONTROL_MCP_SERVER_NAME, CONTROL_MCP_TOOLS } from "../src/control/types.ts";
import { parseArgs } from "../src/main.ts";
import { RuntimeController } from "../src/runtime-control/controller.ts";
import { spawnRuntimeProcess } from "../src/runtime-control/process.ts";

async function until(predicate: () => boolean) {
  for (let i = 0; i < 500 && !predicate(); i++) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}
test("attachment bootstrap, Fresh and runtime replacement retain exact leases and revoke old sockets", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "av-attach-runtime-")));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  const configPath = join(root, "server.json");
  writeFileSync(configPath, "{}");
  const worker = join(root, "worker.ts");
  writeFileSync(
    worker,
    `import { runRuntimeWorker } from ${JSON.stringify(new URL("../src/runtime-control/worker.ts", import.meta.url).pathname)};
runRuntimeWorker({mediaFactory:{check(){},audio(){return {micMuted:true,speakerMuted:true,async start(){},async stop(){},attachRemote(){},detachRemote(){}}},transport(options){return {liveForMs:1,sendOpusFrame(){},async stop(){},redial(){},async redialAndWait(){},handleReady(info){options.onReady(info);options.onPhase('live')},async handleAnswer(){},handleClosed(){},handleSignalLost(){},handleError(){}}}}});`,
  );
  let controller!: RuntimeController;
  const control = await startControlServer({
    stateDir,
    instanceId: "attachment-integration",
    backend: {
      status: () => controller.status(),
      redial: (r) => controller.redial(r),
      restart: (r) => controller.restart(r),
    },
    attachment: (value) => controller.attachmentTicket(value),
  });
  controller = new RuntimeController({
    instanceId: "attachment-integration",
    stateDir,
    provenance: {
      parsed: parseArgs([
        "--allow-full-access",
        "--allow-tui-attach",
        "--config",
        configPath,
        "--workspace",
        root,
        "--codex",
        join(import.meta.dir, "fixtures/controller-codex.ts"),
      ]),
      options: { debug: false, fresh: false },
      launchCwd: root,
    },
    version: "test",
    control: {
      name: CONTROL_MCP_SERVER_NAME,
      tools: CONTROL_MCP_TOOLS,
      server: control.mcpServer,
      env: {},
    },
    spawn: (generation, event, lease) => spawnRuntimeProcess(generation, event, lease, worker),
  });
  const watches: WebSocket[] = [];
  const watch = async (url: string, token: string) => {
    const socket = new WebSocket(`${url}/watch`, { headers: { Authorization: `Bearer ${token}` } });
    watches.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("message", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("watch failed")), { once: true });
    });
    return socket;
  };
  try {
    await controller.start();
    expect(controller.status().runtime.phase).toBe("ready");
    const first = await acquireAttachment(stateDir, root);
    expect(first.threadId).toBe("test-thread-1");
    expect(JSON.stringify(controller.status())).not.toContain(first.token);
    const old = await watch(first.url, first.token);
    await controller.redial({
      operationId: "redial",
      expectedGeneration: 1,
      expectedInstanceId: "attachment-integration",
    });
    await until(() => controller.status().currentOperation?.phase === "ready");
    expect(old.readyState).toBe(WebSocket.OPEN);
    await controller.fresh();
    await until(() => old.readyState === WebSocket.CLOSED);
    const fresh = await acquireAttachment(stateDir, root);
    expect(fresh.threadId).toBe("test-thread-2");
    const beforeRestart = await watch(fresh.url, fresh.token);
    await controller.restart({
      operationId: "restart",
      expectedGeneration: 1,
      expectedInstanceId: "attachment-integration",
      scope: "runtime",
    });
    await until(
      () =>
        controller.status().generation === 2 &&
        controller.status().currentOperation?.phase === "ready",
    );
    await until(() => beforeRestart.readyState === WebSocket.CLOSED);
    const resumed = await acquireAttachment(stateDir, root);
    expect(resumed.threadId).toBe(fresh.threadId);
    expect(resumed.token).not.toBe(fresh.token);
    await expect(
      controller.attachmentTicket({
        instanceId: "attachment-integration",
        generation: 1,
        workspace: root,
        threadId: fresh.threadId,
      }),
    ).rejects.toThrow();
    const final = await watch(resumed.url, resumed.token);
    await controller.shutdown();
    await until(() => final.readyState === WebSocket.CLOSED);
  } finally {
    for (const socket of watches) socket.close();
    await controller.shutdown();
    await control.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
