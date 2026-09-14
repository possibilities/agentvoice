import type { TranscriptMessage } from "@agentchats/transcript";

type Section = NonNullable<NonNullable<TranscriptMessage["toolActivity"]>["sections"]>[number];
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const printable = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);

function decode(value: unknown): unknown {
  // Some native tools encode their result twice. Never parse arbitrary nested
  // properties, scalar-looking plain text, or a payload beyond the native limit.
  for (let layer = 0; layer < 2 && typeof value === "string"; layer++) {
    if (value.length > 262144 || !/^[\s]*[[{"]/.test(value)) break;
    try {
      value = JSON.parse(value, (_key, parsed) => {
        if (
          typeof parsed === "number" &&
          (!Number.isFinite(parsed) || (Number.isInteger(parsed) && !Number.isSafeInteger(parsed)))
        )
          throw new Error("Preserve numeric source precision");
        return parsed;
      });
    } catch {
      break;
    }
  }
  return value;
}

/** Display known output envelopes only; the caller retains the complete native record. */
export function toolOutputSections(source: unknown, label = "Output", depth = 0): Section[] {
  if (source == null) return [];
  const value = decode(source);
  if (depth < 3) {
    if (
      Array.isArray(value) &&
      value.length <= 1024 &&
      value.every((part) => object(part) && typeof part["type"] === "string")
    ) {
      return value.flatMap((part, index) => {
        const name = value.length === 1 ? label : `${label} ${index + 1}`;
        return ["text", "input_text", "inputText"].includes(part["type"] as string) &&
          typeof part["text"] === "string"
          ? toolOutputSections(part["text"], name, depth + 1)
          : [{ label: name, content: printable(part) }];
      });
    }
    if (object(value)) {
      if (Array.isArray(value["content"])) {
        const { content, structuredContent, ...metadata } = value;
        return [
          ...toolOutputSections(content, label, depth + 1),
          ...(structuredContent === undefined
            ? []
            : [{ label: "Structured result", content: printable(structuredContent) }]),
          ...(Object.keys(metadata).length
            ? [{ label: "Result metadata", content: printable(metadata) }]
            : []),
        ];
      }
      if (typeof value["output"] === "string") {
        const { output, ...metadata } = value;
        return [
          ...toolOutputSections(output, label, depth + 1),
          ...(Object.keys(metadata).length
            ? [{ label: "Result metadata", content: printable(metadata) }]
            : []),
        ];
      }
    }
  }
  return [{ label, content: printable(value) }];
}
