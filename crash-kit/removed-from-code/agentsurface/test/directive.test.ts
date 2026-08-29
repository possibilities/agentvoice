import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  executeDirective,
  findProjectWorkspace,
  LaunchFailure,
  launchFailureBody,
  writeIntentFile,
} from "../src/directive.ts";
import type { SessionDirective } from "../src/directive-schema.ts";
import type { HerdrCall, HerdrResponse } from "../src/herdr.ts";

let temps: string[] = [];

afterEach(() => {
  for (const temp of temps) rmSync(temp, { recursive: true, force: true });
  temps = [];
});

function logPath(): string {
  const temp = mkdtempSync(join(tmpdir(), "agentsurface-directive-"));
  temps.push(temp);
  return join(temp, "launches.jsonl");
}

/** A canned herdr: records every argv and answers from a queue. */
function fake(responses: HerdrResponse[]): { call: HerdrCall; calls: string[][] } {
  const calls: string[][] = [];
  const queue = [...responses];
  const call: HerdrCall = (args) => {
    calls.push(args);
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return Promise.resolve(next);
  };
  return { call, calls };
}

const DIRECTIVE: SessionDirective = {
  schema_version: 1,
  cwd: "/code/alpha",
  worktree: false,
  focus: false,
  agent: { kind: "claude", args: ["--x-level", "fable:max"] },
  intent: "fix it",
  record: { model: "fable", effort: "max", priming: null },
};

const CREATED: HerdrResponse = {
  result: {
    workspace: { workspace_id: "w9", label: "alpha" },
    tab: { tab_id: "w9:t1" },
    root_pane: { pane_id: "w9:p1" },
  },
};

describe("findProjectWorkspace", () => {
  test("the project label establishes ownership; stable cwd disambiguates duplicates", () => {
    const byStableCwd = fake([
      {
        result: {
          panes: [
            { workspace_id: "w3", cwd: "/elsewhere", foreground_cwd: "/code/alpha/sub" },
            { workspace_id: "w7", cwd: "/code/alpha/sub", foreground_cwd: "/elsewhere" },
          ],
        },
      },
      {
        result: {
          workspaces: [
            { workspace_id: "w3", label: "alpha" },
            { workspace_id: "w7", label: "alpha" },
          ],
        },
      },
    ]);
    expect(findProjectWorkspace(byStableCwd.call, "/code/alpha")).resolves.toBe("w7");

    const byLabel = fake([
      { result: { panes: [{ workspace_id: "w7", cwd: "/elsewhere", foreground_cwd: null }] } },
      { result: { workspaces: [{ workspace_id: "w3", label: "alpha" }] } },
    ]);
    expect(findProjectWorkspace(byLabel.call, "/code/alpha")).resolves.toBe("w3");

    const absent = fake([
      { result: { panes: [] } },
      { result: { workspaces: [{ workspace_id: "w3", label: "other" }] } },
    ]);
    expect(findProjectWorkspace(absent.call, "/code/alpha")).resolves.toBeNull();
  });

  test("an unrelated workspace does not own a project merely because a pane visits it", () => {
    const unrelated = fake([
      {
        result: {
          panes: [
            {
              workspace_id: "w7",
              cwd: "/code/agentvoice",
              foreground_cwd: "/code/alpha",
            },
          ],
        },
      },
      { result: { workspaces: [{ workspace_id: "w7", label: "agentvoice" }] } },
    ]);

    expect(findProjectWorkspace(unrelated.call, "/code/alpha")).resolves.toBeNull();
  });
});

describe("writeIntentFile", () => {
  test("stale spool entries are pruned by age; fresh ones survive", () => {
    const state = dirname(logPath());
    const spool = join(state, "intents");
    mkdirSync(spool, { recursive: true });
    const now = Date.now();
    const stale = join(spool, "stale.txt");
    const fresh = join(spool, "fresh.txt");
    writeFileSync(stale, "old");
    writeFileSync(fresh, "new");
    const old = (now - 25 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, old, old);

    const written = writeIntentFile(state, "the intent", now);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(readFileSync(written, "utf8")).toBe("the intent");
  });
});

