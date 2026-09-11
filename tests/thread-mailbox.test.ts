import { expect, test } from "bun:test";
import { LifecycleFeed } from "../src/events/feed.ts";
import { eventSocketFrameSchema } from "../src/events/schema.ts";
import {
  type Completion,
  type InFlight,
  MAILBOX_TOOL,
  type MailboxObservation,
  mailboxEventSchemas,
  wakeNotice,
} from "../src/mailbox/contract.ts";
import { SubagentObserver } from "../src/mailbox/observer.ts";
import { ThreadMailbox } from "../src/mailbox/state.ts";

const at = "2026-09-07T03:00:00.000Z";
const child = (threadId = "child", turnId = "turn") => ({
  threadId,
  turnId,
  name: "test child",
  agentPath: "/root/test",
  waitingOn: [],
});
const completion = (turnId = "turn", status: Completion["status"] = "completed"): Completion => ({
  ...child("child", turnId),
  status,
  observedAt: at,
});
const inventory = (revision = 1, threads = [child()]): InFlight => ({
  revision,
  threads,
  complete: true,
  observedAt: at,
});
function mailbox() {
  const events: { event: string; data: unknown }[] = [];
  const state = new ThreadMailbox("instance", (event, data) => {
    expect(mailboxEventSchemas[event].safeParse(data).success).toBe(true);
    events.push({ event, data });
  });
  return { state, events };
}

test("counts accumulate per terminal turn, opens consume atomically, retries do not consume new work", () => {
  const { state, events } = mailbox();
  state.update(inventory());
  state.complete(completion("a"), 1);
  state.complete(completion("b", "failed"), 1);
  expect(state.complete(completion("a"), 1)).toBeUndefined();
  expect(state.snapshot().completed).toBe(2);
  const first = state.open("open-1");
  expect(first.entries.map((e) => e.status)).toEqual(["completed", "failed"]);
  expect(state.snapshot().completed).toBe(0);
  expect(state.snapshot().inFlight.threads).toHaveLength(1);
  state.complete(completion("c", "interrupted"), 1);
  expect(state.open("open-1")).toEqual(first);
  expect(state.snapshot().completed).toBe(1);
  expect(state.open("open-2").entries[0]?.turnId).toBe("c");
  expect(state.open("stale-wake").entries).toEqual([]);
  expect(events.filter((e) => e.event === "mailbox.opened")).toHaveLength(3);
  expect(events.some((e) => /receipt/u.test(e.event))).toBe(false);
});

test("large opens retain unreturned entries, overflow is explicit, and consumers cannot mutate stored batches", () => {
  const { state } = mailbox();
  for (let n = 0; n < 257; n++) state.complete(completion(String(n)), 1);
  expect(state.snapshot()).toMatchObject({ completed: 257, unavailableCompletions: 1 });
  const opened = state.open("batch");
  expect(opened.entries).toHaveLength(32);
  expect(opened.unavailableCompletions).toBe(1);
  expect(opened.remainingCompleted).toBe(224);
  opened.entries[0]!.name = "tampered";
  expect(state.open("batch").entries[0]?.name).toBe("test child");
  expect(Buffer.byteLength(JSON.stringify(opened))).toBeLessThan(24 * 1024);
});

test("wake recording can precede the RPC reply and pending input is not resubmitted on runtime replacement", () => {
  const { state } = mailbox();
  const eventId = state.complete(completion(), 1)!;
  const request = { eventId, instanceId: "instance", rootThreadId: "root", completed: 1 };
  const notice = wakeNotice(request, inventory());
  state.submitting(notice, 1);
  state.recorded(eventId, 1, "parent-turn", "item");
  state.outcome(eventId, 1, { status: "accepted", turnId: "parent-turn" });
  expect(state.snapshot().recentWakes[0]).toMatchObject({
    status: "accepted",
    recorded: { itemId: "item" },
  });
  state.unavailableRuntime();
  expect(state.snapshot().completed).toBe(1);
  expect(state.snapshot().inFlight.complete).toBe(false);
  expect(state.snapshot().recentWakes[0]?.status).toBe("accepted");
  state.outcome(eventId, 2, { status: "refused" });
  expect(state.snapshot().recentWakes[0]?.status).toBe("accepted");
});

test("late inventory reads cannot rewind working state and notice text contains only tallies", () => {
  const { state } = mailbox();
  state.update(inventory(2, []));
  state.update(inventory(1));
  expect(state.snapshot().inFlight.threads).toEqual([]);
  const n = wakeNotice(
    { eventId: "event", instanceId: "instance", rootThreadId: "root", completed: 3 },
    inventory(),
  );
  expect(n.message).toBe(
    `3 completion notices are waiting in your thread mailbox; 1 subagent is still working. Call ${MAILBOX_TOOL} for details.`,
  );
  expect(JSON.stringify(n)).not.toContain("test child");
  expect(n.open.arguments).toEqual({ operationId: "event", expectedInstanceId: "instance" });
});

