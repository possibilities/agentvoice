import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startControlServer } from "../src/control/index.ts";
import { CONTROL_PROTOCOL_VERSION } from "../src/control/types.ts";
import { OwnedProcessTree } from "../src/core/owned-processes.ts";

async function until(predicate: () => boolean, timeout = 6_000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
  expect(predicate()).toBe(true);
}

for (const ending of ["revoked", "disconnected", "normal-close", "quit"] as const) {
  test(`attachment releases wrapped TUI and restores terminal after ${ending}`, async () => {
    const root = realpathSync(mkdtempSync("/tmp/av-attach-exit-"));
    const pids = join(root, "pids");
    const stateDir = join(root, "state");
    const token = "a".repeat(43);
    let watcher: import("bun").ServerWebSocket<undefined> | undefined;
    const gateway = Bun.serve<undefined>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (request.headers.get("authorization") !== `Bearer ${token}`)
          return new Response("unauthorized", { status: 401 });
        if (!server.upgrade(request, { data: undefined }))
          return new Response(null, { status: 400 });
      },
      websocket: {
        open(peer) {
          watcher = peer;
          peer.send(JSON.stringify({ ready: true }));
        },
        message() {},
      },
    });
    const codex = join(import.meta.dir, "fixtures/attachment-process.ts");
    const control = await startControlServer({
      stateDir,
      instanceId: "attachment-test",
      backend: {
        status: () => ({
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          instanceId: "attachment-test",
          workspace: root,
          threadId: "thread",
          generation: 1,
          runtime: { phase: "ready" },
          recentOperations: [],
        }),
        redial: async () => {
          throw new Error("unexpected mutation");
        },
        restart: async () => {
          throw new Error("unexpected mutation");
        },
      },
      attachment: async () => ({
        workspace: root,
        threadId: "thread",
        codex,
        token,
        url: `ws://127.0.0.1:${gateway.port}`,
      }),
    });
    let output = "";
    const driver = Bun.spawn(
      [process.execPath, join(import.meta.dir, "fixtures/attachment-terminal.ts")],
      {
        cwd: root,
        env: { ...process.env, ATTACHMENT_TEST_PIDS: pids, ATTACHMENT_TEST_STATE: stateDir },
        terminal: {
          cols: 100,
          rows: 30,
          data: (_terminal, data) => {
            output += Buffer.from(data).toString();
          },
        },
      },
    );
    const owned = new OwnedProcessTree(driver.pid);
    try {
      await owned.snapshotNow();
      await until(() => output.includes("TUI READY"));
      await owned.snapshotNow();
      if (ending === "quit") driver.terminal!.write("q");
      else if (ending === "disconnected") gateway.stop(true);
      else watcher!.close(ending === "normal-close" ? 1000 : 4001);
      await until(() => output.includes("TERMINAL RESTORED"));
      expect(output).toContain(`ATTACHMENT EXIT ${ending === "quit" ? 0 : 1}`);
      for (const pid of readFileSync(pids, "utf8").trim().split("\n").map(Number)) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
      driver.terminal!.write("still-working\n");
      await until(() => output.includes("TERMINAL INPUT still-working"));
      expect(await driver.exited).toBe(0);
    } finally {
      await owned.signalCaptured("SIGKILL");
      await driver.exited;
      await owned.waitForCapturedExit(1_000);
      owned.stopTracking();
      driver.terminal?.close();
      gateway.stop(true);
      await control.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 12_000);
}
