import type { RoutingContextMessage } from "@/lib/transcript";
import type { RoutingContextPresentation } from "@/types/message";
import { ToolActivityMessage } from "./tool-activity-message";

function currentLabel(context: RoutingContextPresentation) {
  const parts = [
    context.current?.model,
    context.current?.effort,
    context.current?.serviceTier,
  ].filter((value): value is string => Boolean(value));
  return parts.length ? parts.join(" · ") : "Current routing state";
}

export function RoutingContextActivity({
  messages,
  context,
}: {
  messages: readonly RoutingContextMessage[];
  context: RoutingContextPresentation;
}) {
  const count = messages.length;
  return (
    <ToolActivityMessage
      message={{
        id: messages[0]?.id ?? "routing-context",
        // The rollup's creation time follows its stable first-source identity.
        createdAt: messages[0]?.createdAt,
        role: "system",
        status: "complete",
        content: "",
        nativeItemType: "agentusage.routing_context",
        toolActivity: {
          name: "Routing context",
          detail: currentLabel(context),
          meta: `${count} ${count === 1 ? "update" : "updates"}`,
          state: "complete",
          sections: [...messages].reverse().map((message) => ({
            label: `Routing update ${message.routingContext.revision}`,
            content: JSON.stringify(message.routingContext, null, 2),
          })),
        },
      }}
    />
  );
}