test("mailbox event replay and snapshots survive a runtime generation boundary", () => {
  const feed = new LifecycleFeed("instance");
  const state = new ThreadMailbox("instance", feed.mailbox);
  feed.listen((frame) => expect(eventSocketFrameSchema.safeParse(frame).success).toBe(true));
  state.complete(completion(), 1);
  feed.runtime(2, { phase: "starting", workspace: "/work", mainThreadId: "root" });
  expect(feed.mailboxSnapshot().state.completed).toBe(1);
  expect(feed.mailboxReplay(0, 100).events.some((e) => e.event === "mailbox.child.completed")).toBe(
    true,
  );
  expect(state.snapshot().completed).toBe(1);
});

const metadata = (threadId: string, parent = "root", cwd = "/work") => ({
  id: threadId,
  parentThreadId: parent,
  cwd,
  name: "test child",
  status: { type: "idle" },
});
async function observer(request?: (method: string, params: unknown) => Promise<unknown>) {
  const events: MailboxObservation[] = [];
  const o = new SubagentObserver(
    "root",
    "/work",
    request ?? (async () => ({ data: [], nextCursor: null })),
    (e) => events.push(e),
  );
  await o.start();
  return { o, events };
}
function turn(
  o: SubagentObserver,
  method: string,
  threadId: string,
  turnId: string,
  status: string,
) {
  o.notification(method, {
    threadId,
    turn: { id: turnId, status, items: [{ text: "PRIVATE_RESULT" }] },
  });
}

test("coding activity child inventory clears loaded turns on unload and system error", async () => {
  for (const status of ["notLoaded", "systemError"]) {
    const { o } = await observer();
    try {
      o.notification("thread/started", { thread: metadata("child") });
      turn(o, "turn/started", "child", "work", "inProgress");
      expect(o.snapshot().threads).toHaveLength(1);
      o.notification("thread/status/changed", { threadId: "child", status: { type: status } });
      expect(o.snapshot().threads).toHaveLength(0);
      turn(o, "turn/started", "child", "work", "inProgress");
      expect(o.snapshot().threads).toHaveLength(0);
      if (status === "systemError") expect(o.snapshot().complete).toBe(false);
    } finally {
      o.stop();
    }
  }
});

test("native observation filters unrelated threads and grandparents, deduplicates turns, and strips results", async () => {
  const { o, events } = await observer();
  try {
    for (const raw of [
      metadata("child"),
      metadata("foreign", "elsewhere"),
      metadata("grandchild", "child"),
      metadata("other-workspace", "root", "/elsewhere"),
    ]) {
      o.notification("thread/started", { thread: raw });
      turn(o, "turn/started", raw.id, "t", "inProgress");
      turn(o, "turn/completed", raw.id, "t", "completed");
      turn(o, "turn/completed", raw.id, "t", "completed");
    }
    turn(o, "turn/completed", "root", "root-turn", "completed");
    expect(events.filter((e) => e.kind === "completed")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_RESULT");
    expect(o.snapshot().threads).toEqual([]);
    turn(o, "turn/started", "child", "next", "inProgress");
    o.notification("thread/status/changed", {
      threadId: "child",
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    });
    turn(o, "turn/completed", "child", "t", "completed");
    expect(o.snapshot().threads[0]).toMatchObject({
      turnId: "next",
      waitingOn: ["waitingOnApproval"],
    });
  } finally {
    o.stop();
  }
});

test("completion before metadata and a newer child turn preserve the correct completion and in-flight identities", async () => {
  const read = Promise.withResolvers<unknown>();
  const { o, events } = await observer(async (method) =>
    method === "thread/loaded/list" ? { data: [], nextCursor: null } : read.promise,
  );
  try {
    turn(o, "turn/completed", "child", "old", "failed");
    turn(o, "turn/started", "child", "new", "inProgress");
    expect(events.some((e) => e.kind === "completed")).toBe(false);
    read.resolve({ thread: metadata("child") });
    await Bun.sleep(5);
    expect(events.find((e) => e.kind === "completed")).toMatchObject({
      completion: { threadId: "child", turnId: "old", status: "failed" },
    });
    expect(o.snapshot().threads[0]?.turnId).toBe("new");
    expect(o.snapshot().complete).toBe(true);
  } finally {
    read.resolve(null);
    o.stop();
  }
});

test("mailbox caller validation waits for correlated native tool activity, refuses children, and stops on teardown", async () => {
  const { o, events } = await observer();
  const pending = o.authorize({ threadId: "root", callId: "native-call" });
  o.notification("item/started", {
    threadId: "root",
    turnId: "t",
    item: {
      type: "mcpToolCall",
      id: "native-call",
      server: "agentvoice_control",
      tool: MAILBOX_TOOL,
    },
  });
  expect(await pending).toBe(true);
  expect(await o.authorize({ threadId: "child", callId: "native-call" })).toBe(false);
  o.stop();
  turn(o, "turn/completed", "child", "stopping", "interrupted");
  expect(events.some((e) => e.kind === "completed")).toBe(false);
  expect(await o.authorize({ threadId: "root", callId: "native-call" })).toBe(false);
});
