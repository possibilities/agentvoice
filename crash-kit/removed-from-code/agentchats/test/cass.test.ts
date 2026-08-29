import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cachedSessionClassifier,
  classifySession,
  type CassRunner,
  loadVisibleRows,
  parseHits,
  parseSessions,
  rolloutMetadata,
  rolloutThreadSource,
  searchArgs,
  type SessionClassifier,
  type SessionRow,
  sessionsArgs,
} from "../src/tui/cass.ts";

const WS = "/Users/op/code/alpha";

describe("searchArgs / sessionsArgs", () => {
  test("scope rides as --workspace only when present", () => {
    expect(searchArgs("queue", WS, 30)).toEqual([
      "search",
      "queue",
      "--json",
      "--limit",
      "30",
      "--mode",
      "hybrid",
      "--workspace",
      WS,
    ]);
    expect(searchArgs("queue", null, 30)).not.toContain("--workspace");
    expect(searchArgs("queue", null, 30, "all", 60)).toContain("--offset");
    expect(searchArgs("queue", null, 30, "all", 60)).toContain("60");
    expect(sessionsArgs(WS, 20)).toContain("--workspace");
    expect(sessionsArgs(null, 20)).not.toContain("--workspace");
  });

  test("the time window narrows both commands", () => {
    expect(searchArgs("q", null, 30, "today").join(" ")).toContain("--days 1");
    expect(searchArgs("q", null, 30, "week").join(" ")).toContain("--days 7");
    expect(searchArgs("q", null, 30, "all").join(" ")).not.toContain("--days");
    expect(sessionsArgs(null, 20, "today").join(" ")).toContain("--since 1d");
    expect(sessionsArgs(null, 20, "week").join(" ")).toContain("--since 7d");
    expect(sessionsArgs(null, 20, "all").join(" ")).not.toContain("--since");
  });
});

function row(path: string, agent = "codex"): SessionRow {
  return {
    agent,
    workspace: WS,
    path,
    title: path,
    when: "",
    snippet: null,
    line: null,
    slug: null,
    excerpt: null,
  };
}

