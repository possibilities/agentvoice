import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrCall } from "../src/herdr.ts";
import {
  parsePaneEvent,
  reportConversationToken,
  reportSidebarProjectToken,
  reportSidebarProjectTokenForEvent,
  resumedRefFromProcessArgv,
  runTabNamer,
  type SlugOutcome,
  sessionClaimScope,
} from "../src/tab-namer.ts";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "agentsurface-tab-namer-"));
  roots.push(root);
  return root;
}

const EVENT = JSON.stringify({
  event: "pane.agent_detected",
  data: { type: "pane_agent_detected", pane_id: "pane_1", workspace_id: "ws_1", agent: "claude" },
});

const STATUS_EVENT = JSON.stringify({
  event: "pane.agent_status_changed",
  data: {
    type: "pane_agent_status_changed",
    pane_id: "pane_1",
    workspace_id: "ws_1",
    agent: "claude",
    agent_status: "working",
  },
});

interface FakeSurface {
  call: HerdrCall;
  renames: string[][];
  reports: string[][];
  paneReads: number;
}

/** `session` is the pane's agent_session, or a function of the 1-based
 * read count when the occupant changes across reads. */
function surface(
  session: unknown,
  options: {
    sessionAfterReads?: number;
    tabForRead?: (read: number) => string;
    errorAfterReads?: number;
    tabLabel?: string;
    conversationToken?: string;
    paneAgent?: string;
    foregroundProcesses?: Array<{ argv: string[] }>;
    processInfoError?: boolean;
    reportError?: boolean;
  } = {},
): FakeSurface {
  const fake: FakeSurface = { renames: [], reports: [], paneReads: 0, call: undefined as never };
  let currentTabLabel = options.tabLabel ?? "1";
  fake.call = async (args) => {
    if (args[0] === "pane" && args[1] === "report-metadata") {
      if (options.reportError === true) {
        return { error: { code: "pane_not_found", message: "no such pane" } };
      }
      fake.reports.push(args.slice(2));
      return { result: {} };
    }
    if (args[0] === "tab" && args[1] === "get") {
      return { result: { tab: { label: currentTabLabel } } };
    }
    if (args[0] === "pane" && args[1] === "get") {
      fake.paneReads += 1;
      if (options.errorAfterReads !== undefined && fake.paneReads > options.errorAfterReads) {
        return { error: { code: "pane_not_found", message: "no such pane" } };
      }
      const ready = fake.paneReads > (options.sessionAfterReads ?? 0);
      const value =
        typeof session === "function"
          ? (session as (read: number) => unknown)(fake.paneReads)
          : session;
      return {
        result: {
          pane: {
            tab_id: options.tabForRead?.(fake.paneReads) ?? "tab_1",
            ...(options.paneAgent === undefined ? {} : { agent: options.paneAgent }),
            agent_session: ready ? value : null,
            ...(options.conversationToken === undefined
              ? {}
              : { tokens: { conversation: options.conversationToken } }),
          },
        },
      };
    }
    if (args[0] === "pane" && args[1] === "process-info") {
      if (options.processInfoError === true) {
        return { error: { code: "unsupported", message: "no process info" } };
      }
      return {
        result: { process_info: { foreground_processes: options.foregroundProcesses ?? [] } },
      };
    }
    if (args[0] === "tab" && args[1] === "rename") {
      fake.renames.push(args.slice(2));
      currentTabLabel = args[3] as string;
      return { result: {} };
    }
    throw new Error(`unexpected herdr call: ${args.join(" ")}`);
  };
  return fake;
}

const CLAUDE_SESSION = { source: "herdr:claude", agent: "claude", kind: "id", value: "abc-123" };
const SESSION_SCOPE = "surface-a";

function claimPath(dir: string, scope = SESSION_SCOPE): string {
  return join(dir, "named-tabs", scope, "tab_1");
}

function expectNamedClaim(dir: string, scope = SESSION_SCOPE): void {
  expect(readFileSync(claimPath(dir, scope), "utf8")).toMatch(/^named [0-9a-f]{64}\n$/);
}

