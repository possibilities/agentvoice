import { expect, test } from "bun:test";
import { projectItem } from "../../src/events/conversation.ts";
import { agentMessage } from "../server/messages.ts";
import { mapCodexItem } from "../src/transcript-ui/lib/api/codex.ts";
import { mapCodexSubagentEvent } from "../src/transcript-ui/lib/api/codex-subagent-event.ts";
import { groupTranscript, mergeTranscript } from "../src/transcript-ui/transcript/index.ts";

const item = {
  type: "subAgentActivity" as const,
  id: "spawn-call",
  agentPath: "/root/review",
  agentThreadId: "child-thread",
  kind: "started" as const,
};

test.each([
  ["started", "Subagent started"],
  ["completed", "Subagent turn completed"],
  ["interrupted", "Subagent interruption requested"],
] as const)("%s is an observed event, not a live agent status", (kind, title) => {
  const native = { ...item, kind };
  const entry = { turnId: "parent-turn", item: projectItem(native) };
  const started = agentMessage(entry, false)!;
  const completed = agentMessage(entry, true)!;
  // Native sends both lifecycle envelopes immediately for an already observed activity.
  expect(started).toEqual(completed);
  expect(completed).toMatchObject({
    role: "system",
    status: "complete",
    nativeItemType: "subAgentActivity",
    content: `${title}: /root/review`,
    presentation: { title, body: "/root/review" },
  });
  expect(completed.toolActivity).toBeUndefined();
  expect(completed.presentation?.details).toEqual([
    { label: "Agent path", content: item.agentPath },
    { label: "Agent thread", content: item.agentThreadId },
    { label: "Activity", content: kind },
    { label: "Activity ID", content: item.id },
  ]);
  const retained = mapCodexItem({
    threadId: "parent",
    turnId: "parent-turn",
    itemId: item.id,
    itemType: "subAgentActivity",
    item: native,
    createdAtMs: 0,
    rolloutOrdinal: 1,
  })!;
  expect(retained.presentation).toEqual(completed.presentation);
  expect(retained.content).toEqual(completed.content);
  expect(native).toEqual({ ...item, kind });
  const merged = mergeTranscript(
    {
      id: "parent",
      title: "Parent",
      cursor: "1",
      status: "working",
      messages: [started],
    },
    { messages: [completed], cursor: "2", status: "working" },
  );
  expect(merged.messages).toEqual([completed]);
});

test("lifecycle rows disappear while ordinary collaboration activity stays ordered", () => {
  const start = agentMessage({ turnId: "parent-turn", item })!;
  const end = agentMessage({
    turnId: "parent-turn",
    item: { ...item, id: "end-1", kind: "completed" },
  })!;
  const nextEnd = agentMessage({
    turnId: "parent-turn",
    item: { ...item, id: "end-2", kind: "completed" },
  })!;
  const interaction = agentMessage({
    turnId: "parent-turn",
    item: { ...item, id: "send", kind: "interacted" },
  })!;
  expect(interaction.role).toBe("tool");
  expect(
    groupTranscript([interaction, start, end, nextEnd, { ...interaction, id: "send-2" }]).map(
      (block) => block.id,
    ),
  ).toEqual([interaction.id, "send-2"]);
  expect(new Set([start.id, end.id, nextEnd.id]).size).toBe(3);
});

test("malformed, unknown, and ordinary collaboration records retain fallback activity", () => {
  for (const value of [
    null,
    [],
    {},
    { ...item, kind: "future" },
    { ...item, kind: "toString" },
    { ...item, agentPath: " " },
    { ...item, agentThreadId: null },
    { ...item, id: "" },
    { ...item, kind: "interacted" },
  ])
    expect(mapCodexSubagentEvent(value)).toBeNull();
  const future = agentMessage({ turnId: "turn", item: projectItem({ ...item, kind: "future" }) })!;
  expect(future.role).toBe("tool");
  expect(future.nativeItemType).toBeUndefined();
  const collab = agentMessage({
    turnId: "turn",
    item: projectItem({
      type: "collabAgentToolCall",
      id: "spawn-v1",
      tool: "spawnAgent",
      status: "completed",
      senderThreadId: "parent",
      receiverThreadIds: ["child"],
      agentsStates: { child: { status: "running" } },
      model: "requested-model",
      reasoningEffort: "high",
    }),
  })!;
  expect(collab.role).toBe("tool");
  expect(collab.toolActivity?.sections?.[0]?.content).toContain("requested-model");
});
