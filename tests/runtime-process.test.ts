import { describe, expect, test } from "bun:test";
import { runtimeWorkerCommand } from "../src/runtime-control/process.ts";

describe("runtime worker command", () => {
  test("runs the main module when executing from a source checkout", () => {
    expect(
      runtimeWorkerCommand(
        7,
        undefined,
        "/opt/homebrew/bin/bun",
        "file:///Users/example/code/agentvoice/src/runtime-control/process.ts",
      ),
    ).toEqual([
      "/opt/homebrew/bin/bun",
      ["/Users/example/code/agentvoice/src/main.ts", "__runtime-worker", "7"],
    ]);
  });

  test("self-dispatches instead of executing a virtual Bun standalone path", () => {
    expect(
      runtimeWorkerCommand(
        8,
        undefined,
        "/data/data/com.termux/files/home/.local/bin/agentvoice",
        "file:///$bunfs/root/src/runtime-control/process.ts",
      ),
    ).toEqual([
      "/data/data/com.termux/files/home/.local/bin/agentvoice",
      ["__runtime-worker", "8"],
    ]);
  });

  test("preserves an explicit worker fixture", () => {
    expect(runtimeWorkerCommand(9, "/tmp/worker.ts", "/opt/homebrew/bin/bun")).toEqual([
      "/opt/homebrew/bin/bun",
      ["/tmp/worker.ts", "9"],
    ]);
  });
});