function namer(
  fake: FakeSurface,
  dir: string,
  slug: (harness: string, ref: string) => Promise<SlugOutcome>,
  overrides: Partial<Parameters<typeof runTabNamer>[0]> = {},
) {
  return runTabNamer({
    call: fake.call,
    stateDir: dir,
    sessionScope: SESSION_SCOPE,
    eventJson: EVENT,
    slug: slug as never,
    sleep: async () => {},
    sessionPollMs: 0,
    promptPollMs: 0,
    ...overrides,
  });
}

describe("parsePaneEvent", () => {
  test("reads the envelope's kind, pane id, and released flag", () => {
    expect(parsePaneEvent(EVENT)).toEqual({
      kind: "agent_detected",
      paneId: "pane_1",
      released: false,
    });
    expect(parsePaneEvent(STATUS_EVENT)).toEqual({
      kind: "status_changed",
      paneId: "pane_1",
      released: false,
    });
    expect(parsePaneEvent("not json")).toBeNull();
    expect(parsePaneEvent(JSON.stringify({ data: {} }))).toBeNull();
    expect(
      parsePaneEvent(JSON.stringify({ data: { type: "pane_focused", pane_id: "pane_1" } })),
    ).toBeNull();
  });
});

describe("resumedRefFromProcessArgv", () => {
  test("reads AgentLaunch extension and native resume spellings", () => {
    expect(
      resumedRefFromProcessArgv(
        ["bun", "/usr/local/bin/agentlaunch", "--x-harness", "codex", "--x-resume", "abc"],
        "codex",
      ),
    ).toBe("abc");
    expect(
      resumedRefFromProcessArgv(
        ["bun", "/usr/local/bin/agentlaunch", "--x-harness", "codex", "resume", "def"],
        "codex",
      ),
    ).toBe("def");
    expect(
      resumedRefFromProcessArgv(
        ["agentlaunch", "--x-harness", "claude", "--resume", "ghi"],
        "claude",
      ),
    ).toBe("ghi");
    expect(
      resumedRefFromProcessArgv(
        ["agentlaunch", "--x-harness", "pi", "--session", "/sessions/jkl.jsonl"],
        "pi",
      ),
    ).toBe("/sessions/jkl.jsonl");
  });

  test("refuses another harness and non-AgentLaunch processes", () => {
    expect(
      resumedRefFromProcessArgv(
        ["agentlaunch", "--x-harness", "claude", "--resume", "abc"],
        "codex",
      ),
    ).toBeNull();
    expect(resumedRefFromProcessArgv(["codex", "resume", "abc"], "codex")).toBeNull();
  });
});

