import { describe, expect, test } from "bun:test";
import { ORCHESTRATOR_THREAD_SOURCE } from "../src/core/params.ts";
import { type NativeRequest, selectThread } from "../src/core/thread-selection.ts";

const main = (id: string, extra = {}) => ({
  id,
  cwd: "/workspace",
  threadSource: ORCHESTRATOR_THREAD_SOURCE,
  ...extra,
});
describe("native workspace conversation selection", () => {
  test("lists newest-first, explicitly includes app-server sources and all providers", async () => {
    const request: NativeRequest = async (method, params) => {
      expect(method).toBe("thread/list");
      expect(params).toEqual({
        cwd: "/workspace",
        sourceKinds: ["appServer"],
        modelProviders: [],
        archived: false,
        sortKey: "updated_at",
        sortDirection: "desc",
        limit: 100,
      });
      return { data: [main("newest"), main("older")], nextCursor: null };
    };
    expect(await selectThread(request, "/workspace", {})).toBe("newest");
  });
  test("ignores workers, other workspaces/clients, child threads, and ephemeral history; paginates", async () => {
    const calls: unknown[] = [];
    const request: NativeRequest = async (_, params) => {
      calls.push(params["cursor"]);
      return params["cursor"]
        ? { data: [main("correct")], nextCursor: null }
        : {
            data: [
              null,
              {},
              main("other", { cwd: "/elsewhere" }),
              main("child", { parentThreadId: "p" }),
              main("temporary", { ephemeral: true }),
              main("worker", { threadSource: "agentvoice-worker" }),
              main("client", { threadSource: "another-app" }),
            ],
            nextCursor: "page2",
          };
    };
    expect(await selectThread(request, "/workspace", {})).toBe("correct");
    expect(calls).toEqual([undefined, "page2"]);
  });
  test("explicit resume finds the id across pages and never falls back to fresh", async () => {
    const request: NativeRequest = async (_, p) =>
      p["cursor"]
        ? { data: [main("requested")], nextCursor: null }
        : { data: [main("newer")], nextCursor: "page2" };
    expect(await selectThread(request, "/workspace", { resume: "requested" })).toBe("requested");
    await expect(selectThread(request, "/workspace", { resume: "missing" })).rejects.toThrow(
      "no unarchived AgentVoice",
    );
    expect(await selectThread(async () => ({ data: [] }), "/workspace", {})).toBeNull();
  });
  test("fresh skips history; lookup failures and bad/repeated cursors fail visibly", async () => {
    const fails: NativeRequest = async () => {
      throw new Error("lookup failed");
    };
    expect(await selectThread(fails, "/workspace", { fresh: true })).toBeNull();
    await expect(selectThread(fails, "/workspace", {})).rejects.toThrow("lookup failed");
    await expect(selectThread(fails, "/workspace", { fresh: true, resume: "id" })).rejects.toThrow(
      "cannot be combined",
    );
    for (const page of [
      null,
      {},
      { data: [], nextCursor: 4 },
      { data: [], nextCursor: "" },
      { data: [], nextCursor: "repeated" },
    ]) {
      await expect(selectThread(async () => page, "/workspace", {})).rejects.toThrow();
    }
  });
});
