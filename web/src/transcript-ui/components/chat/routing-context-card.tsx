import type { RoutingContextMessage } from "../../lib/transcript";
import { useDisclosureState } from "../../transcript/disclosure-state";
import type { RoutingContextPresentation } from "../../types/message";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";

function percent(value: number) {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)}%`;
}

function resetLabel(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function currentLabel(context: RoutingContextPresentation) {
  const parts = [
    context.current?.model,
    context.current?.effort,
    context.current?.serviceTier,
  ].filter((value): value is string => Boolean(value));
  return parts.length ? parts.join(" · ") : "Current routing state";
}

function revisionSummary(context: RoutingContextPresentation) {
  const balances = context.balances ?? [];
  const balanceText = balances.length
    ? balances
        .map((item) => `${item.provider} ${item.lane}: ${percent(item.remainingPercent)} remaining`)
        .join("; ")
    : undefined;
  const observed = resetLabel(context.observedAt);
  const expires = resetLabel(context.expiresAt);
  const freshness = [
    observed ? `Observed ${observed}` : undefined,
    expires ? `expires ${expires}` : undefined,
  ]
    .filter(Boolean)
    .join("; ");
  return [currentLabel(context), balanceText, freshness].filter(Boolean).join(" — ");
}

export function RoutingContextCard({
  messages,
  context,
}: {
  messages: readonly RoutingContextMessage[];
  context: RoutingContextPresentation;
}) {
  const [open, setOpen] = useDisclosureState(`routing:${messages[0]?.id ?? "unknown"}`);
  const balances = context.balances ?? [];
  return (
    <aside
      className="system-event-card routing-context-card"
      role="note"
      aria-label="Routing context"
      data-role="system"
      data-system-event="routing-context"
    >
      <strong className="system-event-card__title">Routing context</strong>
      <p>{currentLabel(context)}</p>
      {balances.length ? (
        <dl className="routing-context-card__balances">
          {balances.map((item, index) => {
            const resets = resetLabel(item.resetsAt);
            return (
              <div
                className="routing-context-card__balance"
                key={`${item.provider}:${item.lane}:${index}`}
              >
                <dt>
                  {item.provider} {item.lane}
                </dt>
                <dd className="routing-context-card__balance-value">
                  <strong className="routing-context-card__remaining">
                    {percent(item.remainingPercent)} remaining
                  </strong>
                  {resets ? <span>Resets {resets}</span> : null}
                  {item.eligible === false ? <span>Unavailable</span> : null}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : context.delegationAvailable !== undefined ? (
        <p>
          {context.delegationAvailable ? "Delegation available" : "No eligible delegated account"}
        </p>
      ) : null}
      {balances.length > 0 && context.delegationAvailable === false ? (
        <p>No eligible delegated account</p>
      ) : null}
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="system-event-card__details-trigger">
          {open
            ? "Hide updates"
            : `${messages.length} ${messages.length === 1 ? "update" : "updates"}`}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ol className="routing-context-card__history">
            {[...messages].reverse().map((message) => {
              const revision = message.routingContext;
              return (
                <li className="routing-context-card__revision" key={message.id}>
                  <span className="routing-context-card__revision-label">
                    Generation {revision.generation}, revision {revision.revision} · {revision.mode}
                  </span>
                  <p>{revisionSummary(revision)}</p>
                </li>
              );
            })}
          </ol>
        </CollapsibleContent>
      </Collapsible>
    </aside>
  );
}
