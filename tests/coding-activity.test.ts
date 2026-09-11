import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadView } from "../src/events/contract.ts";
import { connectFrontend } from "../src/frontend/client.ts";
import { frontendSocketPath } from "../src/frontend/protocol.ts";
import { VoiceServer } from "../src/frontend/server.ts";
import type { InFlight } from "../src/mailbox/contract.ts";
import { parseArgs } from "../src/main.ts";
import { CodingActivityReducer } from "../src/runtime-control/coding-activity.ts";
import { RuntimeController } from "../src/runtime-control/controller.ts";
import type { RuntimeProcess } from "../src/runtime-control/process.ts";

const root = (change: Partial<ThreadView> = {}): ThreadView => ({
  id: "root",
  name: null,
  parentThreadId: null,
  status: "idle",
  activeFlags: [],
  turn: null,
  ...change,
});
const turn = (id: string, status: NonNullable<ThreadView["turn"]>["status"]): ThreadView =>
  root({ status: "active", turn: { id, status } });
const children = (revision = 1, waiting = false, complete = true): InFlight => ({
  revision,
  complete,
  observedAt: "2026-09-10T00:00:00.000Z",
  threads: [
    {
      threadId: "child",
      turnId: "child-turn",
      name: null,
      agentPath: null,
      waitingOn: waiting ? ["waitingOnApproval"] : [],
    },
  ],
});
function setup() {
  const activity = new CodingActivityReducer();
  activity.reset("root");
  const update = (view: ThreadView = root()) =>
    activity.threads({ complete: true, threads: [view] });
  update();
  activity.inFlight({ ...children(), threads: [] });
  return { activity, update };
}

test("coding activity distinguishes observed work, human waits, idle and incomplete inventory", () => {
  const { activity, update } = setup();
  expect(activity.state()).toBe("idle");
  update(root({ status: "active", activeFlags: ["waitingOnUserInput"] }));
  expect(activity.state()).toBe("blocked");
  activity.inFlight(children(2, false, false));
  expect(activity.state()).toBe("working");
  activity.inFlight(children(3, true, false));
  expect(activity.state()).toBe("unknown");
  activity.inFlight(children(4, true));
  expect(activity.state()).toBe("blocked");
  update(turn("local-read", "inProgress"));
  expect(activity.state()).toBe("working");
  update(turn("local-read", "completed"));
  expect(activity.state()).toBe("blocked");
  activity.inFlight({ ...children(5), threads: [] });
  expect(activity.state()).toBe("idle");
  activity.childrenGap();
  expect(activity.state()).toBe("unknown");
  activity.inFlight(children(4));
  expect(activity.state()).toBe("unknown");
  activity.inFlight({ ...children(6), threads: [] });
  expect(activity.state()).toBe("idle");
});

test("coding activity fences terminal turns, late starts and old completions without trusting coarse active", () => {
  for (const terminal of ["completed", "failed", "interrupted"] as const) {
    const { activity, update } = setup();
    update(turn("old", "inProgress"));
    update(turn("new", "inProgress"));
    update(turn("old", terminal));
    expect(activity.state()).toBe("working");
    update(turn("new", terminal));
    expect(activity.state()).toBe("idle");
    update(root({ status: "active" }));
    expect(activity.state()).toBe("idle");
    update(turn("new", "inProgress"));
    expect(activity.state()).toBe("idle");
    update(turn("old", "inProgress"));
    expect(activity.state()).toBe("idle");
    update(turn("future", terminal));
    update(turn("future", "inProgress"));
    expect(activity.state()).toBe("idle");
    update(turn("next", "inProgress"));
    expect(activity.state()).toBe("working");
  }
});

test("coding activity excludes unrelated inventory and clears unload, gaps and runtime replacements", () => {
  const { activity, update } = setup();
  activity.threads({
    complete: true,
    threads: [root(), { ...turn("foreign", "inProgress"), id: "other" }],
  });
  expect(activity.state()).toBe("idle");
  update(turn("active", "inProgress"));
  activity.threads({ complete: true, threads: [] });
  expect(activity.state()).toBe("unknown");
  update(turn("active", "inProgress"));
  expect(activity.state()).toBe("idle");
  update(turn("successor", "inProgress"));
  update({ ...turn("successor", "inProgress"), status: "systemError" });
  expect(activity.state()).toBe("unknown");
  activity.inFlight(children(2));
  expect(activity.state()).toBe("working");
  activity.reset("root");
  expect(activity.state()).toBe("unknown");
  update(root());
  expect(activity.state()).toBe("unknown");
  activity.inFlight({ ...children(1), threads: [] });
  expect(activity.state()).toBe("idle");
  activity.rootGap();
  expect(activity.state()).toBe("unknown");
});

