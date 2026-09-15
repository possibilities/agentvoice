import { expect, test } from "bun:test";
import { projectItem } from "../../src/events/conversation.ts";
import { agentMessage } from "../server/messages.ts";

test("native voice delegation gets readable shared presentation without changing saved content", () => {
  const content =
    "<realtime_delegation>\n  <input>Check a &lt; b &amp;&amp; c &gt; d</input>\n  <transcript_delta>assistant: Ready\nuser: Check the comparison</transcript_delta>\n</realtime_delegation>";
  const row = (text: string) =>
    agentMessage({
      turnId: "turn",
      item: {
        type: "userMessage",
        id: "input",
        content: [{ type: "text", text, text_elements: [] }],
      },
    });
  const message = row(content)!;
  expect(message.content).toBe(content);
  expect(message.presentation).toEqual({
    title: "Via Voice",
    body: "Check a < b && c > d",
    details: [{ label: "Voice context", content: "assistant: Ready\nuser: Check the comparison" }],
  });
  expect(row(`Example: ${content}`)?.presentation).toBeUndefined();
  expect(row(content.replace("</input>", ""))?.presentation).toBeUndefined();
  const tail = row(content.replace("<input>", "<source>transcript_tail_flush</source><input>"));
  expect(tail?.presentation?.title).toBe("Voice session ended");
});

test("function outputs expose decoded JSON and retain the exact native record", () => {
  const payload = JSON.stringify({ items: ["first", "last"], ok: true });
  const item = {
    type: "functionCallOutput" as const,
    id: "result",
    name: "lookup",
    namespace: "tools",
    output: JSON.stringify(payload),
  };
  const before = JSON.stringify(item);
  const message = agentMessage({ turnId: "turn", item })!;
  expect(message.toolActivity?.detail).toBe("tools.lookup");
  expect(message.toolActivity?.sections).toEqual([
    { label: "Output", content: JSON.stringify(JSON.parse(payload), null, 2) },
    { label: "Original record", content: JSON.stringify(item, null, 2) },
  ]);
  expect(JSON.stringify(item)).toBe(before);
});

test("MCP text envelopes show decoded command text and keep metadata and structured results", () => {
  const result = {
    content: [
      { type: "text", text: JSON.stringify({ output: "first line\nlast line", exit_code: 0 }) },
    ],
    structuredContent: { ok: true },
  };
  const item = {
    type: "mcpToolCall" as const,
    id: "mcp",
    server: "local",
    tool: "exec",
    status: "completed" as const,
    arguments: {},
    result,
  };
  const sections = agentMessage({ turnId: "turn", item })!.toolActivity!.sections!;
  expect(sections).toContainEqual({ label: "Output", content: "first line\nlast line" });
  expect(sections).toContainEqual({ label: "Result metadata", content: '{\n  "exit_code": 0\n}' });
  expect(sections).toContainEqual({ label: "Structured result", content: '{\n  "ok": true\n}' });
  expect(sections.at(-1)?.content).toBe(JSON.stringify(item, null, 2));
});

test("oversized tool summaries preserve real completion and failure state", () => {
  const raw = (status: "completed" | "failed") => ({
    type: "mcpToolCall",
    id: `oversized-${status}`,
    server: "inventory",
    tool: "refresh",
    status,
    arguments: { query: "x".repeat(70_000) },
    result: { content: [{ type: "text", text: "large result ".repeat(10_000) }] },
    ...(status === "failed"
      ? {
          error: {
            type: "rate_limit",
            message: "The inventory API refused the refresh.",
            details: "Retry after the service window.",
          },
        }
      : {}),
  });
  const completed = agentMessage({ turnId: "turn", item: projectItem(raw("completed")) })!;
  expect(completed).toMatchObject({
    status: "complete",
    toolActivity: {
      name: "refresh",
      detail: "inventory.refresh",
      state: "complete",
    },
  });
  expect(completed.toolActivity?.meta).toContain("completed");
  expect(completed.toolActivity?.sections?.at(-1)).toMatchObject({
    label: "Omitted content",
  });

  const failed = agentMessage({ turnId: "turn", item: projectItem(raw("failed")) })!;
  expect(failed).toMatchObject({
    status: "error",
    toolActivity: {
      name: "refresh",
      detail: "inventory.refresh",
      state: "error",
    },
  });
  expect(failed.toolActivity?.meta).toContain("failed");
  expect(failed.toolActivity?.sections).toEqual(
    expect.arrayContaining([
      { label: "Error type", content: "rate_limit" },
      { label: "Error", content: "The inventory API refused the refresh." },
      { label: "Error details", content: "Retry after the service window." },
      expect.objectContaining({ label: "Result excerpt" }),
      expect.objectContaining({ label: "Omitted content" }),
    ]),
  );
  expect(JSON.stringify(failed)).not.toContain("Content unavailable (oversized)");
});

