import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { CompletionRequest } from "../src/completions/contract.ts";
import { parseArgs } from "../src/main.ts";
import { RuntimeController } from "../src/runtime-control/controller.ts";

const at = "2026-09-07T03:00:00.000Z";
const completion = (turnId: string) => ({
  threadId: "child",
  turnId,
  name: "child",
  agentPath: "/root/child",
  waitingOn: [],
  status: "completed",
  observedAt: at,
});
async function setup() {
  const directory = mkdtempSync("/tmp/av-completion-controller-");
  const callbacks: Array<(method: string, params: unknown) => void> = [];
  const activations: Array<{ frontendAttached?: boolean }> = [];
  const frontendAttachments: boolean[] = [];
  const deliveries: CompletionRequest[] = [];
  let deliveryWait: Promise<void> | undefined;
  let mode: "accepted" | "deferred" | "refused" | "unknown" = "accepted";
  const c = new RuntimeController({
    instanceId: "instance",
    stateDir: directory,
    version: "test",
    provenance: {
      parsed: parseArgs([]),
      options: { debug: false },
      launchCwd: directory,
    },
    control: { name: "agentvoice_control", server: {}, tools: [], env: {} },
    lease: () => () => {},
    spawn: (_generation, event, lease) => {
      callbacks.push(event);
      const number = callbacks.length;
      const exit = Promise.withResolvers<void>();
      return {
        pid: number,
        nativePid: undefined,
        exited: exit.promise,
        notify() {},
        stop: async () => {
          exit.resolve();
          return false;
        },
        request: async <T>(method: string, input?: unknown): Promise<T> => {
          if (method === "preflight")
            return { workspace: directory, pid: number, buildId: "test" } as T;
          if (method === "activate") {
            activations.push(input as { frontendAttached?: boolean });
            await lease("root");
            event("identity", { threadId: "root", workspace: directory });
          }
          if (method === "frontend")
            frontendAttachments.push((input as { attached: boolean }).attached);
          if (method === "completion-deliver") {
            const request = input as CompletionRequest;
            deliveries.push(request);
            if (deliveryWait) await deliveryWait;
            if (mode === "unknown") throw new Error("response lost");
            if (mode === "refused") return { status: "refused" } as T;
            if (mode === "deferred") return { status: "deferred" } as T;
            return { status: "accepted", turnId: "active-parent" } as T;
          }
          return null as T;
        },
      };
    },
  });
  await c.start();
  const emit = (turnId: string, callback = callbacks.at(-1)!) =>
    callback("completion", { kind: "completed", completion: completion(turnId) });
  return {
    c,
    directory,
    deliveries,
    callbacks,
    activations,
    frontendAttachments,
    emit,
    holdDelivery: (value?: Promise<void>) => {
      deliveryWait = value;
    },
    mode: (value: typeof mode) => {
      mode = value;
    },
    close: async () => {
      await c.shutdown();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("controller immediately delivers distinct terminal turns and deduplicates simultaneous observations", async () => {
  const h = await setup();
  try {
    const wait = Promise.withResolvers<void>();
    h.holdDelivery(wait.promise);
    h.emit("one");
    h.emit("two");
    h.emit("one");
    expect(h.deliveries.map((d) => d.completion.turnId)).toEqual(["one", "two"]);
    expect(new Set(h.deliveries.map((d) => d.eventId)).size).toBe(2);
    expect(h.deliveries[0]).toMatchObject({
      instanceId: "instance",
      rootThreadId: "root",
      completion: completion("one"),
    });
    wait.resolve();
    await Bun.sleep(1);
    h.emit("one");
    h.emit("three");
    expect(h.deliveries.map((d) => d.completion.turnId)).toEqual(["one", "two", "three"]);
  } finally {
    await h.close();
  }
});

test("unknown and refused acceptance are visible and never retried", async () => {
  const h = await setup();
  try {
    h.mode("unknown");
    h.emit("unknown");
    await Bun.sleep(1);
    expect(h.c.state().notice).toContain("delivery unknown");
    h.emit("unknown");
    h.mode("refused");
    h.emit("refused");
    await Bun.sleep(1);
    expect(h.c.state().notice).toContain("delivery refused");
    h.emit("refused");
    expect(h.deliveries).toHaveLength(2);
  } finally {
    await h.close();
  }
});

test("a deferred completion clears controller admission without a failure notice", async () => {
  const h = await setup();
  try {
    h.mode("deferred");
    h.emit("human-speaking");
    await Bun.sleep(1);
    expect(h.c.state().notice).toBeUndefined();
    h.emit("human-speaking");
    expect(h.deliveries).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("detach preserves delivery and runtime replacement preserves dedupe without replaying old completions", async () => {
  const h = await setup();
  const wait = Promise.withResolvers<void>();
  try {
    await h.c.setFrontendAttached(false);
    h.holdDelivery(wait.promise);
    h.emit("old");
    await h.c.restart({
      expectedInstanceId: "instance",
      expectedGeneration: 1,
      operationId: "restart",
      scope: "runtime",
    });
    for (let n = 0; n < 100 && h.c.status().currentOperation?.phase !== "ready"; n++)
      await Bun.sleep(5);
    expect(h.c.status().generation).toBe(2);
    expect(h.activations.map((activation) => activation.frontendAttached)).toEqual([true, false]);
    h.emit("obsolete", h.callbacks[0]);
    h.emit("old");
    expect(h.deliveries).toHaveLength(1);
    wait.resolve();
    h.holdDelivery();
    h.emit("new");
    await Bun.sleep(1);
    expect(h.deliveries.map((d) => d.completion.turnId)).toEqual(["old", "new"]);
    await h.c.setFrontendAttached(true);
    expect(h.frontendAttachments).toEqual([false, true]);
    await h.c.shutdown();
    h.emit("shutdown");
    expect(h.deliveries).toHaveLength(2);
  } finally {
    wait.resolve();
    await h.close();
  }
});

test("observation gaps are explicit and do not invent deliveries", async () => {
  const h = await setup();
  try {
    h.callbacks[0]!("completion", { kind: "gap", reason: "metadata" });
    expect(h.c.state().notice).toContain("observation gap (metadata)");
    h.callbacks[0]!("completion", { kind: "completed", completion: {} });
    expect(h.c.state().notice).toContain("observation was invalid");
    expect(h.deliveries).toHaveLength(0);
  } finally {
    await h.close();
  }
});

test("explicit new session clears old completion identity suppression", async () => {
  const h = await setup();
  try {
    h.emit("same");
    await Bun.sleep(1);
    await h.c.newSession({
      expectedInstanceId: "instance",
      expectedGeneration: 1,
      operationId: "new-session",
    });
    for (let n = 0; n < 100 && h.c.status().currentOperation?.phase !== "ready"; n++)
      await Bun.sleep(5);
    expect(h.c.status().generation).toBe(2);
    h.emit("same");
    expect(h.deliveries).toHaveLength(2);
  } finally {
    await h.close();
  }
});
