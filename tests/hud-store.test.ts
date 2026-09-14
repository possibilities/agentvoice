import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkStore } from "../src/hud/store.ts";

const dirs: string[] = [];
const stores: WorkStore[] = [];
function store() {
  const dir = mkdtempSync(join(tmpdir(), "hud-store-"));
  dirs.push(dir);
  const value = new WorkStore(join(dir, "work.sqlite3"));
  stores.push(value);
  return value;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const ev = [{ ref: "fixture:evidence" }];
const binding = {
  instanceId: "instance",
  generation: 2,
  rootThreadId: "root",
  threadId: "child",
  turnId: "turn",
  evidence: ev,
};
const create = (id = "work") => ({
  action: "work.create",
  operationId: `create-${id}`,
  actor: "lead",
  id,
  expectedRevision: 0,
  data: { objective: "Finish task", scope: "Bounded fixture", authority: ev, lead: "lead" },
});
const op = (
  action: string,
  id: string,
  expectedRevision: number,
  data: unknown,
  operationId = action,
  actor = "lead",
) => ({ action, id, expectedRevision, data, operationId, actor });
test("durable idempotency, revision and declared owner fences", () => {
  const s = store();
  const first = s.mutate(create());
  expect(s.mutate(create())).toEqual(first);
  expect(s.snapshot().revision).toBe(1);
  expect(() => s.mutate({ ...create(), data: { ...create().data, objective: "Changed" } })).toThrow(
    "different payload",
  );
  expect(() => s.mutate(op("work.update", "work", 0, { objective: "Changed" }))).toThrow(
    "Expected revision",
  );
  expect(() =>
    s.mutate(op("work.update", "work", 1, { objective: "Changed" }, "bad-owner", "other")),
  ).toThrow("declared Work lead");
  const second = new WorkStore(s.path);
  expect(second.snapshot().works).toHaveLength(1);
  expect(second.mutate(create())).toEqual(first);
  second.mutate(op("work.update", "work", 1, { objective: "Revised" }, "other-handle"));
  expect(() =>
    s.mutate(op("work.update", "work", 1, { objective: "Stale" }, "stale-handle")),
  ).toThrow("Expected revision");
  expect(s.mutate(create())).toEqual(first);
  expect(s.snapshot().works[0]?.revision).toBe(2);
  second.close();
  expect(statSync(s.path).mode & 0o777).toBe(0o600);
});
test("batch rolls back all writes and can be retried atomically", () => {
  const s = store();
  const bad = {
    operationId: "batch",
    operations: [create(), op("work.update", "work", 9, { objective: "Changed" })],
  };
  expect(() => s.batch(bad)).toThrow("Expected revision");
  expect(s.snapshot().works).toHaveLength(0);
  expect(s.snapshot().events).toHaveLength(0);
  const good = {
    ...bad,
    operations: [create(), op("work.update", "work", 1, { objective: "Changed" })],
  };
  const result = s.batch(good);
  expect(s.batch(good)).toEqual(result);
  expect(s.snapshot().revision).toBe(2);
});
test("dispatch bindings preserve exact native identity and result milestones remain distinct", () => {
  const s = store();
  s.mutate(create());
  s.mutate(
    op(
      "assignment.prepare",
      "assignment",
      0,
      {
        workId: "work",
        assignee: "worker",
        taskName: "child",
        resultContract: "Return checked artifact",
      },
      "prepare",
    ),
  );
  expect(s.snapshot().assignments[0]?.binding).toBeNull();
  s.mutate(op("assignment.bind", "assignment", 1, binding, "bind"));
  expect(() => s.mutate(op("assignment.bind", "assignment", 2, binding, "rebind"))).toThrow(
    "immutable",
  );
  const data = {
    workId: "work",
    assignmentId: "assignment",
    outcome: "completed",
    summary: "Checked artifact",
    evidence: ev,
    binding,
  };
  expect(() =>
    s.mutate(
      op(
        "result.record",
        "result",
        0,
        { ...data, binding: { ...binding, generation: 3 } },
        "bad-result",
        "worker",
      ),
    ),
  ).toThrow("exact bound");
  s.mutate(op("result.record", "result", 0, data, "return", "worker"));
  expect(() => s.mutate(op("result.present", "result", 1, { evidence: ev }))).toThrow(
    "Accept the result",
  );
  expect(() =>
    s.mutate(op("work.update", "work", 1, { disposition: "completed" }, "complete")),
  ).toThrow("accepted result");
  s.mutate(op("result.review", "result", 1, { decision: "accepted", evidence: ev }));
  s.mutate(op("work.update", "work", 1, { disposition: "completed" }, "complete"));
  expect(s.snapshot().results[0]?.presentations).toEqual([]);
  s.mutate(op("result.present", "result", 2, { evidence: ev }));
  expect(s.snapshot().results[0]?.presentations).toHaveLength(1);
});
test("rejects cyclic containment and dependency graphs", () => {
  const s = store();
  s.mutate(create("a"));
  s.mutate({ ...create("b"), data: { ...create("b").data, parentId: "a", dependencies: ["a"] } });
  expect(() => s.mutate(op("work.update", "a", 1, { parentId: "b" }, "parent-cycle"))).toThrow(
    "cycles",
  );
  expect(() =>
    s.mutate(op("work.update", "a", 1, { dependencies: ["b"] }, "dependency-cycle")),
  ).toThrow("cycles");
});
test("unbound dispatch needs explicit no-execution evidence and cannot later bind", () => {
  const s = store();
  s.mutate(create());
  s.mutate(
    op(
      "assignment.prepare",
      "a",
      0,
      { workId: "work", assignee: "worker", taskName: "child", resultContract: "Artifact" },
      "prepare",
    ),
  );
  const data = {
    workId: "work",
    assignmentId: "a",
    outcome: "failed",
    summary: "Dispatch rejected before native acceptance",
    evidence: ev,
    binding: null,
  };
  expect(() => s.mutate(op("result.record", "r", 0, data, "unresolved"))).toThrow("exact bound");
  expect(() =>
    s.mutate(
      op(
        "result.record",
        "r",
        0,
        { ...data, outcome: "completed", dispatchResolution: "not_dispatched" },
        "false-completion",
      ),
    ),
  ).toThrow("failed or interrupted");
  s.mutate(
    op("result.record", "r", 0, { ...data, dispatchResolution: "dispatch_failed" }, "resolved"),
  );
  expect(() => s.mutate(op("assignment.bind", "a", 1, binding, "late-bind"))).toThrow(
    "resolved without execution",
  );
  s.mutate(
    op("result.review", "r", 1, { decision: "accepted", evidence: ev }, "accept-resolution"),
  );
  expect(() =>
    s.mutate(op("work.update", "work", 1, { disposition: "completed" }, "false-work-completion")),
  ).toThrow("completed result");
});
test("completed Work fences result changes and open descendants until reopened", () => {
  const s = store();
  s.mutate(create());
  s.mutate(
    op(
      "result.record",
      "r",
      0,
      { workId: "work", outcome: "completed", summary: "Finished", evidence: ev },
      "result",
    ),
  );
  s.mutate(op("result.review", "r", 1, { decision: "accepted", evidence: ev }, "accept"));
  s.mutate(op("work.update", "work", 1, { disposition: "completed" }, "complete"));
  expect(() =>
    s.mutate(op("result.review", "r", 2, { decision: "changes_required", evidence: ev }, "revoke")),
  ).toThrow("Reopen Work");
  expect(() =>
    s.mutate(
      op(
        "result.record",
        "new",
        0,
        { workId: "work", outcome: "partial", summary: "More work", evidence: ev },
        "new",
      ),
    ),
  ).toThrow("Reopen Work");
  expect(() =>
    s.mutate({ ...create("child"), data: { ...create("child").data, parentId: "work" } }),
  ).toThrow("Reopen parent");
  s.mutate(op("work.update", "work", 2, { disposition: "active" }, "reopen"));
  s.mutate(op("result.review", "r", 2, { decision: "changes_required", evidence: ev }, "revoke"));
});
test("nested issuing parent can accept the assigned result but cannot complete Work", () => {
  const s = store();
  s.mutate(create());
  s.mutate(
    op(
      "assignment.prepare",
      "manager",
      0,
      { workId: "work", assignee: "manager", taskName: "manager", resultContract: "Review child" },
      "prepare-manager",
    ),
  );
  s.mutate(
    op(
      "assignment.prepare",
      "child",
      0,
      {
        workId: "work",
        parentAssignmentId: "manager",
        assignee: "child",
        taskName: "child",
        resultContract: "Artifact",
      },
      "prepare-child",
      "manager",
    ),
  );
  s.mutate(op("assignment.bind", "child", 1, binding, "bind-child", "manager"));
  s.mutate(
    op(
      "result.record",
      "r",
      0,
      {
        workId: "work",
        assignmentId: "child",
        outcome: "completed",
        summary: "Finished",
        evidence: ev,
        binding,
      },
      "return",
      "child",
    ),
  );
  s.mutate(
    op("result.review", "r", 1, { decision: "accepted", evidence: ev }, "accept", "manager"),
  );
  expect(s.snapshot().results[0]?.reviews[0]?.actor).toBe("manager");
  expect(() =>
    s.mutate(op("work.update", "work", 1, { disposition: "completed" }, "complete", "manager")),
  ).toThrow("declared Work lead");
});
test("single-field updates preserve every omitted Work field and do not reopen completed Work", () => {
  const s = store();
  s.mutate(create("parent"));
  s.mutate(create("dependency"));
  s.mutate({
    ...create("child"),
    data: {
      ...create("child").data,
      parentId: "parent",
      dependencies: ["dependency"],
      priority: 73,
      disposition: "waiting",
      nextAction: "Wait for answer",
      attentionRefs: ["attention:answer"],
    },
  });
  const before = s.get("work", "child");
  const after = s.mutate(
    op("work.update", "child", 1, { objective: "Clarified objective" }, "clarify"),
  );
  expect(after).toEqual({
    ...before,
    scopeRevision: 2,
    revision: 2,
    updatedAt: after.updatedAt,
    objective: "Clarified objective",
  });
  s.mutate(create());
  s.mutate(
    op(
      "result.record",
      "r",
      0,
      { workId: "work", outcome: "completed", summary: "Finished", evidence: ev },
      "returned",
    ),
  );
  s.mutate(op("result.review", "r", 1, { decision: "accepted", evidence: ev }, "accepted"));
  s.mutate(op("work.update", "work", 1, { disposition: "completed" }, "completed"));
  const done = s.get("work", "work");
  const reprioritized = s.mutate(op("work.update", "work", 2, { priority: 17 }, "priority"));
  expect(reprioritized).toEqual({
    ...done,
    revision: 3,
    updatedAt: reprioritized.updatedAt,
    priority: 17,
  });
  expect(() =>
    s.mutate(
      op("work.update", "work", 3, { objective: "Materially broader objective" }, "broaden"),
    ),
  ).toThrow("Explicitly reopen Work");
  s.mutate(op("work.update", "work", 3, { disposition: "active" }, "reopen"));
  const reopened = s.mutate(
    op(
      "work.update",
      "work",
      4,
      { objective: "Materially broader objective" },
      "broaden-after-reopen",
    ),
  );
  expect(reopened).toMatchObject({
    objective: "Materially broader objective",
    disposition: "active",
    priority: 17,
    scopeRevision: 2,
  });
  expect(() =>
    s.mutate(op("work.update", "work", 5, { disposition: "completed" }, "stale-completion")),
  ).toThrow("current scope revision");
  s.mutate(
    op(
      "result.record",
      "new-scope",
      0,
      { workId: "work", outcome: "completed", summary: "Broader scope verified", evidence: ev },
      "new-scope-return",
    ),
  );
  s.mutate(
    op("result.review", "new-scope", 1, { decision: "accepted", evidence: ev }, "new-scope-accept"),
  );
  s.mutate(op("work.update", "work", 5, { disposition: "completed" }, "new-scope-complete"));
  expect(s.snapshot().results).toHaveLength(2);
  expect(s.snapshot().results.find((result) => result.id === "r")?.scopeRevision).toBe(1);
  expect(s.snapshot().results.find((result) => result.id === "new-scope")?.scopeRevision).toBe(2);
});
test("an assignment has only one immutable no-execution settlement regardless of result ID", () => {
  const s = store();
  s.mutate(create());
  s.mutate(
    op(
      "assignment.prepare",
      "assignment",
      0,
      { workId: "work", assignee: "worker", taskName: "child", resultContract: "Artifact" },
      "prepare",
    ),
  );
  const data = {
    workId: "work",
    assignmentId: "assignment",
    outcome: "failed",
    summary: "Native dispatch not submitted",
    evidence: ev,
    binding: null,
    dispatchResolution: "not_dispatched",
  };
  const first = op("result.record", "z-settlement", 0, data, "settle");
  const result = s.mutate(first);
  expect(() =>
    s.mutate(
      op(
        "result.record",
        "a-settlement",
        0,
        { ...data, outcome: "interrupted", dispatchResolution: "dispatch_failed" },
        "contradict",
      ),
    ),
  ).toThrow("already has a no-execution resolution");
  expect(() => s.mutate(op("result.record", "another", 0, data, "duplicate"))).toThrow(
    "already has a no-execution resolution",
  );
  expect(s.mutate(first)).toEqual(result);
  expect(s.snapshot().results).toHaveLength(1);
  expect(result).toEqual(s.snapshot().results[0]!);
});
test("parent cancellation requires closed children and closed ancestry forbids new assignments", () => {
  const s = store();
  s.mutate(create("parent"));
  s.mutate({
    ...create("child"),
    data: { ...create("child").data, parentId: "parent", disposition: "active" },
  });
  expect(() =>
    s.mutate(op("work.update", "parent", 1, { disposition: "cancelled" }, "cancel-parent")),
  ).toThrow("close it before closing the parent");
  s.mutate(op("work.update", "child", 1, { disposition: "cancelled" }, "cancel-child"));
  s.mutate(op("work.update", "parent", 1, { disposition: "cancelled" }, "cancel-parent"));
  expect(() =>
    s.mutate(
      op(
        "assignment.prepare",
        "a",
        0,
        { workId: "child", assignee: "worker", taskName: "child", resultContract: "Artifact" },
        "prepare",
      ),
    ),
  ).toThrow("Reopen Work");
  expect(() =>
    s.mutate(op("work.update", "child", 2, { disposition: "active" }, "reopen-child")),
  ).toThrow("Reopen parent Work");
});
test("cancellation cannot hide an active grandchild from parent completion", () => {
  const s = store();
  s.mutate(create("parent"));
  s.mutate({ ...create("child"), data: { ...create("child").data, parentId: "parent" } });
  s.mutate({
    ...create("grandchild"),
    data: { ...create("grandchild").data, parentId: "child", disposition: "active" },
  });
  expect(() =>
    s.mutate(op("work.update", "child", 1, { disposition: "cancelled" }, "cancel-child")),
  ).toThrow("Child Work remains outstanding");
  expect(() =>
    s.mutate(op("work.update", "parent", 1, { disposition: "cancelled" }, "cancel-parent")),
  ).toThrow("Child Work remains outstanding");
  s.batch({
    operationId: "close-subtree",
    operations: [
      op("work.update", "grandchild", 1, { disposition: "cancelled" }, "cancel-grandchild"),
      op("work.update", "child", 1, { disposition: "cancelled" }, "cancel-child"),
      op("work.update", "parent", 1, { disposition: "cancelled" }, "cancel-parent"),
    ],
  });
  expect(s.snapshot().works.every((work) => work.disposition === "cancelled")).toBe(true);
});
test("completion and presentation next-action metadata preserve accepted scope evidence", () => {
  const s = store();
  s.mutate(create());
  s.mutate(
    op(
      "result.record",
      "r",
      0,
      { workId: "work", outcome: "completed", summary: "Finished", evidence: ev },
      "returned",
    ),
  );
  s.mutate(op("result.review", "r", 1, { decision: "accepted", evidence: ev }, "accepted"));
  const completed = s.mutate(
    op(
      "work.update",
      "work",
      1,
      { disposition: "completed", nextAction: "Present to human" },
      "complete",
    ),
  );
  expect(completed).toMatchObject({
    disposition: "completed",
    nextAction: "Present to human",
    scopeRevision: 1,
  });
  const metadata = s.mutate(
    op(
      "work.update",
      "work",
      2,
      { attentionRefs: ["attention:delivery"], nextAction: "Await delivery window" },
      "delivery-metadata",
    ),
  );
  expect(metadata).toMatchObject({
    disposition: "completed",
    scopeRevision: 1,
    attentionRefs: ["attention:delivery"],
  });
  s.mutate(op("result.present", "r", 2, { evidence: ev }, "presented"));
  expect(s.snapshot().results[0]?.presentations).toHaveLength(1);
});
test("a late native result retains its prepared assignment scope rather than acquiring revised scope", () => {
  const s = store();
  s.mutate(create());
  s.mutate(
    op(
      "assignment.prepare",
      "a",
      0,
      {
        workId: "work",
        assignee: "worker",
        taskName: "child",
        resultContract: "Original bounded artifact",
      },
      "prepare",
    ),
  );
  s.mutate(op("assignment.bind", "a", 1, binding, "bind"));
  s.mutate(op("work.update", "work", 1, { objective: "Expanded objective" }, "expand"));
  const returned = s.mutate(
    op(
      "result.record",
      "late",
      0,
      {
        workId: "work",
        assignmentId: "a",
        outcome: "completed",
        summary: "Original artifact returned late",
        evidence: ev,
        binding,
      },
      "late-return",
      "worker",
    ),
  );
  expect(returned).toMatchObject({ scopeRevision: 1 });
  expect(s.snapshot().assignments[0]?.scopeRevision).toBe(1);
  expect(s.snapshot().works[0]?.scopeRevision).toBe(2);
  s.mutate(op("result.review", "late", 1, { decision: "accepted", evidence: ev }, "accept-late"));
  expect(() =>
    s.mutate(op("work.update", "work", 2, { disposition: "completed" }, "stale-completion")),
  ).toThrow("current scope revision");
  s.mutate(
    op(
      "result.record",
      "current",
      0,
      {
        workId: "work",
        outcome: "completed",
        summary: "Lead verifies expanded scope",
        evidence: ev,
      },
      "current-return",
    ),
  );
  s.mutate(
    op("result.review", "current", 1, { decision: "accepted", evidence: ev }, "accept-current"),
  );
  s.mutate(op("work.update", "work", 2, { disposition: "completed" }, "complete-current"));
});
