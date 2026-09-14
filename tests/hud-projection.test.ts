import { expect, test } from "bun:test";
import { projectHud } from "../src/hud/projection.ts";
import type { WorkSnapshot } from "../src/hud/types.ts";
import type { ThreadMonitor, ThreadRow } from "../src/threads/monitor.ts";

const row = (
  id: string,
  parentThreadId: string | null,
  status: ThreadRow["status"] = "active",
): ThreadRow => ({
  id,
  parentThreadId,
  name: id,
  status,
  activeFlags: [],
  turn: { id: `turn-${id}`, status: status === "active" ? "inProgress" : "completed" },
});
const empty: WorkSnapshot = { revision: 0, works: [], assignments: [], results: [], events: [] };
const monitor: ThreadMonitor = {
  instanceId: "instance",
  generation: 1,
  sequence: 10,
  rootThreadId: "root",
  workspace: "/fixture",
  phase: "ready",
  inventory: "ready",
  missingSettings: 3,
  threads: [
    row("root", null),
    row("child", "root"),
    row("grandchild", "child"),
    row("idle", "root", "idle"),
  ],
};
test("all native depths count, coordinator is separate, idle is not work", () => {
  const hud = projectHud(empty, monitor);
  expect(hud.native.counts).toEqual({
    knownWorking: 2,
    waiting: 0,
    idle: 1,
    failed: 0,
    loaded: 3,
    exact: true,
  });
  expect(hud.native.coordinator?.id).toBe("root");
  expect(hud.unassignedThreads).toHaveLength(3);
});
test("incomplete and unavailable cuts never claim exact zero or retain stale green rows", () => {
  expect(projectHud(empty, { ...monitor, inventory: "incomplete" }).native.counts.exact).toBe(
    false,
  );
  const unavailable = projectHud(empty, { ...monitor, inventory: "unavailable" });
  expect(unavailable.native.availability).toBe("unavailable");
  expect(unavailable.native.threads).toEqual([]);
  expect(unavailable.native.counts.exact).toBe(false);
});
test("notLoaded rows with an old active turn do not count as working or loaded", () => {
  const unloaded = row("closed", "root", "notLoaded");
  unloaded.turn = { id: "old", status: "inProgress" };
  const hud = projectHud(empty, { ...monitor, threads: [unloaded] });
  expect(hud.native.counts.knownWorking).toBe(0);
  expect(hud.native.counts.loaded).toBe(0);
});
test("association fences include runtime instance, generation, root and turn; unresolved Work counts are inexact", () => {
  const base = {
    id: "a",
    revision: 1,
    createdAt: "now",
    updatedAt: "now",
    workId: "w",
    parentAssignmentId: null,
    issuer: "lead",
    assignee: "worker",
    taskName: "child",
    resultContract: "artifact",
    binding: {
      instanceId: "instance",
      generation: 1,
      rootThreadId: "root",
      threadId: "child",
      turnId: "turn-child",
      evidence: [{ ref: "fixture:dispatch" }],
    },
  };
  const store: WorkSnapshot = {
    ...empty,
    works: [
      {
        id: "w",
        revision: 1,
        createdAt: "now",
        updatedAt: "now",
        objective: "Task",
        scope: "Scope",
        authority: [{ ref: "fixture:authority" }],
        lead: "lead",
        parentId: null,
        dependencies: [],
        priority: 0,
        disposition: "active",
        nextAction: "Review",
        attentionRefs: [],
      },
    ],
    assignments: [base],
  };
  expect(projectHud(store, monitor).workViews[0]?.counts.knownWorking).toBe(1);
  for (const patch of [
    { instanceId: "other" },
    { generation: 2 },
    { rootThreadId: "other" },
    { turnId: "other" },
  ]) {
    const hud = projectHud(
      { ...store, assignments: [{ ...base, binding: { ...base.binding, ...patch } }] },
      monitor,
    );
    expect(hud.workViews[0]?.counts.knownWorking).toBe(0);
    expect(hud.workViews[0]?.counts.exact).toBe(false);
    expect(hud.native.counts.exact).toBe(true);
    expect(hud.unassignedThreads.some((thread) => thread.id === "child")).toBe(true);
  }
  const unbound = projectHud({ ...store, assignments: [{ ...base, binding: null }] }, monitor);
  expect(unbound.workViews[0]?.assignmentViews[0]?.execution).toBe("dispatch_unknown");
  expect(unbound.workViews[0]?.counts.exact).toBe(false);
});
test("read-only discovery retries only compatible legacy status protocols and keeps exact selection", async () => {
  const { discoverObservedController } = await import("../src/threads/monitor.ts");
  const calls: unknown[][] = [];
  const fixture = { status: { instanceId: "instance" } } as Awaited<
    ReturnType<typeof discoverObservedController>
  >;
  const result = await discoverObservedController(
    "/fixture/state",
    "/fixture/workspace",
    "root",
    async (...args) => {
      calls.push(args);
      if (args[3] !== 5) throw new Error("no live AgentVoice controller for fixture");
      return fixture;
    },
  );
  expect(result).toBe(fixture);
  expect(calls).toEqual([
    ["/fixture/state", "/fixture/workspace", "root", undefined],
    ["/fixture/state", "/fixture/workspace", "root", 6],
    ["/fixture/state", "/fixture/workspace", "root", 5],
  ]);
  let count = 0;
  await expect(
    discoverObservedController("/fixture/state", "/fixture/workspace", "root", async () => {
      count++;
      throw new Error("ambiguous controller");
    }),
  ).rejects.toThrow("ambiguous");
  expect(count).toBe(1);
});
test("read-only compatibility discovery checks every protocol and rejects mixed-runtime ambiguity", async () => {
  const { discoverObservedController } = await import("../src/threads/monitor.ts");
  const candidate = (instanceId: string, generation = 1) =>
    ({
      status: { instanceId, generation, workspace: "/fixture/workspace", threadId: "root" },
    }) as Awaited<ReturnType<typeof discoverObservedController>>;
  const versions: (number | undefined)[] = [];
  await expect(
    discoverObservedController(
      "/fixture/state",
      "/fixture/workspace",
      "root",
      async (_state, _workspace, _thread, version) => {
        versions.push(version);
        if (version === 5) throw new Error("no live AgentVoice controller");
        return candidate(version === 6 ? "legacy" : "current");
      },
    ),
  ).rejects.toThrow("ambiguous");
  expect(versions).toEqual([undefined, 6, 5]);
  const same = candidate("same");
  let probes = 0;
  expect(
    await discoverObservedController("/fixture/state", "/fixture/workspace", "root", async () => {
      probes++;
      return same;
    }),
  ).toBe(same);
  expect(probes).toBe(3);
  await expect(
    discoverObservedController(
      "/fixture/state",
      "/fixture/workspace",
      "root",
      async (_state, _workspace, _thread, version) => candidate("same", version === 6 ? 2 : 1),
    ),
  ).rejects.toThrow("ambiguous");
});
