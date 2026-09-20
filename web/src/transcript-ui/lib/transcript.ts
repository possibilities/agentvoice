import type { Message, RoutingContextPresentation } from "../types/message";

export type RoutingContextMessage = Message & { routingContext: RoutingContextPresentation };

export type TranscriptActivityItem =
  | { kind: "message"; id: string; message: Message }
  | {
      kind: "routing-context";
      id: string;
      messages: readonly RoutingContextMessage[];
      context: RoutingContextPresentation;
    };

export type TranscriptEntry =
  | TranscriptActivityItem
  | { kind: "activity"; id: string; items: readonly TranscriptActivityItem[] };

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
  const items: Array<
    | { kind: "message"; id: string; message: Message }
    | {
        kind: "routing-context";
        id: string;
        messages: RoutingContextMessage[];
        context: RoutingContextPresentation;
      }
  > = [];
  let routingContext: Extract<(typeof items)[number], { kind: "routing-context" }> | undefined;
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
        items.push(routingContext);
      }
      continue;
    }
    items.push({ kind: "message", id: message.id, message });
    if (message.role === "user" || message.role === "assistant") routingContext = undefined;
  }

  const entries: Array<
    TranscriptActivityItem | { kind: "activity"; id: string; items: TranscriptActivityItem[] }
  > = [];
  for (const item of items) {
    const message = item.kind === "message" ? item.message : undefined;
    // The historical activity boundary grouped ordinary tool evidence, file
    // changes, and routing rollups. Explicit system events kept their own row.
    const groupable =
      item.kind === "routing-context" ||
      message?.role === "tool" ||
      (message?.role === "system" && message.nativeItemType === undefined);
    if (!groupable) {
      entries.push(item);
      continue;
    }
    const previous = entries.at(-1);
    if (previous?.kind === "activity") previous.items.push(item);
    else entries.push({ kind: "activity", id: item.id, items: [item] });
  }
  return entries;
}

export function activitySummary(items: readonly TranscriptActivityItem[]) {
  const kinds = new Map<string, number>();
  let errors = 0;
  let running = 0;
  let files = 0;
  for (const item of items) {
    if (item.kind === "routing-context") {
      kinds.set("Routing context", (kinds.get("Routing context") ?? 0) + 1);
      continue;
    }
    const { message } = item;
    const name = message.fileChanges ? "Files" : (message.toolActivity?.name ?? "Activity");
    kinds.set(name, (kinds.get(name) ?? 0) + 1);
    if (message.status === "error" || message.toolActivity?.state === "error") errors++;
    if (message.toolActivity?.state === "running" || message.status === "working") running++;
    files += message.fileChanges?.length ?? 0;
  }
  return { kinds: [...kinds], errors, running, files };
}