test("coding activity bounds root turn tombstones without evicting and resurrecting old work", () => {
  const { activity, update } = setup();
  for (let n = 0; n < 4097; n++) update(turn(String(n), "completed"));
  expect(activity.state()).toBe("unknown");
  update(turn("0", "inProgress"));
  expect(activity.state()).toBe("unknown");
});

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

test("coding activity reaches frontend clients and survives voice-only changes but not replacement or disconnect", async () => {
  const directory = mkdtempSync(join(tmpdir(), "av-coding-"));
  const callbacks: Array<(method: string, params: unknown) => void> = [];
  let controller!: RuntimeController;
  const server = new VoiceServer(frontendSocketPath(directory), async (changed) => {
    controller = new RuntimeController({
      instanceId: "coding",
      stateDir: directory,
      version: "test",
      changed,
      provenance: {
        parsed: parseArgs([]),
        launchCwd: directory,
        options: { debug: false, fresh: false, continue: false },
      },
      control: { name: "agentvoice", server: {}, tools: [], env: {} },
      lease: () => () => {},
      spawn: (_generation, event, lease) => {
        callbacks.push(event);
        const process = {
          pid: 100 + callbacks.length,
          request: async (method: string) => {
            if (method === "preflight") return { workspace: directory, buildId: "test" };
            if (method === "activate") {
              await lease("root");
              event("identity", { workspace: directory, threadId: "root" });
              event("state", {
                available: true,
                phase: "live",
                mic: { muted: true, effectiveMuted: true },
                speaker: { muted: false, effectiveMuted: false },
              });
            }
            return null;
          },
          notify() {},
          stop: async () => false,
        } as unknown as RuntimeProcess;
        return process;
      },
    });
    return {
      state: () => controller.state(),
      start: () => controller.start(),
      command() {},
      close: () => controller.shutdown(),
    };
  });
  let client: Awaited<ReturnType<typeof connectFrontend>> | undefined;
  try {
    await server.start();
    client = await connectFrontend(server.path);
    await until(() => controller.status().runtime.phase === "ready");
    const emit = callbacks[0]!;
    emit("threads", { complete: true, threads: [root()] });
    emit("mailbox", { kind: "inventory", inventory: { ...children(), threads: [] } });
    await until(() => client!.state().codingActivity === "idle");
    emit("mailbox", { kind: "inventory", inventory: children(2) });
    await until(() => client!.state().codingActivity === "working");
    emit("mailbox", { kind: "inventory", inventory: children(3, true) });
    await until(() => client!.state().codingActivity === "blocked");
    emit("mailbox", { kind: "gap", reason: "inventory" });
    await until(() => client!.state().codingActivity === "unknown");
    emit("mailbox", { kind: "inventory", inventory: children(2) });
    expect(controller.state().codingActivity).toBe("unknown");
    emit("mailbox", { kind: "inventory", inventory: { ...children(4), threads: [] } });
    await until(() => client!.state().codingActivity === "idle");
    emit("threads", { complete: true, threads: [turn("read", "inProgress")] });
    await until(() => client!.state().codingActivity === "working");
    expect(JSON.stringify(client.state())).not.toMatch(/root|child|read|threadId|turnId/);
    const request = (operationId: string) => ({
      operationId,
      expectedInstanceId: "coding",
      expectedGeneration: controller.status().generation,
    });
    await controller.redial(request("redial"));
    await until(() => controller.status().currentOperation?.phase === "ready");
    expect(controller.state().codingActivity).toBe("working");
    await controller.restart({ ...request("restart"), scope: "runtime" });
    await until(
      () =>
        controller.status().generation === 2 &&
        controller.status().currentOperation?.phase === "ready",
    );
    await until(() => client!.state().codingActivity === "unknown");
    emit("threads", { complete: true, threads: [turn("stale", "inProgress")] });
    emit("mailbox", { kind: "inventory", inventory: children(100) });
    expect(controller.state().codingActivity).toBe("unknown");
    callbacks[1]!("threads", { complete: true, threads: [turn("fresh", "inProgress")] });
    await until(() => client!.state().codingActivity === "working");
    callbacks[1]!("fatal", { message: "native failure" });
    expect(controller.state().codingActivity).toBe("unknown");
    callbacks[1]!("threads", { complete: true, threads: [turn("too-late", "inProgress")] });
    expect(controller.state().codingActivity).toBe("unknown");
    await client.close();
    expect(client.state().codingActivity).toBe("unknown");
  } finally {
    await client?.close();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
