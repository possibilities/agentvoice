import type { Message, RoutingContextPresentation } from "../types/message";

export type RoutingContextMessage = Message & { routingContext: RoutingContextPresentation };

export type TranscriptEntry =
  | { kind: "message"; id: string; message: Message }
  | {
      kind: "routing-context";
      id: string;
      messages: readonly RoutingContextMessage[];
      context: RoutingContextPresentation;
    };

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
  > = [];
  let routingContext: Extract<(typeof entries)[number], { kind: "routing-context" }> | undefined;
  let effectiveRoutingContext: RoutingContextPresentation | undefined;
  for (const message of messages) {
    if (message.nativeItemType === "subAgentActivity") continue;
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
    entries.push({ kind: "message", id: message.id, message });
    if (message.role === "user" || message.role === "assistant") routingContext = undefined;
  }
  return entries;
}
