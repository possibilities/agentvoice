import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHookRecord, hookLogPath } from "../src/hook-log.ts";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "agentsurface-hook-log-"));
  roots.push(root);
  return root;
}

function record(paneId: string): Parameters<typeof appendHookRecord>[1] {
  return {
    at: "2026-08-20T02:17:40.371Z",
    pid: 1910,
    phase: "tokens",
    event: "pane.agent_detected",
    paneId,
    outcomes: { project: "ok", conversation: "ok" },
    held: { project: "agentvoice", conversation: "voice-chat-extraction-and-assembly" },
  };
}

describe("appendHookRecord", () => {
  test("keeps a detection's outcomes where a restart cannot evict them", () => {
    const dir = stateDir();
    appendHookRecord(dir, record("w7:pB"));

    const lines = readFileSync(hookLogPath(dir), "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!)).toEqual(record("w7:pB"));
  });

  test("trims to the most recent records", () => {
    const dir = stateDir();
    for (let index = 0; index < 520; index += 1) appendHookRecord(dir, record(`w1:p${index}`));

    const lines = readFileSync(hookLogPath(dir), "utf8").trim().split("\n");
    expect(lines.length).toBe(500);
    expect(JSON.parse(lines[0]!).paneId).toBe("w1:p20");
    expect(JSON.parse(lines[499]!).paneId).toBe("w1:p519");
  });

  test("an unwritable state directory costs the run nothing", () => {
    const dir = stateDir();
    const path = join(dir, "occupied");
    writeFileSync(path, "");
    // A file where the directory should be: the append cannot land, and the
    // hook must carry on regardless — the naming is worth more than its log.
    expect(() => appendHookRecord(path, record("w1:p1"))).not.toThrow();
  });
});
