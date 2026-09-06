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
      if (method === "thread/list") {
        expect(params).toEqual({
          cwd: "/workspace",
          sourceKinds: ["appServer", "vscode"],
          modelProviders: [],
          archived: false,
          sortKey: "updated_at",
          sortDirection: "desc",
          limit: 100,
        });
        return {
          data: [main("newest", { threadSource: null }), main("older")],
          nextCursor: null,
        };
      }
      expect(method).toBe("thread/read");
      expect(params).toEqual({ threadId: "newest", includeTurns: false });
      return { thread: main("newest") };
    };
    expect(await selectThread(request, "/workspace", { continue: true })).toBe("newest");
  });
  test("reads list candidates to ignore other clients, workers, workspaces, children, and ephemeral history", async () => {
    const cursors: unknown[] = [];
    const reads: unknown[] = [];
    const request: NativeRequest = async (method, params) => {
      if (method === "thread/read") {
        reads.push(params["threadId"]);
        return {
          thread:
            params["threadId"] === "ordinary-vscode"
              ? main("ordinary-vscode", { threadSource: "another-app" })
              : main("correct"),
        };
      }
      cursors.push(params["cursor"]);
      return params["cursor"]
        ? { data: [main("correct", { threadSource: null })], nextCursor: null }
        : {
            data: [
              null,
              {},
              main("other", { cwd: "/elsewhere" }),
              main("child", { parentThreadId: "p" }),
              main("temporary", { ephemeral: true }),
              main("worker", { threadSource: "agentvoice-worker" }),
              main("client", { threadSource: "another-app" }),
              main("ordinary-vscode", { threadSource: null }),
            ],
            nextCursor: "page2",
          };
    };
    expect(await selectThread(request, "/workspace", { continue: true })).toBe("correct");
    expect(cursors).toEqual([undefined, "page2"]);
    expect(reads).toEqual(["ordinary-vscode", "correct"]);
  });
  test("explicit resume finds the id across pages and never falls back to fresh", async () => {
    const request: NativeRequest = async (method, p) => {
      if (method === "thread/read") return { thread: main("requested") };
      return p["cursor"]
        ? { data: [main("requested", { threadSource: null })], nextCursor: null }
        : { data: [main("newer")], nextCursor: "page2" };
    };
    expect(await selectThread(request, "/workspace", { resume: "requested" })).toBe("requested");
    await expect(selectThread(request, "/workspace", { resume: "missing" })).rejects.toThrow(
      "no unarchived AgentVoice",
    );
    expect(
      await selectThread(async () => ({ data: [] }), "/workspace", { continue: true }),
    ).toBeNull();
  });
  test("default and explicit fresh skip history; requested lookup failures fail visibly", async () => {
    const fails: NativeRequest = async () => {
      throw new Error("lookup failed");
    };
    expect(await selectThread(fails, "/workspace", {})).toBeNull();
    expect(await selectThread(fails, "/workspace", { fresh: true })).toBeNull();
    await expect(selectThread(fails, "/workspace", { continue: true })).rejects.toThrow(
      "lookup failed",
    );
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
      await expect(
        selectThread(async () => page, "/workspace", { continue: true }),
      ).rejects.toThrow();
    }
    await expect(
      selectThread(
        async (method) => {
          if (method === "thread/list")
            return { data: [main("candidate", { threadSource: null })], nextCursor: null };
          throw new Error("read failed");
        },
        "/workspace",
        { continue: true },
      ),
    ).rejects.toThrow("read failed");
    await expect(
      selectThread(fails, "/workspace", { continue: true, fresh: true }),
    ).rejects.toThrow("cannot be combined");
  });
});
