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

// Static, local registration keeps native decoding outside React and unknown events readable.
const cards: ReadonlyMap<string, ComponentType<CardProps>> = new Map([
  ["context-compaction", ContextCompactionCard],
]);

export function systemEventCard(message: Message) {
  return message.role === "system" && message.systemEvent
    ? cards.get(message.systemEvent.type)
    : undefined;
}
