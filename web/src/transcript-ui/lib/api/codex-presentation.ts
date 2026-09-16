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

/**
 * Return the canonical spoken input carried by an ordinary realtime delegation.
 *
 * This deliberately excludes transcript-tail flushes: those are lifecycle
 * handoffs, not one spoken submission that can be correlated with the saved
 * voice recording.
 */
export function realtimeDelegationInput(content: string): string | undefined {
  const match = delegation.exec(content);
  if (!match || match[1] !== undefined) return;
  const input = decode(match[2]!);
  return input || undefined;
}

type TranscriptEntry = { role: "user" | "assistant"; text: string };

function transcriptEntries(value: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of value.split("\n")) {
    const match = /^(user|assistant): ?(.*)$/.exec(line);
    if (match) entries.push({ role: match[1] as TranscriptEntry["role"], text: match[2]!.trim() });
    else if (entries.length > 0 && line.length > 0)
      entries.at(-1)!.text = `${entries.at(-1)!.text}\n${line}`.trim();
  }
  return entries;
}

function joinsPreviousFragment(input: string, previous: string, between: TranscriptEntry[]) {
  if (!/^(?:[,.;:!?)}-]|\p{Ll})/u.test(input)) return false;
  if (/[.!?]["')\]]?$/.test(previous)) return false;
  return between.length === 1 && between[0]!.role === "assistant" && between[0]!.text.length <= 80;
}

/**
 * Reconstruct the human utterance represented by a realtime delegation.
 *
 * Native realtime can delegate only a trailing input fragment after publishing
 * the earlier speech in transcript_delta. Canonical transcript finalization can
 * also repeat that trailing fragment. Prefer a complete user line that already
 * contains the input; otherwise join one interrupted, unfinished user fragment.
 * The native input remains authoritative when the transcript has no such proof.
 */
function displayedVoiceInput(input: string, transcript: string) {
  const entries = transcriptEntries(transcript);
  let anchor = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.role === "user" && (entry.text === input || entry.text.endsWith(input))) {
      anchor = index;
      break;
    }
  }
  if (anchor < 0) return input;

  const displayed = entries[anchor]!.text;
  if (displayed !== input) return displayed;

  let previous = anchor - 1;
  while (previous >= 0 && entries[previous]!.role !== "user") previous--;
  if (previous < 0) return displayed;

  const previousText = entries[previous]!.text;
  if (previous === anchor - 1 && previousText.endsWith(displayed)) return previousText;
  if (displayed.endsWith(previousText)) return displayed;
  if (!joinsPreviousFragment(input, previousText, entries.slice(previous + 1, anchor)))
    return displayed;
  return `${previousText}${/\s$/.test(previousText) || /^\p{P}/u.test(displayed) ? "" : " "}${displayed}`;
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
      body: displayedVoiceInput(input, transcript),
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
