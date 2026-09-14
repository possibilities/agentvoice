import { expect, test } from "bun:test";
import { toolOutputSections } from "../server/tool-output.ts";

test("plain, malformed, scalar-looking and precision-sensitive output remain intact", () => {
  for (const text of [
    "  first\nlast  ",
    "{unfinished",
    "007",
    "true",
    "null",
    '{"id":9007199254740993}',
    '{"value":1e999}',
    `[${" ".repeat(262144)}]`,
  ])
    expect(toolOutputSections(text)).toEqual([{ label: "Output", content: text }]);
});

test("decoding is bounded and arbitrary string properties retain their meaning", () => {
  let text = "body";
  for (let i = 0; i < 4; i++) text = JSON.stringify(text);
  expect(toolOutputSections(text)[0]?.content).toBe(JSON.parse(JSON.parse(text)));
  const payload = { literal: '{"not":"an envelope"}', path: "C:\\new\\file" };
  expect(toolOutputSections(JSON.stringify(payload))).toEqual([
    { label: "Output", content: JSON.stringify(payload, null, 2) },
  ]);
});

test("native function and dynamic text blocks decode without discarding nontext evidence", () => {
  for (const type of ["input_text", "inputText"])
    expect(
      toolOutputSections([
        { type, text: '{"ok":true}' },
        { type: "input_image", image_url: "data:fixture" },
      ]),
    ).toEqual([
      { label: "Output 1", content: '{\n  "ok": true\n}' },
      {
        label: "Output 2",
        content: '{\n  "type": "input_image",\n  "image_url": "data:fixture"\n}',
      },
    ]);
});
