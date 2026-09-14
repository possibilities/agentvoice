import type { TranscriptMessage } from "@agentchats/transcript";
import type { LiveView } from "./types.ts";

// Snapshots contain JSON values. Compare every field so future presentation
// additions and authoritative corrections cannot be hidden by a partial key.
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
  );
}

function messages(previous: TranscriptMessage[], next: TranscriptMessage[]) {
  const byId = new Map(previous.map((message) => [message.id, message]));
  let unchanged = previous.length === next.length;
  const shared = next.map((message, index) => {
    const prior = byId.get(message.id);
    const value = prior && equal(prior, message) ? prior : message;
    if (value !== previous[index]) unchanged = false;
    return value;
  });
  return unchanged ? previous : shared;
}

/** Preserve unchanged row/lane identity across full JSON polls. */
export function reconcileView(previous: LiveView, next: LiveView): LiveView {
  if (previous.id !== next.id) return next;
  return {
    ...next,
    agent: messages(previous.agent, next.agent),
    voice: messages(previous.voice, next.voice),
    agentControls: equal(previous.agentControls, next.agentControls)
      ? previous.agentControls
      : next.agentControls,
  };
}
