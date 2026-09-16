import { expect, test } from "bun:test";
import { projectItem } from "../../src/events/conversation.ts";
import { agentMessage } from "../server/messages.ts";
import { mapCodexItem } from "../src/transcript-ui/lib/api/codex.ts";
import { groupTranscript, mergeTranscript } from "../src/transcript-ui/transcript/index.ts";

test("native compaction starts and completes as one system card, including history replay", () => {
  const item = { type: "contextCompaction", id: "compact-1" };
  const entry = { turnId: "turn", item: projectItem(item) };
  const started = agentMessage(entry, false)!;
  const completed = agentMessage(entry)!;
  expect(started).toMatchObject({
    role: "system",
    status: "working",
    content: "Older conversation context is being summarized.",
    nativeItemType: "contextCompaction",
  });
  expect(completed).toMatchObject({
    id: started.id,
    role: "system",
    status: "complete",
    content: "Older conversation context was summarized to make room for new work.",
  });
  expect(completed.toolActivity).toBeUndefined();
  const snapshot = {
    id: "thread",
    title: "Thread",
    cursor: "1",
    status: "working" as const,
    messages: [started],
  };
  const merged = mergeTranscript(snapshot, {
    messages: [completed],
    cursor: "2",
    status: "idle",
  });
  expect(merged.messages).toEqual([completed]);
  expect(agentMessage({ turnId: "turn", item: projectItem(item) })).toEqual(completed);
  expect(item).toEqual({ type: "contextCompaction", id: "compact-1" });
});

test("the retained Codex adapter uses the same system presentation", () => {
  const message = mapCodexItem({
    threadId: "thread",
    turnId: "turn",
    itemId: "compact",
    itemType: "contextCompaction",
    item: { type: "contextCompaction", id: "compact" },
    createdAtMs: 0,
    rolloutOrdinal: 1,
  });
  expect(message).toMatchObject({ role: "system", nativeItemType: "contextCompaction" });
});

test("cards separate adjacent tool groups and unknown native items retain their fallback", () => {
  const card = agentMessage({
    turnId: "turn",
    item: { type: "contextCompaction", id: "compact" },
  })!;
  const unknown = agentMessage({
    turnId: "turn",
    item: projectItem({ type: "futureNativeEvent", id: "unknown" }),
  })!;
  expect(unknown.role).toBe("tool");
  expect(unknown.nativeItemType).toBeUndefined();
  expect(unknown.toolActivity?.name).toBe("futureNativeEvent");
  const blocks = groupTranscript([unknown, card, { ...unknown, id: "next" }]);
  expect(blocks.map((block) => block.kind)).toEqual(["activity", "message", "activity"]);
  expect(blocks[1]?.id).toBe(card.id);
});
