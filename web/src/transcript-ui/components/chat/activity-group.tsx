import { ChevronRightIcon } from "lucide-react";
import { memo, useMemo } from "react";
import { activitySummary, type TranscriptActivityItem } from "@/lib/transcript";
import { useAnyDisclosure, useDisclosureState } from "@/transcript/disclosure-state";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { ChatMessage } from "./chat-message";
import { IdentityRow } from "./identity-row";
import { RoutingContextActivity } from "./routing-context-activity";
import { ToolActivityGroupContext } from "./tool-activity-message";

function activityKindLabel(name: string, count: number) {
  if (name === "Command") return count === 1 ? "command" : "commands";
  if (name === "MCP") return count === 1 ? "lookup" : "lookups";
  if (name === "Files") return count === 1 ? "change set" : "change sets";
  if (name === "Subagent") return count === 1 ? "subagent activity" : "subagent activities";
  return name.toLowerCase();
}

function ActivityItem({ item }: { item: TranscriptActivityItem }) {
  return item.kind === "routing-context" ? (
    <RoutingContextActivity messages={item.messages} context={item.context} />
  ) : (
    <ChatMessage message={item.message} />
  );
}

function disclosureKey(item: TranscriptActivityItem) {
  return `tool:${item.id}`;
}

export const ActivityGroup = memo(function ActivityGroup({
  items,
}: {
  items: readonly TranscriptActivityItem[];
}) {
  const groupKeys = useMemo(() => items.map((item) => `group:${item.id}`), [items]);
  const childKeys = useMemo(() => items.map(disclosureKey), [items]);
  const [open, setOpen] = useDisclosureState(groupKeys, useAnyDisclosure(childKeys));
  const { kinds, errors, running, files } = activitySummary(items);
  if (items.length === 1) return <ActivityItem item={items[0]!} />;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="activity-group"
      data-error={errors > 0 || undefined}
    >
      <IdentityRow identity="group">
        <div className="identity-row__content">
          <CollapsibleTrigger className="activity-group__trigger" data-open={open || undefined}>
            <span className="activity-group__count">{items.length} activities</span>
            <span className="activity-group__summary">
              {kinds
                .map(([name, count]) => `${count} ${activityKindLabel(name, count)}`)
                .join(" · ")}
            </span>
            {errors > 0 ? <span className="activity-group__error">{errors} failed</span> : null}
            {running > 0 ? <span className="telemetry-live">{running} running</span> : null}
            {files > 0 ? (
              <span className="activity-group__files">
                {files} file {files === 1 ? "change" : "changes"}
              </span>
            ) : null}
            <ChevronRightIcon className="tool-disclosure__chevron" aria-hidden="true" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            {open ? (
              <ToolActivityGroupContext.Provider value={true}>
                <div className="activity-group__items">
                  {items.map((item) => (
                    <ActivityItem key={item.id} item={item} />
                  ))}
                </div>
              </ToolActivityGroupContext.Provider>
            ) : null}
          </CollapsibleContent>
        </div>
      </IdentityRow>
    </Collapsible>
  );
});