describe("executeDirective", () => {
  test("creates an unfocused workspace when the project is absent, retrying a taken name", async () => {
    const { call, calls } = fake([
      { result: { panes: [] } },
      { result: { workspaces: [] } },
      CREATED,
      { result: { agents: [{ name: "claude-1" }] } },
      { error: { code: "agent_name_taken", message: "taken" } },
      { result: { agents: [{ name: "claude-1" }] } },
      { result: {} },
    ]);
    const path = logPath();
    await executeDirective(call, path, DIRECTIVE);

    expect(calls[2]).toEqual([
      "workspace",
      "create",
      "--cwd",
      "/code/alpha",
      "--label",
      "alpha",
      "--no-focus",
    ]);
    const starts = calls.filter((args) => args[0] === "agent" && args[1] === "start");
    expect(starts).toHaveLength(2);
    expect(starts[0]?.[2]).toMatch(/^a-[0-9a-f]{10}$/);
    expect(starts[1]?.[2]).toMatch(/^a-[0-9a-f]{10}$/);
    expect(starts[1]?.[2]).not.toBe(starts[0]?.[2]);
    const start = starts[1] ?? [];
    expect(start.slice(3, 7)).toEqual(["--kind", "claude", "--pane", "w9:p1"]);
    expect(start.slice(start.indexOf("--") + 1)).toEqual([
      "--x-level",
      "fable:max",
      "--x-prompt-file",
      start[start.length - 1] ?? "",
    ]);
    const intentPath = start[start.length - 1] ?? "";
    expect(intentPath.startsWith(join(dirname(path), "intents"))).toBe(true);
    expect(readFileSync(intentPath, "utf8")).toBe("fix it");
    const record = JSON.parse(readFileSync(path, "utf8").trim());
    expect(record.agent).toBe(starts[1]?.[2]);
    expect(record.workspace).toBe("w9");
  });

  test("adds a tab to the hosting workspace and focuses it when asked", async () => {
    const { call, calls } = fake([
      {
        result: {
          panes: [{ workspace_id: "w7", cwd: "/code/alpha", foreground_cwd: "/code/alpha" }],
        },
      },
      { result: { workspaces: [{ workspace_id: "w7", label: "alpha" }] } },
      { result: { tab: { tab_id: "w7:t4" }, root_pane: { pane_id: "w7:p9" } } },
      { result: {} },
      { result: { agents: [] } },
      { result: {} },
    ]);
    const path = logPath();
    await executeDirective(call, path, { ...DIRECTIVE, focus: true });

    expect(calls[2]).toEqual([
      "tab",
      "create",
      "--workspace",
      "w7",
      "--cwd",
      "/code/alpha",
      "--focus",
    ]);
    expect(calls[3]).toEqual(["workspace", "focus", "w7"]);
    const record = JSON.parse(readFileSync(path, "utf8").trim());
    expect(record.workspace).toBe("w7");
    expect(record.agent).toMatch(/^a-[0-9a-f]{10}$/);
  });

  test("a wild intent travels whole as a spool file; the argv stays control-char free", async () => {
    const { call, calls } = fake([
      { result: { panes: [] } },
      { result: { workspaces: [] } },
      CREATED,
      { result: { agents: [] } },
      { result: {} },
    ]);
    const path = logPath();
    const intent = "/collab Survey the fleet.\n\nThen 'quotes', a\ttab, and $dollars.";
    await executeDirective(call, path, { ...DIRECTIVE, intent });

    const start = calls.find((args) => args[0] === "agent" && args[1] === "start");
    for (const arg of start ?? []) {
      expect([...arg].some((ch) => ch < " ")).toBe(false);
    }
    const intentPath = start?.[start.indexOf("--x-prompt-file") + 1] ?? "";
    expect(readFileSync(intentPath, "utf8")).toBe(intent);
  });

  test("a null intent writes no spool file", async () => {
    const { call, calls } = fake([
      { result: { panes: [] } },
      { result: { workspaces: [] } },
      CREATED,
      { result: { agents: [] } },
      { result: {} },
    ]);
    const path = logPath();
    await executeDirective(call, path, { ...DIRECTIVE, intent: null });

    const start = calls.find((args) => args[0] === "agent" && args[1] === "start");
    expect(start).not.toContain("--x-prompt-file");
    expect(existsSync(join(dirname(path), "intents"))).toBe(false);
  });

  test("a worktree directive is branchless; herdr's chosen name lands in the record", async () => {
    const { call, calls } = fake([
      {
        result: {
          ...(CREATED.result as object),
          worktree: { branch: "worktree/calm-cloud-0009" },
        },
      },
      { result: { agents: [] } },
      { result: {} },
    ]);
    const path = logPath();
    await executeDirective(call, path, { ...DIRECTIVE, worktree: true });

    expect(calls[0]).toEqual(["worktree", "create", "--cwd", "/code/alpha", "--no-focus"]);
    const record = JSON.parse(readFileSync(path, "utf8").trim());
    expect(record.branch).toBe("worktree/calm-cloud-0009");
  });

  test("the record carries the directive's extras beside the host's fields", async () => {
    const { call } = fake([
      { result: { panes: [] } },
      { result: { workspaces: [] } },
      CREATED,
      { result: { agents: [] } },
      { result: {} },
    ]);
    const path = logPath();
    await executeDirective(call, path, {
      ...DIRECTIVE,
      record: { model: "fable", effort: "max", priming: "collab", agent: "spoofed" },
    });
    const record = JSON.parse(readFileSync(path, "utf8").trim());
    expect(record.model).toBe("fable");
    expect(record.priming).toBe("collab");
    // The host's own fields win a name collision.
    expect(record.agent).toMatch(/^a-[0-9a-f]{10}$/);
    expect(record.project).toBe("/code/alpha");
    expect(record.harness).toBe("claude");
  });

  test("an unconfirmed name records the launch instead of failing it", async () => {
    const { call } = fake([
      { result: { panes: [] } },
      { result: { workspaces: [] } },
      CREATED,
      { result: { agents: [] } },
      { error: { code: "timeout", message: "timed out waiting for agent startup" } },
    ]);
    const path = logPath();
    await executeDirective(call, path, DIRECTIVE);

    const record = JSON.parse(readFileSync(path, "utf8").trim());
    expect(record.named).toBe(false);
    expect(record.agent).toMatch(/^a-[0-9a-f]{10}$/);
  });

  test("a real failure names the spool file holding the prompt", async () => {
    const { call } = fake([
      { result: { panes: [] } },
      { result: { workspaces: [] } },
      CREATED,
      { result: { agents: [] } },
      { error: { code: "agent_start_failed", message: "exited before becoming interactive" } },
    ]);
    const path = logPath();
    let caught: unknown;
    try {
      await executeDirective(call, path, DIRECTIVE);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LaunchFailure);
    const failure = caught as LaunchFailure;
    expect(failure.message).toBe("exited before becoming interactive");
    expect(readFileSync(failure.intentPath ?? "", "utf8")).toBe("fix it");
    expect(launchFailureBody(failure.message, failure.intentPath)).toContain(
      failure.intentPath ?? "",
    );
    expect(existsSync(path)).toBe(false);
  });
});

