import type { MessagePresentation } from "../../types/message.ts";

// Only recognize complete canonical envelopes, never prose containing a sample,
// partial streaming XML, unknown fields, or an unknown source. Keep content intact.
const delegation =
  /^\s*<realtime_delegation>\s*(?:<source>([^<>]*)<\/source>\s*)?<input>([^<>]*)<\/input>\s*(?:<transcript_delta>([^<>]*)<\/transcript_delta>\s*)?<\/realtime_delegation>\s*$/;
const conversation = /^\s*<realtime_conversation>([^<>]*)<\/realtime_conversation>\s*$/;
const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decode(value: string) {
  // One pass: &amp;lt; represents the literal &lt;, not an opening angle bracket.
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => entities[entity]!).trim();
}

/** Optional Codex interpretation for hosts normalizing app-server message text. */
export function parseCodexMessagePresentation(content: string): MessagePresentation | undefined {
  const match = delegation.exec(content);
  if (match) {
    const source = match[1]?.trim();
    if (match[1] !== undefined && source !== "transcript_tail_flush") return undefined;
    const input = decode(match[2]!);
    const transcript = decode(match[3] ?? "");
    if (!input) return undefined;
    if (source === "transcript_tail_flush") {
      return {
        title: "Voice session ended",
        body: "The remaining voice context was added to this conversation.",
        details: [
          ...(transcript ? [{ label: "Voice context", content: transcript }] : []),
          { label: "Handoff instructions", content: input },
        ],
      };
    }
    return {
      title: "Via Voice",
      body: input,
      ...(transcript ? { details: [{ label: "Voice context", content: transcript }] } : {}),
    };
  }

  const context = conversation.exec(content);
  if (!context) return undefined;
  const instructions = context[1]!.trim();
  if (instructions.startsWith("Realtime conversation started.")) {
    return {
      title: "Voice session started",
      body: "Voice input is connected to this conversation.",
      details: [{ label: "Voice instructions", content: instructions }],
    };
  }
  if (instructions.startsWith("Realtime conversation ended.")) {
    return {
      title: "Voice session ended",
      body: "Subsequent input returns to typed messages.",
      details: [{ label: "Voice instructions", content: instructions }],
    };
  }
  return undefined;
}
