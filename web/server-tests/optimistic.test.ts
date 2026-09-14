import { expect, test } from "bun:test";
import { agentMessage } from "../server/messages.ts";
import {
  type OptimisticSubmission,
  optimisticMessages,
  optimisticQueue,
} from "../src/optimistic.ts";

const row = (id: string, overrides: Partial<OptimisticSubmission> = {}): OptimisticSubmission => ({
  id,
  viewId: "view",
  text: "same text",
  action: "send",
  state: "pending",
  anchor: "anchor",
  ...overrides,
});
const anchor = {
  id: "anchor",
  role: "assistant" as const,
  status: "complete" as const,
  content: "Before",
};

test("optimistic messages retain submission order while history appends and reconcile only exact native identity", () => {
  const pending = [row("one"), row("two", { anchor: "client:one" })];
  const unrelated = { ...anchor, id: "unrelated", role: "user" as const, content: "same text" };
  const messages = optimisticMessages([anchor, unrelated], pending);
  expect(messages.map((message) => message.id)).toEqual([
    "anchor",
    "client:one",
    "client:two",
    "unrelated",
  ]);
  const canonical = agentMessage({
    turnId: "turn",
    item: {
      type: "userMessage",
      id: "native-id",
      clientId: "one",
      content: [{ type: "text", text: "Authoritative correction", text_elements: [] }],
    },
  })!;
  const reconciled = optimisticMessages([anchor, canonical, unrelated], pending);
  expect(reconciled.map((message) => message.id)).toEqual([
    "anchor",
    "client:one",
    "client:two",
    "unrelated",
  ]);
  expect(reconciled.find((message) => message.id === "client:one")?.content).toBe(
    "Authoritative correction",
  );
  expect(reconciled.filter((message) => message.id === "client:one")).toHaveLength(1);
  expect(canonical).not.toHaveProperty("deliveryStatus");
});

test("unknown submissions remain visible if their anchor is gone; known rows retain identity", () => {
  const native = [anchor];
  expect(optimisticMessages(native, [])).toBe(native);
  expect(optimisticMessages([], [row("lost", { state: "unknown" })])[0]).toMatchObject({
    id: "client:lost",
    status: "error",
    deliveryStatus: "Delivery unknown · check before resending",
  });
});

test("optimistic queues display immediately and reconcile a fast drain without duplicating history", () => {
  const pending = [row("queued", { action: "queue" })];
  expect(optimisticMessages([], pending)).toEqual([]);
  expect(optimisticQueue([], pending, [])).toMatchObject([
    { id: "queued", text: "same text", disabled: true },
  ]);
  const corrected = [
    { id: "queued", text: "edited text", disabled: false, canResume: false, canSteer: true },
  ];
  expect(optimisticQueue(corrected, pending, [])).toBe(corrected);
  expect(optimisticQueue([], pending, [{ ...anchor, id: "client:queued", role: "user" }])).toEqual(
    [],
  );
});
