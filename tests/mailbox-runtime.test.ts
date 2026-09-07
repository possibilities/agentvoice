import { expect, test } from "bun:test";
import { AppServerError } from "../src/core/attach.ts";
import {
  MAILBOX_NAMESPACE,
  MAILBOX_OUTPUT,
  type MailboxObservation,
  type MailboxRuntime,
} from "../src/mailbox/contract.ts";
import { runtimeHarness } from "./fixtures/runtime-harness.ts";

test("runtime sends a tally-only standalone output during active work and observes its recorded item", async () => {
  const observations: MailboxObservation[] = [];
  let mailbox!: MailboxRuntime;
  const h = runtimeHarness(
    {},
    {
      onMailbox: (e) => observations.push(e),
      onMailboxReady: (api) => {
        mailbox = api;
      },
    },
  );
  h.native.override = (method) =>
    method === "thread/loaded/list" ? Promise.resolve({ data: [], nextCursor: null }) : undefined;
  try {
    await h.runtime.start();
    const root = h.runtime.currentReady!.threadId;
    const notify = h.native.options.onNotification;
    notify("turn/started", { threadId: root, turn: { id: "parent-active", status: "inProgress" } });
    for (const id of ["finished-child", "working-child"]) {
      notify("thread/started", {
        thread: {
          id,
          parentThreadId: root,
          cwd: h.directory,
          name: "PRIVATE_TASK_NAME",
          status: { type: "idle" },
        },
      });
      notify("turn/started", { threadId: id, turn: { id: `turn-${id}`, status: "inProgress" } });
    }
    notify("turn/completed", {
      threadId: "finished-child",
      turn: { id: "turn-finished-child", status: "completed", items: [{ text: "PRIVATE_RESULT" }] },
    });
    expect(observations.filter((e) => e.kind === "completed")).toHaveLength(1);
    h.native.override = (method, params) => {
      if (method !== "turn/start") return undefined;
      const tool = params["toolOutput"] as { output: string; name: string; namespace: string };
      const body = JSON.parse(tool.output);
      expect(params).toMatchObject({
        threadId: root,
        input: [],
        turnTrigger: "subagentCompletion",
      });
      expect(tool).toMatchObject({ name: MAILBOX_OUTPUT, namespace: MAILBOX_NAMESPACE });
      expect(body).toMatchObject({ completed: 3, inFlight: 1, inventoryComplete: true });
      expect(tool.output).not.toContain("PRIVATE_");
      expect(tool.output).not.toContain("working-child");
      notify("item/completed", {
        threadId: root,
        turnId: "parent-active",
        item: { type: "functionCallOutput", id: "notice-item", ...tool },
      });
      return Promise.resolve({ turn: { id: "parent-active", status: "inProgress" } });
    };
    expect(
      await mailbox.wake({
        eventId: "notice",
        instanceId: "instance",
        rootThreadId: root,
        completed: 3,
      }),
    ).toEqual({ status: "accepted", turnId: "parent-active" });
    expect(observations.some((e) => e.kind === "recorded" && e.itemId === "notice-item")).toBe(
      true,
    );
    expect(
      await mailbox.wake({
        eventId: "foreign",
        instanceId: "instance",
        rootThreadId: "different",
        completed: 3,
      }),
    ).toEqual({ status: "unavailable" });
    h.native.override = (method) =>
      method === "turn/start"
        ? Promise.reject(new AppServerError("private refusal", -32600))
        : undefined;
    expect(
      await mailbox.wake({
        eventId: "refused",
        instanceId: "instance",
        rootThreadId: root,
        completed: 3,
      }),
    ).toEqual({ status: "refused" });
    await h.runtime.shutdown();
    expect(
      await mailbox.wake({
        eventId: "late",
        instanceId: "instance",
        rootThreadId: root,
        completed: 3,
      }),
    ).toEqual({ status: "unavailable" });
  } finally {
    await h.cleanup();
  }
});