const LIVE_AGENTS: HerdrResponse = {
  result: {
    agents: [
      {
        name: "a-0011223344",
        agent: "claude",
        agent_status: "working",
        agent_session: { value: "d65ef6c1-8d74-4b1e-989e-d439bd432b9a" },
        workspace_id: "w3",
        tab_id: "w3:t2",
        pane_id: "w3:p5",
        cwd: "/code/alpha",
      },
    ],
  },
};

const RESUME_DIRECTIVE: SessionDirective = {
  schema_version: 1,
  cwd: "/code/alpha",
  worktree: false,
  focus: true,
  agent: { kind: "claude", args: ["--x-resume", "d65ef6c1-8d74-4b1e-989e-d439bd432b9a"] },
  session_id: "d65ef6c1-8d74-4b1e-989e-d439bd432b9a",
  intent: null,
  record: { tool: "agentchats" },
};

describe("executeDirective with a session_id", () => {
  test("a session already live is focused, never resumed again", async () => {
    const { call, calls } = fake([LIVE_AGENTS, { result: {} }]);
    const path = logPath();
    await executeDirective(call, path, RESUME_DIRECTIVE);

    expect(calls[0]).toEqual(["agent", "list"]);
    expect(calls).toContainEqual(["workspace", "focus", "w3"]);
    expect(calls).toContainEqual(["tab", "focus", "w3:t2"]);
    expect(calls.some((args) => args.includes("create") || args.includes("start"))).toBe(false);
    const record = JSON.parse(readFileSync(path, "utf8").trim());
    expect(record.focused_existing).toBe(true);
    expect(record.workspace).toBe("w3");
    expect(record.agent).toBe("a-0011223344");
    expect(record.tool).toBe("agentchats");
  });

  test("an unfocused directive leaves a live session exactly where it is", async () => {
    const { call, calls } = fake([LIVE_AGENTS]);
    const path = logPath();
    await executeDirective(call, path, { ...RESUME_DIRECTIVE, focus: false });

    expect(calls).toEqual([["agent", "list"]]);
    const record = JSON.parse(readFileSync(path, "utf8").trim());
    expect(record.focused_existing).toBe(true);
  });

  test("a session not on the surface resumes normally", async () => {
    const { call, calls } = fake([
      { result: { agents: [] } },
      { result: { panes: [] } },
      { result: { workspaces: [] } },
      CREATED,
      { result: { agents: [] } },
      { result: {} },
    ]);
    const path = logPath();
    await executeDirective(call, path, { ...RESUME_DIRECTIVE, focus: false });

    expect(calls[0]).toEqual(["agent", "list"]);
    const start = calls.find((args) => args[0] === "agent" && args[1] === "start") ?? [];
    expect(start.slice(start.indexOf("--") + 1)).toEqual([
      "--x-resume",
      "d65ef6c1-8d74-4b1e-989e-d439bd432b9a",
    ]);
    const record = JSON.parse(readFileSync(path, "utf8").trim());
    expect(record.focused_existing).toBeUndefined();
  });
});
