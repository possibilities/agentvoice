import { describe, expect, test } from "bun:test";
import { parseCodexMessagePresentation } from "../src/transcript-ui/transcript/codex.ts";
import { groupTranscript, mergeTranscript } from "../src/transcript-ui/transcript/index.ts";

describe("owned transcript data surface", () => {
  test("groups consecutive activities without changing message order", () => {
    const messages = [
      { id: "answer", role: "assistant", content: "Answer", status: "complete" },
      { id: "tool-1", role: "tool", content: "one", status: "complete" },
      { id: "tool-2", role: "tool", content: "two", status: "complete" },
      { id: "next", role: "assistant", content: "Next", status: "complete" },
    ] as const;
    const blocks = groupTranscript(messages);
    expect(blocks.map((block) => block.id)).toEqual(["answer", "tool-1", "next"]);
    const activity = blocks[1];
    if (!activity || activity.kind !== "activity") throw new Error("Expected activity group");
    expect(activity.messages.map((message) => message.id)).toEqual(["tool-1", "tool-2"]);
  });

  test("merges updates by stable identity and keeps the newest cursor", () => {
    const snapshot = {
      id: "thread",
      title: "Thread",
      messages: [{ id: "answer", role: "assistant", content: "draft", status: "streaming" }],
      cursor: "first",
      status: "working",
    } as const;
    const merged = mergeTranscript(snapshot, {
      messages: [
        { id: "answer", role: "assistant", content: "complete", status: "complete" },
        { id: "next", role: "user", content: "Next", status: "complete" },
      ],
      cursor: "second",
      status: "idle",
    });
    expect(merged.messages.map((message) => [message.id, message.content])).toEqual([
      ["answer", "complete"],
      ["next", "Next"],
    ]);
    expect(merged.cursor).toBe("second");
  });

  test("keeps voice context in a readable Codex presentation", () => {
    const presentation = parseCodexMessagePresentation(
      "<realtime_delegation><input>Review the result.</input><transcript_delta>user: Review it</transcript_delta></realtime_delegation>",
    );
    expect(presentation?.title).toBe("Via Voice");
    expect(presentation?.body).toBe("Review the result.");
    expect(presentation?.details?.[0]?.content).toContain("Review it");
  });
});
