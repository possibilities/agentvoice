import { toString as mdastToString } from "mdast-util-to-string";
import remarkParse from "remark-parse";
import { unified } from "unified";

const parser = unified().use(remarkParse);

/** Codex may seed title metadata with an entire Markdown prompt. Keep it a title. */
export function transcriptTitle(value: string): string {
  const tree = parser.parse(value);
  for (const block of tree.children) {
    // Definitions and raw HTML are not human-readable title candidates.
    if (block.type === "definition" || block.type === "html") continue;
    const text = mdastToString(block).replace(/\s+/gu, " ").trim();
    if (!text) continue;
    const characters = Array.from(text);
    return characters.length > 120 ? characters.slice(0, 119).join("").trimEnd() + "…" : text;
  }
  return "Untitled Agent conversation";
}
