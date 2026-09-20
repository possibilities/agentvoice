import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadView } from "../src/events/contract.ts";
import { connectFrontend } from "../src/frontend/client.ts";
import { frontendSocketPath } from "../src/frontend/protocol.ts";
import { VoiceServer } from "../src/frontend/server.ts";
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
const child = (waiting = false): ThreadView => ({
  id: "child",
  parentThreadId: "root",
  name: null,
  status: "active",
  activeFlags: waiting ? ["waitingOnApproval"] : [],
  turn: { id: "child-turn", status: "inProgress" },
});
function setup() {
  const activity = new CodingActivityReducer();
  activity.reset("root");
  const update = (view: ThreadView = root(), children: ThreadView[] = [], complete = true) =>
    activity.threads({ complete, threads: [view, ...children] });
  update();
  return { activity, update };
}

test("coding activity distinguishes observed work, human waits, idle and incomplete inventory", () => {
  const { activity, update } = setup();
  expect(activity.state()).toBe("idle");
  update(root({ status: "active", activeFlags: ["waitingOnUserInput"] }));
  expect(activity.state()).toBe("blocked");
  update(root(), [child()], false);
  expect(activity.state()).toBe("working");
  update(root(), [child(true)], false);
  expect(activity.state()).toBe("unknown");
  update(root(), [child(true)]);
  expect(activity.state()).toBe("blocked");
  update(turn("local-read", "inProgress"), [child(true)]);
  expect(activity.state()).toBe("working");
  update(turn("local-read", "completed"));
  expect(activity.state()).toBe("idle");
  update(root(), [], false);
  expect(activity.state()).toBe("unknown");
  update();
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
  update(root(), [child()]);
  expect(activity.state()).toBe("working");
  activity.reset("root");
  expect(activity.state()).toBe("unknown");
  update(root());
  expect(activity.state()).toBe("idle");
  activity.rootGap();
  expect(activity.state()).toBe("unknown");
});

test("terminal direct-child turns override trailing coarse active state", () => {
  const { activity, update } = setup();
  const completed = { ...child(), turn: { id: "child-turn", status: "completed" as const } };
  update(root(), [completed]);
  expect(activity.state()).toBe("idle");
  update(root(), [{ ...completed, turn: { id: "next", status: "inProgress" } }]);
  expect(activity.state()).toBe("working");
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

test("coding activity survives frontend reconnect and voice-only changes, then resets on runtime replacement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "av-coding-"));
  const callbacks: Array<(method: string, params: unknown) => void> = [];
  const frontendAttachments: boolean[] = [];
  let calls = 0;
  let controller!: RuntimeController;
  const server = new VoiceServer(frontendSocketPath(directory), async (changed) => {
    calls++;
    controller = new RuntimeController({
      instanceId: "coding",
      stateDir: directory,
      version: "test",
      changed,
      provenance: {
        parsed: parseArgs([]),
        launchCwd: directory,
        options: { debug: false },
      },
      control: { name: "agentvoice", server: {}, tools: [], env: {} },
      lease: () => () => {},
      spawn: (_generation, event, lease) => {
        callbacks.push(event);
        const process = {
          pid: 100 + callbacks.length,
          request: async (method: string, params?: unknown) => {
            if (method === "frontend") {
              frontendAttachments.push((params as { attached: boolean }).attached);
              return null;
            }
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
      setFrontendAttached: (attached) => controller.setFrontendAttached(attached),
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
    await until(() => client!.state().codingActivity === "idle");
    emit("threads", { complete: true, threads: [root(), child()] });
    await until(() => client!.state().codingActivity === "working");
    const retained = controller;
    const retainedIdentity = {
      workspace: controller.status().workspace,
      threadId: controller.status().threadId,
    };
    await client.close();
    await until(() => frontendAttachments.includes(false));
    expect(controller).toBe(retained);
    expect(controller.state().codingActivity).toBe("working");
    client = await connectFrontend(server.path);
    await until(() => client!.state().codingActivity === "working");
    expect(calls).toBe(1);
    expect(controller).toBe(retained);
    expect({
      workspace: controller.status().workspace,
      threadId: controller.status().threadId,
    }).toEqual(retainedIdentity);
    expect(frontendAttachments).toEqual([true, false, true]);
    emit("threads", { complete: true, threads: [root(), child(true)] });
    await until(() => client!.state().codingActivity === "blocked");
    emit("threads", { complete: false, threads: [root(), child(true)] });
    await until(() => client!.state().codingActivity === "unknown");
    emit("threads", { complete: true, threads: [root()] });
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
