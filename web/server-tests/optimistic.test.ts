import { expect, test } from "bun:test";
import { agentMessage } from "../server/messages.ts";
import {
  type OptimisticSubmission,
  observed,
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

test("an accepted code block replaces its streaming echo until exact canonical completion", () => {
  const code = "```text\n./bin/funk install-hardening\nPassword:\n```";
  const submission = row("code", { text: code, state: "accepted" });
  const streaming = {
    id: "client:code",
    role: "user" as const,
    content: `${code}\n\n./bin/funk install-hardening`,
    status: "streaming" as const,
  };
  const projected = optimisticMessages([anchor, streaming], [submission]);
  expect(projected.map(({ id }) => id)).toEqual(["anchor", "client:code"]);
  expect(projected[1]).toMatchObject({
    content: code,
    status: "working",
    deliveryStatus: "Accepted · waiting for transcript",
  });

  const canonical = {
    ...streaming,
    content: "Canonical corrected text",
    status: "complete" as const,
  };
  expect(optimisticMessages([anchor, canonical], [submission])[1]).toBe(canonical);
});

test("optimistic images use attachment metadata while canonical image text remains exact", () => {
  const submission = row("image", {
    text: "Inspect this image",
    images: [{ path: "/workspace/private.png" }],
    state: "accepted",
  });
  expect(optimisticMessages([], [submission])).toEqual([
    expect.objectContaining({
      id: "client:image",
      content: "Inspect this image",
      pendingImageCount: 1,
      deliveryStatus: "Accepted · waiting for transcript",
    }),
  ]);
  expect(optimisticMessages([], [submission])[0]?.content).not.toContain("[Image #1]");

  const canonical = {
    id: "client:image",
    role: "user" as const,
    content: "[Image #1]\n\nCanonical image caption",
    status: "complete" as const,
  };
  expect(optimisticMessages([canonical], [submission])).toEqual([canonical]);
});

test("unknown submissions remain visible if their anchor is gone; known rows retain identity", () => {
  const native = [anchor];
  expect(optimisticMessages(native, [])).toBe(native);
  expect(optimisticMessages([], [row("lost", { state: "unknown" })])[0]).toMatchObject({
    id: "client:lost",
    status: "error",
    deliveryStatus: "Delivery unknown · check before resending",
  });
  expect(
    observed(
      {
        id: "view",
        phase: "live",
        voice: [],
        agent: [{ ...anchor, id: "client:lost", status: "streaming" }],
      },
      "lost",
    ),
  ).toBe(false);
  expect(
    observed(
      { id: "view", phase: "live", voice: [], agent: [{ ...anchor, id: "client:lost" }] },
      "lost",
    ),
  ).toBe(true);
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
