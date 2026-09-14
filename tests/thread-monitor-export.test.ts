import { expect, test } from "bun:test";
import { runThreadsCommand } from "../src/threads/command.ts";
import { exportThreadMonitor, threadMonitorExportSchema } from "../src/threads/export.ts";
import type { ThreadMonitor } from "../src/threads/monitor.ts";

const monitor: ThreadMonitor = {
  instanceId: "instance",
  generation: 2,
  sequence: 9,
  rootThreadId: "root",
  workspace: "/fixture",
  phase: "ready",
  inventory: "ready",
  missingSettings: 1,
  threads: [
    {
      id: "root",
      parentThreadId: null,
      name: "Coordinator",
      status: "active",
      activeFlags: [],
      turn: { id: "turn", status: "inProgress" },
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
  expect(exported.schemaVersion).toBe(1);
  expect(exported.monitor).toEqual(monitor);
  expect(output).not.toContain("secret");
  expect(output).not.toContain("socket");
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
});
