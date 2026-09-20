import { ChevronRightIcon } from "lucide-react";
import { createContext, type ReactNode, useContext, useId } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { useDisclosureState } from "@/transcript/disclosure-state";
import type { Message } from "@/types/message";
import { IdentityRow, messageTime } from "./identity-row";

/** The activity group owns identity; its children retain only their disclosures. */
export const ToolActivityGroupContext = createContext(false);

export function ToolActivityMessage({
  message,
  children,
}: {
  message: Message;
  children?: ReactNode;
}) {
  const grouped = useContext(ToolActivityGroupContext);
  const timeId = useId();
  const time = grouped ? messageTime(message.createdAt) : undefined;
  const [open, setOpen] = useDisclosureState(`tool:${message.id}`);
  const activity = message.toolActivity;
  const isError = message.status === "error";
  const summary = activity?.detail || message.content;
  const sections = activity?.sections?.filter((section) => section.content.trim()) ?? [];
  const hasPayload = sections.length > 0;
  // A host may supply only a full summary (or summary + output, as agentvoice
  // does for commands). CSS ellipsis must never be its only reading surface.
  if (summary.trim() && !sections.some((section) => section.content.includes(summary))) {
    sections.unshift({ label: activity?.name ?? "Details", content: summary });
  }
  if (!hasPayload && message.content.trim() && message.content !== summary) {
    sections.push({ label: "Content", content: message.content });
  }
  const hasDetails = sections.length > 0 || Boolean(children);

  const content = (
    <MarkerContent>
      {time ? (
        <time id={timeId} dateTime={message.createdAt} hidden>
          {time}
        </time>
      ) : null}
      <CollapsibleTrigger
        aria-describedby={time ? timeId : undefined}
        title={time}
        className="tool-disclosure__trigger"
        disabled={!hasDetails}
        data-open={open || undefined}
      >
        <span className="tool-disclosure__name">
          {isError ? "Failed · " : ""}
          {activity?.name ?? "Tool"}
        </span>
        <span className="tool-disclosure__summary">{summary}</span>
        {activity?.meta ? <span className="tool-disclosure__meta">{activity.meta}</span> : null}
        {hasDetails ? <ChevronRightIcon className="tool-disclosure__chevron" /> : null}
      </CollapsibleTrigger>
      {hasDetails ? (
        <CollapsibleContent className="tool-disclosure__content">
          {sections.map((section, index) => (
            <section key={`${section.label}:${index}`} className="tool-detail">
              <h4>{section.label}</h4>
              <pre tabIndex={0} aria-label={section.label}>
                {section.content}
              </pre>
            </section>
          ))}
          {children}
        </CollapsibleContent>
      ) : null}
    </MarkerContent>
  );

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Marker
        variant="default"
        className="tool-disclosure"
        data-transcript-type="tool-call"
        data-state={activity?.state}
        data-error={isError || undefined}
      >
        {grouped ? (
          content
        ) : (
          <IdentityRow identity="tool" createdAt={message.createdAt}>
            {content}
          </IdentityRow>
        )}
      </Marker>
    </Collapsible>
  );
}