describe("reportSidebarProjectToken", () => {
  test("marks a linked worktree with its root repository name", async () => {
    const calls: string[][] = [];
    const call: HerdrCall = async (args) => {
      calls.push(args);
      if (args[0] === "pane" && args[1] === "get") {
        return { result: { pane: { workspace_id: "ws_1", cwd: "/worktrees/clear-valley/src" } } };
      }
      if (args[0] === "workspace" && args[1] === "get") {
        return { result: { workspace: { label: "worktree-clear-valley-003a" } } };
      }
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          result: {
            source: { repo_name: "agentvoice", source_checkout_path: "/worktrees/clear-valley" },
            worktrees: [
              { branch: "main", path: "/code/agentvoice" },
              { branch: "worktree/clear-valley-003a", path: "/worktrees/clear-valley" },
            ],
          },
        };
      }
      if (args[0] === "pane" && args[1] === "report-metadata") return { result: {} };
      throw new Error(`unexpected herdr call: ${args.join(" ")}`);
    };

    await reportSidebarProjectToken(call, "pane_1");

    expect(calls[2]).toEqual(["worktree", "list", "--cwd", "/worktrees/clear-valley/src"]);
    expect(calls[3]).toEqual([
      "pane",
      "report-metadata",
      "pane_1",
      "--source",
      "agentsurface:sidebar",
      "--token",
      "project=agentvoice \ue725 clear-valley-003a",
    ]);
  });

  test("names the branch of a repository's own checkout too", async () => {
    const calls: string[][] = [];
    const call: HerdrCall = async (args) => {
      calls.push(args);
      if (args[0] === "pane" && args[1] === "get") {
        return { result: { pane: { workspace_id: "ws_1", cwd: "/code/funk" } } };
      }
      if (args[0] === "workspace" && args[1] === "get") {
        return { result: { workspace: { label: "hand-renamed" } } };
      }
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          result: {
            source: { repo_name: "funk", source_checkout_path: "/code/funk" },
            worktrees: [{ branch: "main", path: "/code/funk" }],
          },
        };
      }
      if (args[0] === "pane" && args[1] === "report-metadata") return { result: {} };
      throw new Error(`unexpected herdr call: ${args.join(" ")}`);
    };

    await reportSidebarProjectToken(call, "pane_1");

    expect(calls[3]).toEqual([
      "pane",
      "report-metadata",
      "pane_1",
      "--source",
      "agentsurface:sidebar",
      "--token",
      "project=funk \ue725 main",
    ]);
  });

  test("a workspace bound before its directory became a repository still reports it", async () => {
    // herdr binds a workspace's worktree record at creation and never moves
    // it; the pane's cwd is what actually says where the agent is working.
    const calls: string[][] = [];
    const call: HerdrCall = async (args) => {
      calls.push(args);
      if (args[0] === "pane" && args[1] === "get") {
        return { result: { pane: { workspace_id: "ws_1", cwd: "/src/fx" } } };
      }
      if (args[0] === "workspace" && args[1] === "get") {
        return { result: { workspace: { label: "fx" } } };
      }
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          result: {
            source: { repo_name: "fx", source_checkout_path: "/src/fx" },
            worktrees: [{ branch: "integration", path: "/src/fx" }],
          },
        };
      }
      if (args[0] === "pane" && args[1] === "report-metadata") return { result: {} };
      throw new Error(`unexpected herdr call: ${args.join(" ")}`);
    };

    await reportSidebarProjectToken(call, "pane_1");

    expect(calls[3]?.at(-1)).toBe("project=fx \ue725 integration");
  });

  test("badges the workspace label as untracked when no repository backs it", async () => {
    const calls: string[][] = [];
    const call: HerdrCall = async (args) => {
      calls.push(args);
      if (args[0] === "pane" && args[1] === "get") {
        return { result: { pane: { workspace_id: "ws_1", cwd: "/code" } } };
      }
      if (args[0] === "workspace" && args[1] === "get") {
        return { result: { workspace: { label: "code" } } };
      }
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          error: {
            code: "not_git_worktree",
            message: "Herdr worktree actions require a path inside a Git work tree",
          },
        };
      }
      if (args[0] === "pane" && args[1] === "report-metadata") return { result: {} };
      throw new Error(`unexpected herdr call: ${args.join(" ")}`);
    };

    await reportSidebarProjectToken(call, "pane_1");

    expect(calls[3]).toEqual([
      "pane",
      "report-metadata",
      "pane_1",
      "--source",
      "agentsurface:sidebar",
      "--token",
      "project=code × untracked",
    ]);
  });

  test("a pane herdr reports no cwd for reads as untracked too", async () => {
    const calls: string[][] = [];
    const call: HerdrCall = async (args) => {
      calls.push(args);
      if (args[0] === "pane" && args[1] === "get") {
        return { result: { pane: { workspace_id: "ws_1" } } };
      }
      if (args[0] === "workspace" && args[1] === "get") {
        return { result: { workspace: { label: "code" } } };
      }
      if (args[0] === "pane" && args[1] === "report-metadata") return { result: {} };
      throw new Error(`unexpected herdr call: ${args.join(" ")}`);
    };

    await reportSidebarProjectToken(call, "pane_1");

    expect(calls[2]?.at(-1)).toBe("project=code × untracked");
  });
});

