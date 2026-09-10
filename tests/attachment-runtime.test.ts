import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAttachment } from "../src/attachment/bootstrap.ts";
import type { AttachmentTicket } from "../src/attachment/gateway.ts";
import { startControlServer } from "../src/control/index.ts";
import { CONTROL_MCP_SERVER_NAME, CONTROL_MCP_TOOLS } from "../src/control/types.ts";
import { parseArgs } from "../src/main.ts";
import { RuntimeController } from "../src/runtime-control/controller.ts";
import { spawnRuntimeProcess } from "../src/runtime-control/process.ts";
import { runtimeHarness } from "./fixtures/runtime-harness.ts";

async function until(predicate: () => boolean) {
  for (let i = 0; i < 500 && !predicate(); i++) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}
test("native permission changes preserve TUI admission and voice", async () => {
  let issue: (() => AttachmentTicket) | undefined;
  const h = runtimeHarness(
    { codex: process.execPath },
    {
      nativeStateDir: tmpdir(),
      onAttachmentReady: (create) => {
        issue = create;
      },
    },
  );
  // Watchers do not open native connections; all native notifications remain fake.
  Object.assign(h.native, { nativeEndpoint: { url: "ws://127.0.0.1:1", token: "unused" } });
  const watches: WebSocket[] = [];
  try {
    await h.runtime.start();
    const threadId = h.runtime.currentReady!.threadId;
    for (const permissions of [
      { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" } },
      undefined,
    ]) {
      h.native.options.onNotification("thread/settings/updated", {
        threadId,
        threadSettings: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
      });
      const ticket = issue!();
      const watch = new WebSocket(`${ticket.url}/watch`, {
        headers: { Authorization: `Bearer ${ticket.token}` },
      });
      watches.push(watch);
      await until(() => watch.readyState === WebSocket.OPEN);
      h.native.options.onNotification("thread/settings/updated", {
        threadId,
        threadSettings: permissions,
      });
      expect(watch.readyState).toBe(WebSocket.OPEN);
      expect(issue!().threadId).toBe(threadId);
      expect(h.runtime.currentReady?.threadId).toBe(threadId);
      expect(h.native.alive).toBe(true);
      expect(h.fatal).toEqual([]);
    }
  } finally {
    for (const watch of watches) watch.close();
    await h.cleanup();
  }
});
test("attachment bootstrap and runtime replacement retain exact leases and revoke old sockets", async () => {
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
      voiceSet: async () => {
        throw new Error("not used");
      },
      mailboxOpen: (params, caller) => controller.mailboxOpen(params, caller),
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
    const beforeRestart = old;
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
    expect(resumed.threadId).toBe(first.threadId);
    expect(resumed.token).not.toBe(first.token);
    await expect(
      controller.attachmentTicket({
        instanceId: "attachment-integration",
        generation: 1,
        workspace: root,
        threadId: first.threadId,
      }),
    ).rejects.toThrow();
    const final = await watch(resumed.url, resumed.token);
    // Restricted and unreported permissions also support attachment across runtime replacement.
    for (const [index, permissions] of [
      { approvalPolicy: "on-request", sandbox: { type: "readOnly" } },
      {},
    ].entries()) {
      writeFileSync(join(root, "native-permissions.json"), JSON.stringify(permissions));
      await controller.restart({
        operationId: `permissions-${index}`,
        expectedGeneration: 2 + index,
        expectedInstanceId: "attachment-integration",
        scope: "runtime",
      });
      await until(
        () =>
          controller.status().generation === 3 + index &&
          controller.status().currentOperation?.phase === "ready",
      );
      expect(controller.status().runtime.phase).toBe("ready");
      expect((await acquireAttachment(stateDir, root)).threadId).toBe(first.threadId);
    }
    await controller.shutdown();
    await until(() => final.readyState === WebSocket.CLOSED);
  } finally {
    for (const socket of watches) socket.close();
    await controller.shutdown();
    await control.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
