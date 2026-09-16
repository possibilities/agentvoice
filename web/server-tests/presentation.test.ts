import { expect, test } from "bun:test";
import { projectItem } from "../../src/events/conversation.ts";
import { agentMessage } from "../server/messages.ts";

const row = (text: string) =>
  agentMessage({
    turnId: "turn",
    item: {
      type: "userMessage",
      id: "input",
      content: [{ type: "text", text, text_elements: [] }],
    },
  });

test("native voice delegation gets readable shared presentation without changing saved content", () => {
  const content =
    "<realtime_delegation>\n  <input>Check a &lt; b &amp;&amp; c &gt; d</input>\n  <transcript_delta>assistant: Ready\nuser: Check the comparison</transcript_delta>\n</realtime_delegation>";
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

test("native image input keeps client identity and ordered transcript markers without references", () => {
  const privateUrl = "data:image/png;base64,private-image-bytes";
  const privatePath = "/Users/operator/private/clipboard.png";
  const item = projectItem({
    type: "userMessage",
    id: "native-input",
    clientId: "client-input",
    content: [
      { type: "image", url: privateUrl, detail: null },
      { type: "localImage", path: privatePath, detail: null },
      { type: "text", text: "Compare these", text_elements: [] },
    ],
  });
  const message = agentMessage({ turnId: "turn", item })!;
  expect(message.id).toBe("client:client-input");
  expect(message.content).toBe("[Image #1]\n\n[Image #2]\n\nCompare these");
  expect(JSON.stringify(message)).not.toContain(privateUrl);
  expect(JSON.stringify(message)).not.toContain(privatePath);
});

test("voice presentation recovers the 5:47 trailing fragment without duplicating it", () => {
  const content = `<realtime_delegation>
  <input>, but we wanna use native SDK</input>
  <transcript_delta>assistant: Checking that in the fleet
user: Great
assistant: Great.
user: Yep I think we should do a um... what do you call that? uh- Like a preparatory work item, um, an enabler. That's what I was like trying to think of. An enabler for the Agent Voice Native SDK menu app, where we move the existing menu app with the um QR code over- Just the existing, all existing functionality over from um, whatever it is now, it's a native app, but we wanna use native SDK
user: , but we wanna use native SDK</transcript_delta>
</realtime_delegation>`;
  expect(row(content)?.presentation?.body).toBe(
    "Yep I think we should do a um... what do you call that? uh- Like a preparatory work item, um, an enabler. That's what I was like trying to think of. An enabler for the Agent Voice Native SDK menu app, where we move the existing menu app with the um QR code over- Just the existing, all existing functionality over from um, whatever it is now, it's a native app, but we wanna use native SDK",
  );
});

test("voice presentation preserves the adjacent split input after native rejoins it", () => {
  const content = `<realtime_delegation>
  <input>Wait, before we do that, can you make sure that as it start us yet</input>
  <transcript_delta>assistant: Got it. Checking that.
user: Yep I think we should make the Native SDK enabler
assistant: Yes. We’ll make that the enabler.
user: Wait, before we do that, can you make sure that as it start us yet</transcript_delta>
</realtime_delegation>`;
  expect(row(content)?.presentation?.body).toBe(
    "Wait, before we do that, can you make sure that as it start us yet",
  );
});

test("voice presentation rejoins a later interruption split across transcript entries", () => {
  const content = `<realtime_delegation>
  <input>update the HUD guidance if this change would affect anything</input>
  <transcript_delta>assistant: Checking the HUD work item now.
user: That should, um
assistant: Yeah.
user: update the HUD guidance if this change would affect anything</transcript_delta>
</realtime_delegation>`;
  expect(row(content)?.presentation?.body).toBe(
    "That should, um update the HUD guidance if this change would affect anything",
  );
});

test("voice presentation does not replace a repeated input with an older user turn", () => {
  const content = `<realtime_delegation>
  <input>yes.</input>
  <transcript_delta>user: I said yes.
assistant: We can revisit that later.
user: yes.</transcript_delta>
</realtime_delegation>`;
  expect(row(content)?.presentation?.body).toBe("yes.");
});

test("voice presentation does not prefix a complete transcript row with an older fragment", () => {
  const content = `<realtime_delegation>
  <input>fix this</input>
  <transcript_delta>user: We should maybe
assistant: Okay.
user: Please fix this</transcript_delta>
</realtime_delegation>`;
  expect(row(content)?.presentation?.body).toBe("Please fix this");
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
