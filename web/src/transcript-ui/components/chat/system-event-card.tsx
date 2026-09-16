import type { ComponentType } from "react";
import { useDisclosureState } from "../../transcript/disclosure-state";
import type { Message } from "../../types/message";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";

type CardProps = { message: Message };

function ContextCompactionCard({ message }: CardProps) {
  const title = message.status === "complete" ? "Context compacted" : "Compacting context";
  return (
    <aside
      className="system-event-card"
      role="note"
      aria-label={title}
      data-role="system"
      data-system-event="context-compaction"
    >
      <strong className="system-event-card__title">{title}</strong>
      <p>{message.content}</p>
    </aside>
  );
}

function SubagentLifecycleCard({ message }: CardProps) {
  const [open, setOpen] = useDisclosureState(`system:${message.id}`);
  const presentation = message.presentation;
  const title = presentation?.title ?? "Subagent activity";
  return (
    <aside
      className="system-event-card"
      role="note"
      aria-label={title}
      data-role="system"
      data-system-event="subagent-lifecycle"
    >
      <strong className="system-event-card__title">{title}</strong>
      <p>{presentation?.body ?? message.content}</p>
      {presentation?.details?.length ? (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="system-event-card__details-trigger">
            {open ? "Hide details" : "Details"}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <dl className="system-event-card__details">
              {presentation.details.map((detail) => (
                <div key={detail.label}>
                  <dt>{detail.label}</dt>
                  <dd>{detail.content}</dd>
                </div>
              ))}
            </dl>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </aside>
  );
}

// Static, local registration consumes the exact native item type; unknown events stay readable.
const cards: ReadonlyMap<string, ComponentType<CardProps>> = new Map([
  ["contextCompaction", ContextCompactionCard],
  ["subAgentActivity", SubagentLifecycleCard],
]);

export function systemEventCard(message: Message) {
  return message.role === "system" && message.nativeItemType
    ? cards.get(message.nativeItemType)
    : undefined;
}
