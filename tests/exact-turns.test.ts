import { expect, test } from "bun:test";
import {
  exactTurnsSchema,
  parseTimingTargets,
  readExactTurns,
} from "../src/threads/exact-turns.ts";

const identity = { instanceId: "instance", generation: 1, rootThreadId: "root" };
const target = { rootThreadId: "root", threadId: "worker", turnId: "old-bound" };
const envelope = (data: unknown[], nextCursor: string | null = null) => ({
  ...identity,
  method: "conversation.turns.list",
  threadId: "worker",
  revisionBefore: 4,
  revisionAfter: 4,
  changedDuringRead: false,
  data,
  nextCursor,
});
test("targets are bounded unique identities without selectors or content", () => {
  expect(parseTimingTargets(JSON.stringify([target])).length).toBe(1);
  for (const value of [
    [target, target],
    [{ ...target, turnId: "../private" }],
    [{ ...target, prompt: "private" }],
    Array.from({ length: 129 }, (_, n) => ({ ...target, turnId: `t${n}` })),
  ])
    expect(() => parseTimingTargets(JSON.stringify(value))).toThrow();
  expect(() => parseTimingTargets(" ".repeat(65537))).toThrow();
});
test("finds exact older turns on later pages and strips all content", async () => {
  const calls: unknown[] = [];
  const reader = {
    async request(method: string, input: unknown) {
      calls.push({ method, input });
      return calls.length === 1
        ? envelope([{ id: "latest", status: "completed", completedAt: 200 }], "next")
        : envelope([
            {
              id: "old-bound",
              status: "completed",
              startedAt: 50,
              completedAt: 100,
              items: [],
              error: null,
            },
          ]);
    },
  };
  const records = await readExactTurns(
    reader,
    identity,
    [target, { ...target, turnId: "absent" }],
    Date.now() + 1000,
  );
  expect(records).toEqual([
    { ...target, state: "observed", status: "completed", startedAt: 50, completedAt: 100 },
    { ...target, turnId: "absent", state: "not_found" },
  ]);
  expect(JSON.stringify(records)).not.toContain("items");
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({
    method: "conversation.turns.list",
    input: { threadId: "worker", cursor: "next", limit: 50 },
  });
});
test("wrong roots, incoherent pages, repeated cursors, malformed times and budget remain explicit", async () => {
  expect(
    await readExactTurns(
      {
        request: async () => {
          throw new Error("must not read");
        },
      },
      identity,
      [{ ...target, rootThreadId: "other" }],
      Date.now() + 1000,
    ),
  ).toEqual([{ ...target, rootThreadId: "other", state: "unavailable", reason: "root_mismatch" }]);
  for (const page of [
    { ...envelope([]), threadId: "different" },
    { ...envelope([]), instanceId: "different" },
    { ...envelope([]), changedDuringRead: true },
    envelope([{ id: "old-bound", status: "completed", completedAt: 1.5 }]),
    envelope([{ id: "old-bound", status: "completed", startedAt: 30, completedAt: 20 }]),
    envelope([
      { id: "old-bound", status: "completed", completedAt: 20 },
      { id: "old-bound", status: "completed", completedAt: 21 },
    ]),
  ]) {
    const result = await readExactTurns(
      { request: async () => page },
      identity,
      [target],
      Date.now() + 1000,
    );
    expect(result[0]?.state).toBe("unavailable");
  }
  expect(
    (
      await readExactTurns(
        { request: async () => envelope([], "repeat") },
        identity,
        [target],
        Date.now() + 1000,
      )
    )[0],
  ).toMatchObject({ state: "unavailable", reason: "invalid" });
  expect(
    (
      await readExactTurns(
        { request: async () => envelope([]) },
        identity,
        [target],
        Date.now() - 1,
      )
    )[0],
  ).toMatchObject({ state: "unavailable", reason: "budget" });
  expect(() =>
    exactTurnsSchema.parse([
      { ...target, state: "observed", status: "inProgress", completedAt: 5 },
    ]),
  ).toThrow();
});
test("cross-page revision changes cannot establish absence", async () => {
  let page = 0;
  const rows = await readExactTurns(
    {
      request: async () =>
        ++page === 1
          ? envelope([], "next")
          : { ...envelope([]), revisionBefore: 5, revisionAfter: 5 },
    },
    identity,
    [target],
    Date.now() + 1000,
  );
  expect(rows[0]).toMatchObject({ state: "unavailable", reason: "changed" });
});

test("conflicting repeated turn pages invalidate earlier target evidence", async () => {
  let page = 0;
  const output = await readExactTurns(
    {
      request: async () =>
        ++page === 1
          ? envelope([{ id: "old-bound", status: "completed", completedAt: 10 }], "next")
          : envelope([{ id: "old-bound", status: "completed", completedAt: 20 }]),
    },
    identity,
    [target, { ...target, turnId: "other" }],
    Date.now() + 1000,
  );
  expect(output.every((row) => row.state === "unavailable" && row.reason === "invalid")).toBe(true);
});
