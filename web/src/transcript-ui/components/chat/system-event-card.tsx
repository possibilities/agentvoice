import type { ComponentType } from "react";
import type { Message } from "../../types/message";

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

// Static, local registration consumes the exact native item type; unknown events stay readable.
const cards: ReadonlyMap<string, ComponentType<CardProps>> = new Map([
  ["contextCompaction", ContextCompactionCard],
]);

export function systemEventCard(message: Message) {
  return message.role === "system" && message.nativeItemType
    ? cards.get(message.nativeItemType)
    : undefined;
}