describe("reportSidebarProjectTokenForEvent", () => {
  const detected = parsePaneEvent(EVENT);
  const statusChanged = parsePaneEvent(STATUS_EVENT);

  function projectSurface(tokens?: Record<string, string>) {
    const calls: string[][] = [];
    const call: HerdrCall = async (args) => {
      calls.push(args);
      if (args[0] === "pane" && args[1] === "get") {
        return {
          result: {
            pane: {
              workspace_id: "ws_1",
              cwd: "/code/agentsurface",
              ...(tokens === undefined ? {} : { tokens }),
            },
          },
        };
      }
      if (args[0] === "workspace" && args[1] === "get") {
        return { result: { workspace: { label: "agentsurface" } } };
      }
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          result: {
            source: { repo_name: "agentsurface", source_checkout_path: "/code/agentsurface" },
            worktrees: [{ branch: "main", path: "/code/agentsurface" }],
          },
        };
      }
      if (args[0] === "pane" && args[1] === "report-metadata") return { result: {} };
      throw new Error(`unexpected herdr call: ${args.join(" ")}`);
    };
    return { call, calls };
  }

  test("a restored agent's status change repairs its missing project token", async () => {
    const fake = projectSurface({ conversation: "kept-conversation" });

    expect(await reportSidebarProjectTokenForEvent(fake.call, statusChanged)).toBe("published");
    expect(fake.calls.filter((args) => args[0] === "worktree")).toHaveLength(1);
    expect(fake.calls.at(-1)).toEqual([
      "pane",
      "report-metadata",
      "pane_1",
      "--source",
      "agentsurface:sidebar",
      "--token",
      "project=agentsurface \ue725 main",
    ]);
  });

  test("an ordinary status change leaves an existing project token alone", async () => {
    const fake = projectSurface({ project: "agentsurface \ue725 main" });

    expect(await reportSidebarProjectTokenForEvent(fake.call, statusChanged)).toBe("present");
    expect(fake.calls).toEqual([["pane", "get", "pane_1"]]);
  });

  test("detection still publishes without first reading held tokens", async () => {
    const fake = projectSurface({ project: "stale" });

    expect(await reportSidebarProjectTokenForEvent(fake.call, detected)).toBe("published");
    expect(fake.calls.filter((args) => args[0] === "pane" && args[1] === "get")).toHaveLength(1);
    expect(fake.calls.some((args) => args[0] === "worktree")).toBe(true);
  });

  test("released and irrelevant events remain no-ops", async () => {
    const fake = projectSurface();
    const released = detected === null ? null : { ...detected, released: true };

    expect(await reportSidebarProjectTokenForEvent(fake.call, released)).toBe("skipped");
    expect(await reportSidebarProjectTokenForEvent(fake.call, null)).toBe("skipped");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("reportConversationToken", () => {
  test("an unclaimed tab gets the untitled placeholder", async () => {
    const fake = surface(null);
    await reportConversationToken(fake.call, "pane_1", stateDir(), SESSION_SCOPE);
    expect(fake.reports).toEqual([
      ["pane_1", "--source", "agentsurface:sidebar", "--token", "conversation=untitled agent"],
    ]);
  });

  test("a pending claim still reads as untitled", async () => {
    const fake = surface(null);
    const dir = stateDir();
    mkdirSync(join(dir, "named-tabs", SESSION_SCOPE), { recursive: true });
    writeFileSync(claimPath(dir), "pending 99999\n");
    await reportConversationToken(fake.call, "pane_1", dir, SESSION_SCOPE);
    expect(fake.reports).toEqual([
      ["pane_1", "--source", "agentsurface:sidebar", "--token", "conversation=untitled agent"],
    ]);
  });

  test("a restored conversation token survives a delayed detection hook", async () => {
    const fake = surface(null, { conversationToken: "restored-conversation" });
    await reportConversationToken(fake.call, "pane_1", stateDir(), SESSION_SCOPE);
    expect(fake.reports).toEqual([
      [
        "pane_1",
        "--source",
        "agentsurface:sidebar",
        "--token",
        "conversation=restored-conversation",
      ],
    ]);
  });

  test("a named claim republishes the tab's current label", async () => {
    // Pane metadata does not survive a herdr restart; the re-detection that
    // follows a restore is what puts a named tab's token back.
    const fake = surface(null, { tabLabel: "fix-the-tests" });
    const dir = stateDir();
    mkdirSync(join(dir, "named-tabs", SESSION_SCOPE), { recursive: true });
    writeFileSync(claimPath(dir), "named\n");
    await reportConversationToken(fake.call, "pane_1", dir, SESSION_SCOPE);
    expect(fake.reports).toEqual([
      ["pane_1", "--source", "agentsurface:sidebar", "--token", "conversation=fix-the-tests"],
    ]);
  });

  test("a legacy claim republishes a non-default tab label during migration", async () => {
    const fake = surface(null, { tabLabel: "keep-this-name" });
    const dir = stateDir();
    mkdirSync(join(dir, "named-tabs"), { recursive: true });
    writeFileSync(join(dir, "named-tabs", "tab_1"), "named\n");

    await reportConversationToken(fake.call, "pane_1", dir, SESSION_SCOPE);

    expect(fake.reports).toEqual([
      ["pane_1", "--source", "agentsurface:sidebar", "--token", "conversation=keep-this-name"],
    ]);
  });

  test("a pane response without a tab is an error", async () => {
    const fake = surface(null, { tabForRead: () => "" });
    let thrown: Error | null = null;
    try {
      await reportConversationToken(fake.call, "pane_1", stateDir(), SESSION_SCOPE);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toContain("named no tab");
    expect(fake.reports).toHaveLength(0);
  });
});

describe("runTabNamer", () => {
  test("names an adopted resume from AgentLaunch argv when herdr reports no session", async () => {
    const fake = surface(null, {
      paneAgent: "codex",
      foregroundProcesses: [
        {
          argv: [
            "bun",
            "/usr/local/bin/agentlaunch",
            "--x-harness",
            "codex",
            "resume",
            "foreign-session",
          ],
        },
      ],
    });
    const asked: string[][] = [];
    const code = await namer(fake, stateDir(), async (harness, ref) => {
      asked.push([harness, ref]);
      return { kind: "slug", value: "adopted-conversation" };
    });

    expect(code).toBe(0);
    expect(asked).toEqual([["codex", "foreign-session"]]);
    expect(fake.renames).toEqual([["tab_1", "adopted-conversation"]]);
  });

  test("a failed process fallback keeps polling for herdr's session report", async () => {
    const fake = surface(CLAUDE_SESSION, {
      paneAgent: "claude",
      processInfoError: true,
      sessionAfterReads: 1,
    });
    const code = await namer(fake, stateDir(), async () => ({
      kind: "slug",
      value: "reported-later",
    }));

    expect(code).toBe(0);
    expect(fake.paneReads).toBe(2);
    expect(fake.renames).toEqual([["tab_1", "reported-later"]]);
  });

  test("names the tab from the session's slug and keeps the claim", async () => {
    const fake = surface(CLAUDE_SESSION, { sessionAfterReads: 2 });
    const dir = stateDir();
    const asked: string[][] = [];
    const code = await namer(fake, dir, async (harness, ref) => {
      asked.push([harness, ref]);
      return { kind: "slug", value: "fix-the-tests" };
    });
    expect(code).toBe(0);
    expect(fake.paneReads).toBe(3);
    expect(asked).toEqual([["claude", "abc-123"]]);
    expect(fake.renames).toEqual([["tab_1", "fix-the-tests"]]);
    expect(fake.reports).toEqual([
      ["pane_1", "--source", "agentsurface:sidebar", "--token", "conversation=fix-the-tests"],
    ]);
    expectNamedClaim(dir);
  });

  test("a failed slug report leaves the name and the claim standing", async () => {
    const fake = surface(CLAUDE_SESSION, { reportError: true });
    const dir = stateDir();
    const code = await namer(fake, dir, async () => ({ kind: "slug", value: "kept" }));
    expect(code).toBe(0);
    expect(fake.renames).toEqual([["tab_1", "kept"]]);
    expectNamedClaim(dir);
  });

  test("a status transition re-arms a naming attempt", async () => {
    // The detection-time attempt expired while a trust dialog held the
    // harness; the status change its acceptance fires names the tab.
    const fake = surface(CLAUDE_SESSION);
    const dir = stateDir();
    const code = await namer(fake, dir, async () => ({ kind: "slug", value: "after-the-dialog" }), {
      eventJson: STATUS_EVENT,
    });
    expect(code).toBe(0);
    expect(fake.renames).toEqual([["tab_1", "after-the-dialog"]]);
    expectNamedClaim(dir);
  });

  test("an already-claimed tab no-ops before inference", async () => {
    const fake = surface(CLAUDE_SESSION);
    const dir = stateDir();
    let asked = 0;
    const slug = async (): Promise<SlugOutcome> => {
      asked += 1;
      return { kind: "slug", value: "again" };
    };
    expect(await namer(fake, dir, slug)).toBe(0);
    expect(await namer(fake, dir, slug)).toBe(0);
    expect(asked).toBe(1);
    expect(fake.renames).toHaveLength(1);
  });

  test("the same tab id in two herdr sessions is named independently", async () => {
    const dir = stateDir();
    const first = surface(CLAUDE_SESSION);
    const second = surface(CLAUDE_SESSION);

    expect(await namer(first, dir, async () => ({ kind: "slug", value: "first-session" }))).toBe(0);
    expect(
      await namer(second, dir, async () => ({ kind: "slug", value: "second-session" }), {
        sessionScope: "surface-b",
      }),
    ).toBe(0);

    expect(first.renames).toEqual([["tab_1", "first-session"]]);
    expect(second.renames).toEqual([["tab_1", "second-session"]]);
    expectNamedClaim(dir);
    expectNamedClaim(dir, "surface-b");
  });

  test("a reused tab id is renamed for its new conversation", async () => {
    const dir = stateDir();
    const first = surface(CLAUDE_SESSION);
    const secondSession = { ...CLAUDE_SESSION, value: "def-456" };
    const second = surface(secondSession);

    expect(
      await namer(first, dir, async () => ({ kind: "slug", value: "first-conversation" })),
    ).toBe(0);
    await reportConversationToken(second.call, "pane_1", dir, SESSION_SCOPE);
    expect(second.reports).toEqual([
      ["pane_1", "--source", "agentsurface:sidebar", "--token", "conversation=untitled agent"],
    ]);

    expect(
      await namer(second, dir, async () => ({ kind: "slug", value: "second-conversation" })),
    ).toBe(0);
    expect(second.renames).toEqual([["tab_1", "second-conversation"]]);
    expect(second.reports.at(-1)).toEqual([
      "pane_1",
      "--source",
      "agentsurface:sidebar",
      "--token",
      "conversation=second-conversation",
    ]);
    expectNamedClaim(dir);
  });

  test("a legacy unscoped claim cannot suppress naming", async () => {
    const fake = surface(CLAUDE_SESSION);
    const dir = stateDir();
    mkdirSync(join(dir, "named-tabs"), { recursive: true });
    writeFileSync(join(dir, "named-tabs", "tab_1"), "named\n");

    expect(await namer(fake, dir, async () => ({ kind: "slug", value: "fresh-scope" }))).toBe(0);
    expect(fake.renames).toEqual([["tab_1", "fresh-scope"]]);
    expectNamedClaim(dir);
  });

  test("a legacy claim preserves a tab that already has a Name", async () => {
    const fake = surface(CLAUDE_SESSION, { tabLabel: "keep-this-name" });
    const dir = stateDir();
    mkdirSync(join(dir, "named-tabs"), { recursive: true });
    writeFileSync(join(dir, "named-tabs", "tab_1"), "named\n");
    let asked = 0;

    expect(
      await namer(fake, dir, async () => {
        asked += 1;
        return { kind: "slug", value: "replacement" };
      }),
    ).toBe(0);

    expect(asked).toBe(0);
    expect(fake.renames).toHaveLength(0);
    expect(fake.reports).toEqual([
      ["pane_1", "--source", "agentsurface:sidebar", "--token", "conversation=keep-this-name"],
    ]);
    expectNamedClaim(dir);
  });

  test("waits out a pending transcript, then names", async () => {
    const fake = surface(CLAUDE_SESSION);
    let attempts = 0;
    const code = await namer(fake, stateDir(), async () => {
      attempts += 1;
      return attempts < 3 ? { kind: "pending" } : { kind: "slug", value: "late-prompt" };
    });
    expect(code).toBe(0);
    expect(fake.renames).toEqual([["tab_1", "late-prompt"]]);
  });

  test("a failed inference releases the claim and reports", async () => {
    const fake = surface(CLAUDE_SESSION);
    const dir = stateDir();
    const code = await namer(fake, dir, async () => ({ kind: "failed", message: "boom" }));
    expect(code).toBe(1);
    expect(existsSync(claimPath(dir))).toBe(false);
    expect(fake.renames).toHaveLength(0);
  });

  test("a prompt that never arrives gives up quietly and releases", async () => {
    const fake = surface(CLAUDE_SESSION);
    const dir = stateDir();
    const code = await namer(fake, dir, async () => ({ kind: "pending" }), {
      promptTimeoutMs: 0,
    });
    expect(code).toBe(0);
    expect(existsSync(claimPath(dir))).toBe(false);
  });

  test("an unsupported agent and a released detection both no-op", async () => {
    const fake = surface({ source: "x", agent: "copilot", kind: "id", value: "z" });
    const never = async (): Promise<SlugOutcome> => {
      throw new Error("should not infer");
    };
    expect(await namer(fake, stateDir(), never)).toBe(0);

    const released = JSON.stringify({
      event: "pane.agent_detected",
      data: { type: "pane_agent_detected", pane_id: "pane_1", released: true },
    });
    expect(await namer(fake, stateDir(), never, { eventJson: released })).toBe(0);
  });

  test("a session herdr never learns times out quietly", async () => {
    const fake = surface(null);
    const code = await namer(fake, stateDir(), async () => ({ kind: "slug", value: "x" }), {
      sessionTimeoutMs: 0,
    });
    expect(code).toBe(0);
    expect(fake.renames).toHaveLength(0);
  });

  test("pi sessions travel as paths", async () => {
    const fake = surface({
      source: "herdr:pi",
      agent: "pi",
      kind: "path",
      value: "/home/u/.pi/agent/sessions/x/y.jsonl",
    });
    const asked: string[][] = [];
    await namer(fake, stateDir(), async (harness, ref) => {
      asked.push([harness, ref]);
      return { kind: "slug", value: "pi-work" };
    });
    expect(asked).toEqual([["pi", "/home/u/.pi/agent/sessions/x/y.jsonl"]]);
  });

  const CRASHED_SESSION = {
    source: "herdr:claude",
    agent: "claude",
    kind: "id",
    value: "dead-999",
  };

  test("a replaced agent mid-poll becomes the name source", async () => {
    const fake = surface((read: number) => (read === 1 ? CRASHED_SESSION : CLAUDE_SESSION));
    const dir = stateDir();
    const asked: string[][] = [];
    const code = await namer(fake, dir, async (harness, ref) => {
      asked.push([harness, ref]);
      return ref === "dead-999" ? { kind: "pending" } : { kind: "slug", value: "debug-escaping" };
    });
    expect(code).toBe(0);
    expect(asked).toEqual([
      ["claude", "dead-999"],
      ["claude", "abc-123"],
    ]);
    expect(fake.renames).toEqual([["tab_1", "debug-escaping"]]);
    expectNamedClaim(dir);
  });

  test("an adopted conversation gets a fresh prompt window", async () => {
    let clock = 0;
    const fake = surface((read: number) => (read <= 2 ? CRASHED_SESSION : CLAUDE_SESSION));
    let liveAsks = 0;
    const code = await namer(
      fake,
      stateDir(),
      async (_harness, ref) => {
        if (ref === "dead-999") return { kind: "pending" };
        liveAsks += 1;
        return liveAsks < 2 ? { kind: "pending" } : { kind: "slug", value: "late-adoption" };
      },
      {
        now: () => clock,
        promptTimeoutMs: 100,
        sleep: async () => {
          clock += 60;
        },
      },
    );
    // The dead ref burned the first window (clock 120 > 100); only the
    // reset taken on adoption lets the live ref's second ask happen.
    expect(code).toBe(0);
    expect(fake.renames).toEqual([["tab_1", "late-adoption"]]);
  });

  test("an orphaned pending claim is taken over", async () => {
    const fake = surface(CLAUDE_SESSION);
    const dir = stateDir();
    mkdirSync(join(dir, "named-tabs", SESSION_SCOPE), { recursive: true });
    writeFileSync(claimPath(dir), "pending 999999\n");
    const code = await namer(fake, dir, async () => ({ kind: "slug", value: "rescued" }), {
      pidAlive: () => false,
    });
    expect(code).toBe(0);
    expect(fake.renames).toEqual([["tab_1", "rescued"]]);
    expectNamedClaim(dir);
  });

  test("a live pending claim no-ops", async () => {
    const never = async (): Promise<SlugOutcome> => {
      throw new Error("should not infer");
    };
    const fake = surface(CLAUDE_SESSION);
    const dir = stateDir();
    mkdirSync(join(dir, "named-tabs", SESSION_SCOPE), { recursive: true });
    writeFileSync(claimPath(dir), "pending 4242\n");
    expect(await namer(fake, dir, never, { pidAlive: () => true })).toBe(0);
    expect(readFileSync(claimPath(dir), "utf8")).toBe("pending 4242\n");
    expect(fake.renames).toHaveLength(0);
  });

  test("legacy scoped claims migrate only from a nonnumeric Name", async () => {
    const never = async (): Promise<SlugOutcome> => {
      throw new Error("should not infer");
    };
    for (const content of ["named\n", "2026-08-17T03:34:41.794Z\n"]) {
      const fake = surface(CLAUDE_SESSION, { tabLabel: "keep-this-name" });
      const dir = stateDir();
      mkdirSync(join(dir, "named-tabs", SESSION_SCOPE), { recursive: true });
      writeFileSync(claimPath(dir), content);
      expect(await namer(fake, dir, never, { pidAlive: () => true })).toBe(0);
      expectNamedClaim(dir);
      expect(fake.renames).toHaveLength(0);
    }
  });

  test("a legacy scoped claim over a numeric tab cannot suppress naming", async () => {
    const fake = surface(CLAUDE_SESSION);
    const dir = stateDir();
    mkdirSync(join(dir, "named-tabs", SESSION_SCOPE), { recursive: true });
    writeFileSync(claimPath(dir), "named\n");

    expect(await namer(fake, dir, async () => ({ kind: "slug", value: "recovered-name" }))).toBe(0);
    expect(fake.renames).toEqual([["tab_1", "recovered-name"]]);
    expectNamedClaim(dir);
  });

  test("a superseded namer's failure leaves its successor's claim", async () => {
    const fake = surface(CLAUDE_SESSION);
    const dir = stateDir();
    const claim = claimPath(dir);
    const code = await namer(fake, dir, async () => {
      // Another namer took the claim over while this one was polling.
      writeFileSync(claim, "pending 777\n");
      return { kind: "failed", message: "boom" };
    });
    expect(code).toBe(1);
    expect(readFileSync(claim, "utf8")).toBe("pending 777\n");
  });

  test("an unsupported occupant mid-poll releases the claim", async () => {
    const fake = surface((read: number) =>
      read === 1 ? CLAUDE_SESSION : { source: "x", agent: "copilot", kind: "id", value: "z" },
    );
    const dir = stateDir();
    const code = await namer(fake, dir, async () => ({ kind: "pending" }));
    expect(code).toBe(0);
    expect(existsSync(claimPath(dir))).toBe(false);
    expect(fake.renames).toHaveLength(0);
  });

  test("a pane that left the claimed tab releases the claim", async () => {
    const fake = surface(CLAUDE_SESSION, {
      tabForRead: (read) => (read === 1 ? "tab_1" : "tab_2"),
    });
    const dir = stateDir();
    const code = await namer(fake, dir, async () => ({ kind: "pending" }));
    expect(code).toBe(0);
    expect(existsSync(claimPath(dir))).toBe(false);
    expect(fake.renames).toHaveLength(0);
  });

  test("a vanished pane mid-poll releases the claim", async () => {
    const fake = surface(CLAUDE_SESSION, { errorAfterReads: 1 });
    const dir = stateDir();
    const code = await namer(fake, dir, async () => ({ kind: "pending" }));
    expect(code).toBe(0);
    expect(existsSync(claimPath(dir))).toBe(false);
  });
});

describe("sessionClaimScope", () => {
  test("is stable per socket and distinct between sessions", () => {
    expect(sessionClaimScope("/state/sessions/jobs/herdr.sock")).toBe(
      sessionClaimScope("/state/sessions/jobs/herdr.sock"),
    );
    expect(sessionClaimScope("/state/sessions/jobs/herdr.sock")).not.toBe(
      sessionClaimScope("/state/sessions/default/herdr.sock"),
    );
  });
});
