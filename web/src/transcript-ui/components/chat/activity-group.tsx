import { ChevronRightIcon } from "lucide-react";
import { memo, useMemo } from "react";
import { ChatMessage } from "@/components/chat/chat-message";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { activitySummary } from "@/lib/transcript";
import { useAnyDisclosure, useDisclosureState } from "@/transcript/disclosure-state";
import type { Message } from "@/types/message";

function activityKindLabel(name: string, count: number) {
  if (name === "Command") return count === 1 ? "command" : "commands";
  if (name === "MCP") return count === 1 ? "lookup" : "lookups";
  if (name === "Files") return count === 1 ? "change set" : "change sets";
  if (name === "Subagent") return count === 1 ? "subagent activity" : "subagent activities";
  return name.toLowerCase();
}

export const ActivityGroup = memo(function ActivityGroup({
  messages,
}: {
  messages: readonly Message[];
}) {
  const groupKeys = useMemo(() => messages.map((message) => `group:${message.id}`), [messages]);
  const childKeys = useMemo(() => messages.map((message) => `tool:${message.id}`), [messages]);
  const [open, setOpen] = useDisclosureState(groupKeys, useAnyDisclosure(childKeys));
  const { kinds, errors, running, files } = activitySummary(messages);
  if (messages.length === 1) return <ChatMessage message={messages[0]!} />;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="activity-group"
      data-error={errors > 0 || undefined}
    >
      <CollapsibleTrigger className="activity-group__trigger" data-open={open || undefined}>
        <ChevronRightIcon className="tool-disclosure__chevron" aria-hidden="true" />
        <span className="activity-group__count">{messages.length} activities</span>
        <span className="activity-group__summary">
          {kinds.map(([name, count]) => `${count} ${activityKindLabel(name, count)}`).join(" · ")}
        </span>
        {errors > 0 ? <span className="activity-group__error">{errors} failed</span> : null}
        {running > 0 ? <span className="telemetry-live">{running} running</span> : null}
        {files > 0 ? <span className="activity-group__files">{files} file changes</span> : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {open ? (
          <div className="activity-group__items">
            {messages.map((message) => (
              <ChatMessage key={message.id} message={message} />
            ))}
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
});
