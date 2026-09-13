import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionMarker, saveSessionMarker } from "../src/core/session-marker.ts";
import { parseArgs } from "../src/main.ts";
import { RuntimeController } from "../src/runtime-control/controller.ts";
import type { RuntimeActivation } from "../src/runtime-control/protocol.ts";

for (const failure of ["cleanup", "activation", "none"] as const) {
  test(`new session ${failure}: cleanup precedes deletion, retry preserves identity and stale events are fenced`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "av-new-session-")));
    saveSessionMarker(root, "old-thread");
    const callbacks: Array<(method: string, params: unknown) => void> = [];
    const activations: RuntimeActivation[] = [];
    let failCleanup = failure === "cleanup";
    const controller = new RuntimeController({
      instanceId: "new-session-test",
      stateDir: root,
      version: "test",
      provenance: { parsed: parseArgs([]), options: { debug: false }, launchCwd: root },
      control: { name: "agentvoice_control", server: {}, tools: [], env: {} },
      lease: () => () => {},
      spawn: (_generation, event, lease) => {
        callbacks.push(event);
        const index = callbacks.length;
        const exit = Promise.withResolvers<void>();
        return {
          pid: index,
          nativePid: undefined,
          exited: exit.promise,
          notify() {},
          stop: async () => {
            if (index === 1 && failCleanup) throw new Error("Owned cleanup is incomplete");
            exit.resolve();
            return false;
          },
          request: async <T>(method: string, params?: unknown): Promise<T> => {
            if (method === "preflight")
              return { workspace: root, buildId: "test", pid: index } as T;
            if (method === "activate") {
              const input = params as RuntimeActivation;
              activations.push(input);
              const saved = readSessionMarker(root);
              const id = input.threadId ?? saved ?? "new-thread";
              if (saved === null) saveSessionMarker(root, id);
              await lease(id);
              event("identity", { workspace: root, threadId: id });
              if (index === 2 && failure === "activation")
                throw new Error("Media activation failed");
            }
            return null as T;
          },
        };
      },
    });
    const request = (operationId: string) => ({
      operationId,
      expectedGeneration: controller.status().generation,
      expectedInstanceId: "new-session-test",
    });
    const settled = async () => {
      const deadline = Date.now() + 2000;
      while (
        !["ready", "failed"].includes(controller.status().currentOperation?.phase ?? "") &&
        Date.now() < deadline
      )
        await Bun.sleep(5);
      expect(["ready", "failed"]).toContain(controller.status().currentOperation?.phase ?? "");
    };
    try {
      await controller.start();
      const reset = request("reset");
      await controller.newSession(reset);
      await settled();
      const saved = failure === "cleanup" ? "old-thread" : "new-thread";
      expect(readSessionMarker(root)).toBe(saved);
      expect(controller.status().currentOperation?.phase).toBe(
        failure === "none" ? "ready" : "failed",
      );
      const before = callbacks.length;
      await controller.newSession(reset);
      expect(callbacks).toHaveLength(before);
      callbacks[0]!("identity", { workspace: root, threadId: "old-thread" });
      expect(controller.status().threadId).toBe(saved);
      if (failure !== "none") {
        failCleanup = false;
        await controller.restart({ ...request("retry"), scope: "runtime" });
        await settled();
        expect(controller.status().currentOperation?.phase).toBe("ready");
        expect(controller.status().threadId).toBe(saved);
        expect(activations.at(-1)?.threadId).toBe(saved);
      } else expect(activations[1]?.threadId).toBeUndefined();
      expect(readSessionMarker(root)).toBe(saved);
    } finally {
      failCleanup = false;
      await controller.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
