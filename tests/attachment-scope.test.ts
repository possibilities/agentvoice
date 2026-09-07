import { expect, test } from "bun:test";
import { AttachmentScope } from "../src/attachment/scope.ts";

const root = { threadId: "root", workspace: "/workspace" };
const row = (id: string, parentThreadId: string | null, cwd = root.workspace) => ({
  thread: { id, parentThreadId, cwd },
});

test("ancestry admits nested and completed descendants, not forks or other roots", async () => {
  const rows = new Map<string, unknown>([
    ["child", row("child", "root")],
    ["grandchild", row("grandchild", "child")],
    ["foreign", row("foreign", null)],
    ["other-child", row("other-child", "foreign")],
    ["fork", { thread: { id: "fork", cwd: root.workspace, forkedFromId: "root" } }],
    ["elsewhere", row("elsewhere", "root", "/other")],
    ["cycle-a", row("cycle-a", "cycle-b")],
    ["cycle-b", row("cycle-b", "cycle-a")],
    ["mismatch", row("child", "root")],
  ]);
  const reads: string[] = [];
  const scope = new AttachmentScope(root, async (id) => {
    reads.push(id);
    return rows.get(id);
  });
  expect(await scope.allows("grandchild")).toBe(true);
  expect(reads).toEqual(["grandchild", "child"]);
  expect(await scope.allows("child")).toBe(true);
  expect(reads).toHaveLength(2);
  for (const id of [
    "foreign",
    "other-child",
    "fork",
    "elsewhere",
    "cycle-a",
    "mismatch",
    "missing",
    null,
  ])
    expect(await scope.allows(id)).toBe(false);
  expect([...scope.threads].sort()).toEqual(["child", "grandchild", "root"]);
});

test("revocation during a native read never admits a stale descendant", async () => {
  const deferred = Promise.withResolvers<unknown>();
  const scope = new AttachmentScope(root, () => deferred.promise);
  const pending = scope.allows("child");
  scope.close();
  deferred.resolve(row("child", "root"));
  expect(await pending).toBe(false);
  expect(await scope.allows("root")).toBe(false);
  expect(scope.threads.size).toBe(0);
});

test("lookup failures are retryable, checks deduplicate, and parallel reads are bounded", async () => {
  const deferred = Promise.withResolvers<unknown>();
  let calls = 0;
  const scope = new AttachmentScope(root, async () => {
    calls++;
    return deferred.promise;
  });
  const pending = [
    scope.allows("one"),
    scope.allows("one"),
    scope.allows("two"),
    scope.allows("three"),
    scope.allows("four"),
  ];
  expect(await scope.allows("five")).toBe(false);
  expect(calls).toBe(4);
  deferred.reject(new Error("native-private failure"));
  expect(await Promise.all(pending)).toEqual([false, false, false, false, false]);
  expect(await scope.allows("one")).toBe(false);
  expect(calls).toBe(5);
});

test("depth, deadline and positive-cache limits fail closed", async () => {
  let reads = 0;
  const deep = new AttachmentScope(root, async (id) => {
    reads++;
    return row(id, `depth-${reads}`);
  });
  expect(await deep.allows("start")).toBe(false);
  expect(reads).toBe(32);
  expect(await deep.allows("expired", Date.now() - 1)).toBe(false);
  expect(reads).toBe(32);
  const broad = new AttachmentScope(root, async (id) => row(id, "root"));
  for (let i = 0; i < 511; i++) expect(await broad.allows(`child-${i}`)).toBe(true);
  expect(await broad.allows("overflow")).toBe(false);
  expect(broad.threads.size).toBe(512);
});
