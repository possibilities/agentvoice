import { expect, test } from "bun:test";
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
