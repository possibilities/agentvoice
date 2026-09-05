import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerError } from "../src/core/attach.ts";
import type { ConfigValues } from "../src/core/config.ts";
import { SPOKEN_HISTORY_INSTRUCTION } from "../src/core/params.ts";
import { boundSpokenHistory, SpokenHistoryReader } from "../src/core/spoken-history.ts";
import { deferred, runtimeHarness } from "./fixtures/runtime-harness.ts";

const speech = (position: number, role: "user" | "assistant", text: string) => ({
  type: "realtime",
  position,
  item: { type: "transcriptSegment", role, text },
});
const spoken = [
  speech(2, "user", "Actually, list the current working directory."),
  speech(4, "assistant", "FIRST.md, "),
  speech(5, "assistant", "STARTUP.md."),
];
const page = { data: spoken, nextCursor: null };

describe("native spoken history", () => {
  test("pages backwards but restores speech chronologically, excluding working-agent text", async () => {
    const calls: Record<string, unknown>[] = [];
    const reader = new SpokenHistoryReader(async (_method, params) => {
      calls.push(params);
      return params["cursor"]
        ? {
            data: [
              spoken[0],
              {
                type: "item",
                position: 3,
                item: { type: "agentMessage", text: "Home directory: x-signin-profile" },
              },
            ],
            nextCursor: null,
          }
        : { data: spoken.slice(1), nextCursor: "older" };
    });
    expect(await reader.read("selected", "/workspace")).toEqual({
      items: spoken.map((e) => ({ role: e.item.role, text: e.item.text })),
      truncated: false,
    });
    expect(calls.map((c) => c["threadId"])).toEqual(["selected", "selected"]);
    expect(calls[1]!["cursor"]).toBe("older");
  });

  test("bounds the recent tail without replacing a large last reply with an older reply", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      role: "assistant" as const,
      text: `${i}`,
    }));
    const result = boundSpokenHistory(items);
    expect(result.items).toHaveLength(64);
    expect(result.items.at(-1)!.text).toBe("99");
    expect(result.truncated).toBe(true);
    expect(() =>
      boundSpokenHistory([...items, { role: "assistant", text: "語".repeat(9000) }]),
    ).toThrow("Last spoken segment");
  });

  test("timeline failures and malformed pagination never become silently empty history", async () => {
    for (const value of [
      {},
      { data: [], nextCursor: "loop" },
      { data: [speech(-1, "assistant", "bad")], nextCursor: null },
    ]) {
      const reader = new SpokenHistoryReader(async () => value);
      await expect(reader.read("selected", "/workspace")).rejects.toThrow(
        "Cannot restore spoken history",
      );
    }
    const methods: string[] = [];
    const reader = new SpokenHistoryReader(async (method) => {
      methods.push(method);
      throw new AppServerError("native failed", -32603);
    });
    await expect(reader.read("selected", "/workspace")).rejects.toThrow("native failed");
    expect(methods).toEqual(["thread/timeline/list"]);
  });

  test("legacy fallback verifies native identity, ignores incomplete tail, and never reads a symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentvoice-history-test-"));
    const path = join(root, "rollout-test-selected.jsonl");
    const meta = { type: "session_meta", payload: { id: "selected", cwd: root } };
    const lines = [
      meta,
      ...spoken.map((e) => ({
        type: "realtime_item",
        payload: { ...e.item, type: "transcript_segment" },
      })),
    ];
    const request = async (method: string) => {
      if (method === "thread/timeline/list") throw new AppServerError("not supported", -32601);
      return {
        thread: { id: "selected", cwd: root, threadSource: "agentvoice-orchestrator", path },
      };
    };
    const reader = new SpokenHistoryReader(request);
    try {
      writeFileSync(path, `${lines.map((x) => JSON.stringify(x)).join("\n")}\n{"partial":`);
      expect((await reader.read("selected", root)).items.at(-1)!.text).toBe("STARTUP.md.");
      await expect(reader.read("another", root)).rejects.toThrow("no longer matches");
      writeFileSync(path, `${JSON.stringify({ ...meta, payload: { id: "wrong", cwd: root } })}\n`);
      await expect(reader.read("selected", root)).rejects.toThrow("identity");
      writeFileSync(path, `${JSON.stringify(meta)}\nprivate-damaged-record\n`);
      await expect(reader.read("selected", root)).rejects.toThrow(
        "Malformed native rollout record",
      );
      rmSync(path);
      writeFileSync(join(root, "foreign"), "must not read this");
      symlinkSync(join(root, "foreign"), path);
      await expect(reader.read("selected", root)).rejects.toThrow("Cannot restore spoken history");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("spoken replay configuration and lifecycle", () => {
  for (const mode of ["continue", "resume", "fresh"] as const) {
    test(`${mode}: replays only the selected conversation; redial refreshes speech and Fresh clears it`, async () => {
      const h = runtimeHarness(
        {},
        mode === "resume" ? { resume: "existing" } : { fresh: mode === "fresh" },
      );
      h.native.main("existing", h.directory);
      h.native.override = (method) =>
        method === "thread/timeline/list" ? Promise.resolve(page) : undefined;
      try {
        await h.runtime.start();
        await h.runtime.offer("first");
        const first = h.native.calls.at(-1)!.params;
        if (mode === "fresh") {
          expect(first).not.toHaveProperty("initialItems");
          expect(h.native.calls.some((c) => c.method === "thread/timeline/list")).toBe(false);
        } else {
          const items = first["initialItems"] as { text: string }[];
          expect(items[0]!.text).toContain(SPOKEN_HISTORY_INSTRUCTION);
          expect(items.at(-1)!.text).toBe("STARTUP.md.");
          expect(JSON.stringify(items)).not.toContain("x-signin-profile");
        }
        expect(first["includeStartupContext"]).toBe(false);
        h.native.options.onNotification("thread/realtime/started", first);
        h.native.override = (method) =>
          method === "thread/timeline/list"
            ? Promise.resolve({
                data: [speech(9, "assistant", "Latest spoken reply.")],
                nextCursor: null,
              })
            : undefined;
        await h.runtime.offer("redial");
        expect(
          (h.native.calls.at(-1)!.params["initialItems"] as { text: string }[]).at(-1)!.text,
        ).toBe("Latest spoken reply.");
        const reads = h.native.calls.filter((c) => c.method === "thread/timeline/list").length;
        await h.runtime.fresh();
        await h.runtime.offer("fresh");
        expect(h.native.calls.at(-1)!.params).not.toHaveProperty("initialItems");
        expect(h.native.calls.filter((c) => c.method === "thread/timeline/list")).toHaveLength(
          reads,
        );
        expect(h.native.calls.some((c) => c.method === "turn/start")).toBe(false);
      } finally {
        await h.cleanup();
      }
    });
  }

  for (const voice of [
    { "replay-spoken-history": false },
    { "replay-spoken-history": false, "include-startup-context": true },
    { extra: { initialItems: [] } },
    { extra: { initialItems: null } },
    { version: "v1" },
  ] satisfies NonNullable<ConfigValues["voice"]>[]) {
    test(`explicit settings skip replay reads: ${JSON.stringify(voice)}`, async () => {
      const h = runtimeHarness({ voice });
      h.native.main("existing", h.directory);
      try {
        await h.runtime.start();
        await h.runtime.offer("first");
        expect(h.native.calls.some((c) => c.method === "thread/resume")).toBe(true);
        expect(h.native.calls.some((c) => c.method === "thread/timeline/list")).toBe(false);
        const params = h.native.calls.at(-1)!.params;
        expect(params).not.toHaveProperty("replaySpokenHistory");
        expect(params["includeStartupContext"]).toBe(voice["include-startup-context"] === true);
      } finally {
        await h.cleanup();
      }
    });
  }

  for (const boundary of ["fresh", "quit", "newer-offer"] as const) {
    test(`pending history cannot launch an obsolete call after ${boundary}`, async () => {
      const h = runtimeHarness();
      h.native.main("existing", h.directory);
      const pending = deferred<unknown>();
      h.native.override = (method) =>
        method === "thread/timeline/list" ? pending.promise : undefined;
      try {
        await h.runtime.start();
        const old = h.runtime.offer("obsolete");
        if (boundary === "fresh") await h.runtime.fresh();
        else if (boundary === "quit") await h.runtime.shutdown();
        else {
          h.native.override = undefined;
          await h.runtime.offer("newer");
        }
        pending.resolve(page);
        await old;
        const starts = h.native.calls.filter((c) => c.method === "thread/realtime/start");
        expect(starts).toHaveLength(boundary === "newer-offer" ? 1 : 0);
        expect(
          starts.some((c) => (c.params["transport"] as { sdp: string }).sdp === "obsolete"),
        ).toBe(false);
      } finally {
        await h.cleanup();
      }
    });
  }
});
