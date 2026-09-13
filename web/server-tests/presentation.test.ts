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
