import type { Message, RoutingContextPresentation } from "../types/message";
import { isSystemEventMessage } from "./system-events";

export type RoutingContextMessage = Message & { routingContext: RoutingContextPresentation };

export type TranscriptEntry =
  | { kind: "message"; id: string; message: Message }
  | {
      kind: "routing-context";
      id: string;
      messages: readonly RoutingContextMessage[];
      context: RoutingContextPresentation;
    }
  | { kind: "activity"; id: string; messages: readonly Message[] };

export function isRoutingContextMessage(message: Message): message is RoutingContextMessage {
  return (
    message.role === "system" &&
    message.nativeItemType === "agentusage.routing_context" &&
    message.routingContext !== undefined
  );
}

function applyRoutingContext(
  effective: RoutingContextPresentation | undefined,
  next: RoutingContextPresentation,
): RoutingContextPresentation {
  return {
    ...effective,
    ...next,
    current: next.current ? { ...effective?.current, ...next.current } : effective?.current,
    balances: next.balances ?? effective?.balances,
  };
}

// Authored prose ends a routing rollup. The first id stays stable when live
// refreshes append, preserving disclosure state during polling and reloads.
export function groupTranscript(messages: readonly Message[]): TranscriptEntry[] {
  const entries: Array<
    | { kind: "message"; id: string; message: Message }
    | {
        kind: "routing-context";
        id: string;
        messages: RoutingContextMessage[];
        context: RoutingContextPresentation;
      }
    | { kind: "activity"; id: string; messages: Message[] }
  > = [];
  let routingContext: Extract<(typeof entries)[number], { kind: "routing-context" }> | undefined;
  let effectiveRoutingContext: RoutingContextPresentation | undefined;
  for (const message of messages) {
    if (isRoutingContextMessage(message)) {
      effectiveRoutingContext = applyRoutingContext(
        effectiveRoutingContext,
        message.routingContext,
      );
      if (routingContext) {
        routingContext.messages.push(message);
        routingContext.context = effectiveRoutingContext;
      } else {
        routingContext = {
          kind: "routing-context",
          id: message.id,
          messages: [message],
          context: effectiveRoutingContext,
        };
        entries.push(routingContext);
      }
      continue;
    }
    if (
      message.role === "user" ||
      message.role === "assistant" ||
      isSystemEventMessage(message) ||
      message.fileChanges !== undefined ||
      message.nativeItemType === "fileChange"
    ) {
      entries.push({ kind: "message", id: message.id, message });
      if (message.role === "user" || message.role === "assistant") routingContext = undefined;
      continue;
    }
    const previous = entries.at(-1);
    if (previous?.kind === "activity") {
      previous.messages.push(message);
    } else {
      entries.push({ kind: "activity", id: message.id, messages: [message] });
    }
  }
  return entries;
}

export function activitySummary(messages: readonly Message[]) {
  const kinds = new Map<string, number>();
  let errors = 0;
  let running = 0;
  let files = 0;
  for (const message of messages) {
    const name = message.toolActivity?.name ?? "Activity";
    kinds.set(name, (kinds.get(name) ?? 0) + 1);
    if (message.status === "error" || message.toolActivity?.state === "error") errors++;
    if (message.toolActivity?.state === "running" || message.status === "working") running++;
    files += message.fileChanges?.length ?? 0;
  }
  return { kinds: [...kinds], errors, running, files };
}
