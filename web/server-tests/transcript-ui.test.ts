import { describe, expect, test } from "bun:test";
import {
  createCodexTranscriptSource,
  parseCodexMessagePresentation,
} from "../src/transcript-ui/transcript/codex.ts";
import { groupTranscript, mergeTranscript } from "../src/transcript-ui/transcript/index.ts";

describe("owned transcript data surface", () => {
  test("keeps consecutive activities as organic disclosures in message order", () => {
    const messages = [
      { id: "answer", role: "assistant", content: "Answer", status: "complete" },
      { id: "tool-1", role: "tool", content: "one", status: "complete" },
      { id: "tool-2", role: "tool", content: "two", status: "complete" },
      { id: "next", role: "assistant", content: "Next", status: "complete" },
    ] as const;
    const blocks = groupTranscript(messages);
    expect(blocks.map((block) => block.id)).toEqual(["answer", "tool-1", "tool-2", "next"]);
    expect(blocks.every((block) => block.kind === "message")).toBe(true);
  });

  test("keeps canonical and unavailable file operations as ordered top-level rows", () => {
    const tool = (id: string) => ({
      id,
      role: "tool" as const,
      content: id,
      status: "complete" as const,
      toolActivity: { name: "Command", detail: id, state: "complete" as const },
    });
    const file = {
      id: "files",
      role: "tool" as const,
      content: "",
      status: "complete" as const,
      nativeItemType: "fileChange",
      toolActivity: { name: "Files", detail: "1 file", state: "complete" as const },
      fileChanges: [
        {
          path: "/work/src/app.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-old\n+new\n",
          diffTruncated: false,
        },
      ],
    };
    const unavailable = {
      id: "files-unavailable",
      role: "tool" as const,
      content: "",
      status: "complete" as const,
      nativeItemType: "fileChange",
      toolActivity: {
        name: "Files",
        detail: "File changes unavailable",
        state: "complete" as const,
      },
    };
    const blocks = groupTranscript([
      tool("command-1"),
      tool("command-2"),
      file,
      tool("command-3"),
      tool("command-4"),
      unavailable,
    ]);

    expect(blocks.map((block) => [block.kind, block.id])).toEqual([
      ["message", "command-1"],
      ["message", "command-2"],
      ["message", "files"],
      ["message", "command-3"],
      ["message", "command-4"],
      ["message", "files-unavailable"],
    ]);
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

  test("pins the retained Codex source to full detail and keeps activity", async () => {
    const urls: string[] = [];
    const item = {
      threadId: "thread",
      turnId: "turn",
      itemId: "command",
      rolloutOrdinal: 1,
      createdAtMs: 0,
      itemType: "commandExecution",
      item: { type: "commandExecution", command: "pwd", status: "completed", output: "/tmp" },
    };
    const transport = {
      fetch: (async (input: Parameters<typeof globalThis.fetch>[0]) => {
        const url = String(input);
        urls.push(url);
        return Response.json(
          url.includes("/items?")
            ? { items: [item], latestOrdinal: 2, turnStatus: "completed" }
            : {
                thread: {
                  id: "thread",
                  title: "Transcript",
                  cwd: "/tmp",
                  rolloutPath: "",
                  source: "",
                  threadSource: null,
                  model: null,
                  gitBranch: null,
                  preview: "",
                  updatedAtMs: 0,
                  recencyAtMs: 0,
                  hasUserEvent: true,
                  messageCount: 1,
                  turnStatus: "completed",
                },
                items: [item],
                latestOrdinal: 1,
                turnStatus: "completed",
              },
        );
      }) as typeof globalThis.fetch,
    };
    const source = createCodexTranscriptSource(transport);
    const loaded = await source.load({ id: "thread", signal: new AbortController().signal });
    const update = await source.poll({
      id: "thread",
      cursor: loaded.cursor,
      signal: new AbortController().signal,
    });

    expect(urls).toEqual([
      "/api/threads/thread?detail=full",
      "/api/threads/thread/items?after_ordinal=1&detail=full",
    ]);
    expect(loaded.messages[0]?.toolActivity?.name).toBe("Command");
    expect(update.messages[0]?.toolActivity?.name).toBe("Command");
  });
});