const temp = mkdtempSync(join(tmpdir(), "agentchats-classify-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

function rollout(path: string, threadSource: string | null, originator?: string): string {
  const payload: Record<string, string> = { id: path };
  if (threadSource !== null) payload["thread_source"] = threadSource;
  if (originator !== undefined) payload["originator"] = originator;
  return `${JSON.stringify({ type: "session_meta", payload })}\n${JSON.stringify({ type: "response_item", payload: { role: "user" } })}\n`;
}

describe("Codex session classification", () => {
  test("reads full-harness, auxiliary, and legacy metadata", async () => {
    const user = join(temp, "user.jsonl");
    const worker = join(temp, "worker.jsonl");
    const legacy = join(temp, "legacy.jsonl");
    writeFileSync(user, rollout("user", "user"));
    writeFileSync(worker, rollout("worker", "agentvoice-worker"));
    writeFileSync(legacy, rollout("legacy", null));

    expect(await classifySession(row(user))).toBe("full-harness");
    expect(await classifySession(row(worker))).toBe("auxiliary");
    expect(await classifySession(row(legacy))).toBe("full-harness");
    expect(await classifySession(row("/missing", "claude_code"))).toBe("full-harness");
    expect(await classifySession(row("/missing"))).toBe("unknown");
  });

  test("reads compressed rollouts with Bun's Zstandard support", async () => {
    const path = join(temp, "worker.jsonl.zst");
    writeFileSync(path, Bun.zstdCompressSync(new TextEncoder().encode(rollout("z", "subagent"))));
    expect(await classifySession(row(path))).toBe("auxiliary");
  });

  test("configured originators classify only legacy sessions as auxiliary", async () => {
    const legacy = join(temp, "legacy-agentvoice.jsonl");
    const terrestrial = join(temp, "terrestrial-agentvoice.jsonl");
    writeFileSync(legacy, rollout("legacy-agentvoice", null, "agentvoice"));
    writeFileSync(terrestrial, rollout("terrestrial-agentvoice", "user", "agentvoice"));
    const configured = new Set(["agentvoice"]);

    expect(await classifySession(row(legacy))).toBe("full-harness");
    expect(await classifySession(row(legacy), configured)).toBe("auxiliary");
    expect(await classifySession(row(terrestrial), configured)).toBe("full-harness");
  });

  test("accepts camelCase metadata but does not invent metadata from chatter", () => {
    expect(
      rolloutThreadSource(
        `${JSON.stringify({ type: "event_msg", payload: { message: "thread_source:user" } })}\n${JSON.stringify({ type: "session_meta", payload: { threadSource: "user" } })}`,
      ),
    ).toBe("user");
    expect(
      rolloutMetadata(
        JSON.stringify({ type: "session_meta", payload: { originator: "agentvoice" } }),
      ),
    ).toEqual({ threadSource: null, originator: "agentvoice" });
    expect(rolloutThreadSource("not json\n")).toBeUndefined();
  });

  test("does not cache an unknown answer", async () => {
    let calls = 0;
    const cached = cachedSessionClassifier(async () => {
      calls++;
      return calls === 1 ? "unknown" : "full-harness";
    });
    expect(await cached(row("/appearing.jsonl"))).toBe("unknown");
    expect(await cached(row("/appearing.jsonl"))).toBe("full-harness");
    expect(calls).toBe(2);
  });
});

function searchPage(paths: string[]): string {
  return JSON.stringify({
    hits: paths.map((path) => ({
      agent: "codex",
      workspace: WS,
      source_path: path,
      title: path,
    })),
  });
}

function recentPage(paths: string[]): string {
  return JSON.stringify({
    sessions: paths.map((path, index) => ({
      agent: "codex",
      workspace: WS,
      path,
      title: path,
      modified: `2026-08-${String(19 - index).padStart(2, "0")}T00:00:00Z`,
    })),
  });
}

const byName: SessionClassifier = async (session) =>
  session.path.includes("aux") ? "auxiliary" : "full-harness";

describe("loadVisibleRows", () => {
  test("pages search until auxiliary hits no longer consume the visible limit", async () => {
    const calls: string[][] = [];
    const runner: CassRunner = async (args) => {
      calls.push(args);
      return {
        ok: true,
        stdout: args.includes("--offset")
          ? searchPage(["/full-a", "/full-b"])
          : searchPage(["/aux-a", "/aux-b"]),
      };
    };
    const result = await loadVisibleRows(
      runner,
      { query: "queue", scope: WS, window: "all", limit: 2, includeAuxiliary: false },
      byName,
    );
    expect(result).toEqual({ ok: true, rows: [row("/full-a"), row("/full-b")] });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("--offset");
    expect(calls[1]).toContain("2");
  });

  test("grows recent-session requests until enough full harnesses are visible", async () => {
    const limits: string[] = [];
    const runner: CassRunner = async (args) => {
      const limit = args[args.indexOf("--limit") + 1] ?? "";
      limits.push(limit);
      return {
        ok: true,
        stdout:
          limit === "2"
            ? recentPage(["/aux-a", "/aux-b"])
            : recentPage(["/aux-a", "/aux-b", "/full-a", "/full-b"]),
      };
    };
    const result = await loadVisibleRows(
      runner,
      { query: "", scope: WS, window: "all", limit: 2, includeAuxiliary: false },
      byName,
    );
    expect(result.ok && result.rows.map((session) => session.path)).toEqual([
      "/full-a",
      "/full-b",
    ]);
    expect(limits).toEqual(["2", "8"]);
  });

  test("the opt-in returns auxiliary rows without another page", async () => {
    let calls = 0;
    const runner: CassRunner = async () => {
      calls++;
      return { ok: true, stdout: searchPage(["/aux-a", "/aux-b"]) };
    };
    const result = await loadVisibleRows(
      runner,
      { query: "queue", scope: WS, window: "all", limit: 2, includeAuxiliary: true },
      byName,
    );
    expect(result.ok && result.rows.map((session) => session.path)).toEqual([
      "/aux-a",
      "/aux-b",
    ]);
    expect(calls).toBe(1);
  });

  test("an unmatched workspace fallback does not page through global results", async () => {
    let calls = 0;
    const runner: CassRunner = async () => {
      calls++;
      return {
        ok: true,
        stdout: JSON.stringify({
          hits: [
            { agent: "codex", workspace: "/somewhere/else", source_path: "/full-a" },
            { agent: "codex", workspace: "/somewhere/else", source_path: "/full-b" },
          ],
        }),
      };
    };
    const result = await loadVisibleRows(
      runner,
      { query: "queue", scope: WS, window: "all", limit: 2, includeAuxiliary: false },
      byName,
    );
    expect(result).toEqual({ ok: true, rows: [] });
    expect(calls).toBe(1);
  });
});

describe("parseHits", () => {
  const stdout = JSON.stringify({
    hits: [
      {
        title: "# Fix the queue",
        snippet: "the  queue\nwas broken",
        agent: "claude_code",
        workspace: WS,
        source_path: "/store/a.jsonl",
        created_at: 1786116422062,
        line_number: 51,
      },
      {
        title: "",
        agent: "codex",
        workspace: "/Users/op/code/beta",
        source_path: "/store/b.jsonl",
      },
    ],
  });

  test("keeps cass's order and normalizes whitespace", () => {
    const rows = parseHits(stdout, null);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.snippet).toBe("the queue was broken");
    expect(rows[0]?.when).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(rows[0]?.line).toBe(51);
    expect(rows[1]?.title).toBe("(untitled)");
  });

  test("project scope drops other workspaces client-side", () => {
    const rows = parseHits(stdout, WS);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workspace).toBe(WS);
  });

  test("many hits in one session collapse to its best-ranked row", () => {
    const multi = JSON.stringify({
      hits: [
        { agent: "claude_code", workspace: WS, source_path: "/store/a.jsonl", snippet: "best", line_number: 3 },
        { agent: "claude_code", workspace: WS, source_path: "/store/a.jsonl", snippet: "worse", line_number: 90 },
        { agent: "codex", workspace: WS, source_path: "/store/b.jsonl", snippet: "other" },
        { agent: "claude_code", workspace: WS, source_path: "/store/a.jsonl", snippet: "worst" },
      ],
    });
    const rows = parseHits(multi, null);
    expect(rows.map((row) => row.path)).toEqual(["/store/a.jsonl", "/store/b.jsonl"]);
    expect(rows[0]?.snippet).toBe("best");
    expect(rows[0]?.line).toBe(3);
  });

  test("garbage is an empty list, not a crash", () => {
    expect(parseHits("not json", null)).toEqual([]);
    expect(parseHits("{}", null)).toEqual([]);
  });
});

describe("parseSessions", () => {
  const stdout = JSON.stringify({
    sessions: [
      {
        path: "/store/a.jsonl",
        workspace: WS,
        agent: "claude_code",
        title: "older duplicate",
        modified: "2026-08-01T00:00:00+00:00",
      },
      {
        path: "/store/a.jsonl",
        workspace: WS,
        agent: "claude_code",
        title: "newer duplicate",
        modified: "2026-08-15T12:30:00+00:00",
      },
      {
        path: "/store/b.jsonl",
        workspace: "/Users/op/code/beta",
        agent: "codex",
        title: "elsewhere",
        modified: "2026-08-16T00:00:00+00:00",
      },
    ],
  });

  test("collapses duplicate index rows to the newest, newest first", () => {
    const rows = parseSessions(stdout, null);
    expect(rows.map((row) => row.title)).toEqual(["elsewhere", "newer duplicate"]);
    expect(rows[1]?.when).toBe("2026-08-15 12:30");
  });

  test("project scope drops the unscoped fallback rows", () => {
    const rows = parseSessions(stdout, WS);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("newer duplicate");
  });
});
