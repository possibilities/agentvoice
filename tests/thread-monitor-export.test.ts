import { expect, test } from "bun:test";
import { runThreadsCommand } from "../src/threads/command.ts";
import { exportThreadMonitor, threadMonitorExportSchema } from "../src/threads/export.ts";
import type { ThreadMonitor } from "../src/threads/monitor.ts";

const monitor: ThreadMonitor = {
  instanceId: "instance",
  generation: 2,
  sequence: 9,
  rootThreadId: "root",
  nativeSessionId: "root",
  workspace: "/fixture",
  phase: "ready",
  inventory: "ready",
  historyCoverage: "complete",
  missingSettings: 1,
  threads: [
    {
      id: "root",
      parentThreadId: null,
      name: "Coordinator",
      status: "active",
      activeFlags: [],
      turn: { id: "turn", status: "inProgress", startedAt: 1_700_000_000 },
      parentage: { state: "root", sources: ["live_inventory"] },
      collaborationIdentity: { state: "root", sources: ["live_inventory"] },
    },
  ],
};
test("JSON command exports versioned exact metadata and excludes incidental private fields", async () => {
  let output = "";
  const privateMonitor = {
    ...monitor,
    token: "private-secret",
    socketPath: "/private/socket",
    threads: [{ ...monitor.threads[0]!, token: "private-row-secret" }],
  };
  expect(
    await runThreadsCommand(["--json"], "/fixture/state", {
      observe: async () => privateMonitor,
      write: (text) => {
        output += text;
      },
    }),
  ).toBe(0);
  const exported = threadMonitorExportSchema.parse(JSON.parse(output));
  expect(exported.schemaVersion).toBe(5);
  expect(exported.monitor).toEqual({ ...monitor, exactTurns: [] } as typeof exported.monitor);
  expect(output).not.toContain("secret");
  expect(output).not.toContain("socket");
});
test("command waits for its writer before reporting a complete export", async () => {
  let output = "";
  let released = false;
  const result = runThreadsCommand(["--json"], "/fixture/state", {
    observe: async () => monitor,
    write: async (text) => {
      await Bun.sleep(10);
      output = text;
      released = true;
    },
  });
  expect(released).toBe(false);
  expect(await result).toBe(0);
  expect(released).toBe(true);
  const exported = threadMonitorExportSchema.parse(JSON.parse(output));
  expect(exported.monitor).toEqual({ ...monitor, exactTurns: [] } as typeof exported.monitor);
});
test("JSON observation failure exports unavailable and exits nonzero without leaking diagnostics", async () => {
  let output = "";
  expect(
    await runThreadsCommand(["--json"], "/fixture/state", {
      observe: async () => {
        throw new Error("private capability");
      },
      write: (text) => {
        output += text;
      },
    }),
  ).toBe(1);
  expect(JSON.parse(output).monitor).toEqual({
    phase: "unavailable",
    inventory: "unavailable",
    historyCoverage: "unavailable",
    exactTurns: [],
    threads: [],
    missingSettings: 0,
  });
  expect(output).not.toContain("capability");
});
test("text default and argument validation remain compatible", async () => {
  let output = "";
  expect(
    await runThreadsCommand([], "/fixture/state", {
      observe: async () => monitor,
      write: (text) => {
        output += text;
      },
    }),
  ).toBe(0);
  expect(output).toContain("Coordinator");
  expect(output.startsWith("{")).toBe(false);
  await expect(runThreadsCommand(["--json", "--json"], "/fixture/state")).rejects.toThrow(
    "more than once",
  );
  await expect(runThreadsCommand(["--json=yes"], "/fixture/state")).rejects.toThrow(
    "takes no value",
  );
});
test("export validates identity and all-depth rows without inventing availability", () => {
  expect(() => exportThreadMonitor({ ...monitor, generation: undefined })).toThrow(
    "exact native identity",
  );
  expect(() =>
    exportThreadMonitor({ ...monitor, threads: [monitor.threads[0]!, monitor.threads[0]!] }),
  ).toThrow("unique");
  const offline = exportThreadMonitor({ ...monitor, inventory: "unavailable" });
  expect(offline.monitor.threads).toEqual([]);
  expect(offline.monitor.inventory).toBe("unavailable");
  expect(() =>
    exportThreadMonitor({
      ...monitor,
      historyCoverage: "unavailable",
      threads: [
        {
          ...monitor.threads[0]!,
          parentage: { state: "root", sources: ["native_history"] },
        },
      ],
    }),
  ).toThrow("cannot source thread parentage");
});
test("ready inventory must include its parentless root; incomplete cuts can omit it", () => {
  expect(() => exportThreadMonitor({ ...monitor, threads: [] })).toThrow("parentless root");
  expect(() =>
    exportThreadMonitor({
      ...monitor,
      threads: [{ ...monitor.threads[0]!, parentThreadId: "other" }],
    }),
  ).toThrow("parentless root");
  expect(
    exportThreadMonitor({ ...monitor, inventory: "incomplete", threads: [] }).monitor.inventory,
  ).toBe("incomplete");
});
test("version four freezes native row, timing and collaboration identity bounds", () => {
  const root = monitor.threads[0]!;
  for (const patch of [
    { id: "bad/id" },
    { id: "x".repeat(257) },
    { parentThreadId: "bad/id" },
    { name: "x".repeat(257) },
    { turn: { id: "bad/id", status: "inProgress" as const } },
    { turn: { id: "x".repeat(257), status: "inProgress" as const } },
    { turn: { id: "turn", status: "inProgress" as const, startedAt: -1 } },
    { turn: { id: "turn", status: "completed" as const, completedAt: 1.5 } },
  ])
    expect(() => exportThreadMonitor({ ...monitor, threads: [{ ...root, ...patch }] })).toThrow();
  const accepted = exportThreadMonitor({
    ...monitor,
    threads: [
      {
        ...root,
        name: "x".repeat(256),
        model: "x".repeat(256),
        effort: "x".repeat(256),
        nickname: "x".repeat(256),
        turn: {
          id: "x".repeat(256),
          status: "completed",
          startedAt: 1_700_000_000,
          completedAt: 1_700_000_100,
        },
      },
    ],
  });
  expect(accepted.monitor.threads).toHaveLength(1);
  expect(
    exportThreadMonitor({
      ...monitor,
      threads: [{ ...root, turn: { id: "legacy-turn", status: "failed" } }],
    }).monitor.threads[0]?.turn,
  ).toEqual({ id: "legacy-turn", status: "failed" });
  expect(() =>
    exportThreadMonitor({
      ...monitor,
      threads: [
        {
          ...root,
          id: "worker",
          parentThreadId: "root",
          parentage: {
            state: "verified",
            parentThreadId: "root",
            sources: ["native_history"],
          },
          collaborationIdentity: {
            state: "verified",
            path: "/root/Bad-Name",
            sources: ["native_history"],
          },
        },
      ],
      inventory: "incomplete",
    }),
  ).toThrow();
});
test("oversized escaped JSON is rejected and command returns bounded unavailable instead of truncating", async () => {
  const escaped = String.fromCharCode(0).repeat(256);
  const oversized: ThreadMonitor = {
    ...monitor,
    threads: Array.from({ length: 256 }, (_, index) => ({
      ...monitor.threads[0]!,
      id: index === 0 ? "root" : `thread-${index}`,
      parentThreadId: index === 0 ? null : "root",
      parentage:
        index === 0
          ? { state: "root" as const, sources: ["live_inventory" as const] }
          : {
              state: "verified" as const,
              parentThreadId: "root",
              sources: ["live_inventory" as const],
            },
      name: escaped,
      model: escaped,
      effort: escaped,
      nickname: escaped,
    })),
  };
  expect(() => exportThreadMonitor(oversized)).toThrow("output bound");
  let output = "";
  expect(
    await runThreadsCommand(["--json"], "/fixture/state", {
      observe: async () => oversized,
      write: (text) => {
        output += text;
      },
    }),
  ).toBe(1);
  expect(JSON.parse(output).monitor.inventory).toBe("unavailable");
  expect(JSON.parse(output).monitor.threads).toEqual([]);
  expect(Buffer.byteLength(output)).toBeLessThan(1024 * 1024);
});

test("v5 shared fixture freezes the independent consumer metadata contract", async () => {
  const fixture = await Bun.file(
    new URL("./fixtures/exact-turn-monitor-v5.json", import.meta.url),
  ).json();
  expect(exportThreadMonitor(fixture.monitor, fixture.observedAt)).toEqual(fixture);
  const target = { rootThreadId: "root", threadId: "worker", turnId: "bound-turn" };
  let received: unknown;
  await runThreadsCommand(
    ["--json", "--timing-targets", JSON.stringify([target])],
    "/fixture/state",
    {
      observe: async (_state, _workspace, _root, targets) => {
        received = targets;
        return monitor;
      },
      write: () => {},
    },
  );
  expect(received).toEqual([target]);
});