test("media and unsupported summaries explain the actual omission reason", () => {
  const media = agentMessage({
    turnId: "turn",
    item: projectItem({
      type: "mcpToolCall",
      id: "media",
      server: "vision",
      tool: "inspect",
      status: "completed",
      arguments: {},
      result: { content: [{ type: "image", data: "data:image/png;base64,aGVsbG8=" }] },
    }),
  })!;
  const mediaOmission = media.toolActivity?.sections?.find(
    (section) => section.label === "Omitted content",
  );
  expect(mediaOmission?.content).toContain("contained media excluded from transcripts");
  expect(mediaOmission?.content).not.toContain("exceeded the");

  const unsupported = agentMessage({
    turnId: "turn",
    item: projectItem({
      type: "mcpToolCall",
      id: "malformed",
      server: "inventory",
      tool: "refresh",
      arguments: {},
    }),
  })!;
  const unsupportedOmission = unsupported.toolActivity?.sections?.find(
    (section) => section.label === "Omitted content",
  );
  expect(unsupportedOmission?.content).toContain(
    "could not be represented safely by the transcript contract",
  );
  expect(unsupportedOmission?.content).not.toContain("exceeded the");

  const traversalLimited = agentMessage({
    turnId: "turn",
    item: projectItem({
      type: "mcpToolCall",
      id: "many-nodes",
      server: "inventory",
      tool: "refresh",
      status: "completed",
      arguments: { nodes: Array.from({ length: 8_200 }, () => []) },
      result: null,
    }),
  })!;
  const traversalOmission = traversalLimited.toolActivity?.sections?.find(
    (section) => section.label === "Omitted content",
  );
  expect(traversalOmission?.content).toContain(
    "exceeded transcript traversal or representation limits",
  );
  expect(traversalOmission?.content).not.toContain("exceeded the 49,152-byte transcript limit");
});

test("subagent lifecycle rows show the affected path and action without changing the native item", () => {
  const item = {
    type: "subAgentActivity" as const,
    id: "call_GR4cGfSXKZr1ubNdikZLQ9uM",
    kind: "interacted" as const,
    agentThreadId: "01a0a060-8b15-7211-b62c-26e9bc56d447",
    agentPath: "/root/android_disconnected_layout",
  };
  const before = JSON.stringify(item);
  const message = agentMessage({ turnId: "turn", item })!;
  expect(message).toMatchObject({
    id: '["turn","call_GR4cGfSXKZr1ubNdikZLQ9uM"]',
    role: "tool",
    content: "Interacted /root/android_disconnected_layout",
    toolActivity: {
      name: "Subagent",
      detail: "/root/android_disconnected_layout",
      meta: "Interacted",
      state: "complete",
    },
  });
  expect(message.toolActivity?.sections).toEqual([
    { label: "Activity", content: "Interacted" },
    { label: "Agent path", content: "/root/android_disconnected_layout" },
    { label: "Agent thread", content: "01a0a060-8b15-7211-b62c-26e9bc56d447" },
    { label: "Activity ID", content: "call_GR4cGfSXKZr1ubNdikZLQ9uM" },
    { label: "Original record", content: JSON.stringify(item, null, 2) },
  ]);
  expect(JSON.stringify(item)).toBe(before);
});
