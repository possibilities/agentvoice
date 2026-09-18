import type { RoutingContextMessage } from "../../lib/transcript";
import { useDisclosureState } from "../../transcript/disclosure-state";
import type { RoutingBalance, RoutingContextPresentation } from "../../types/message";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";

function percent(value: number) {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)}%`;
}

function resetLabel(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return undefined;
  const milliseconds = Date.parse(value) - Date.now();
  if (milliseconds <= 0) return "now";
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
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
        .map(
          (item) =>
            `${item.provider} ${item.account} ${item.lane}: ${percent(item.usedPercent)} used`,
        )
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

function groupedBalances(balances: readonly RoutingBalance[]) {
  const groups = new Map<
    string,
    { provider: RoutingBalance["provider"]; account: string; balances: RoutingBalance[] }
  >();
  for (const balance of balances) {
    const key = `${balance.provider}:${balance.account}`;
    const group = groups.get(key);
    if (group) group.balances.push(balance);
    else
      groups.set(key, {
        provider: balance.provider,
        account: balance.account,
        balances: [balance],
      });
  }
  return [...groups.values()];
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
  const groups = groupedBalances(balances);
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
      {groups.length ? (
        <dl className="routing-context-card__balances">
          {groups.map((group) => {
            return (
              <div
                className="routing-context-card__balance"
                key={`${group.provider}:${group.account}`}
              >
                <dt>
                  {group.provider} · {group.account}
                </dt>
                <dd className="routing-context-card__balance-value">
                  {group.balances.map((item) => {
                    const resets = resetLabel(item.resetsAt);
                    return (
                      <span className="routing-context-card__lane" key={item.lane}>
                        <strong className="routing-context-card__used">
                          {item.lane} · {percent(item.usedPercent)} used
                        </strong>
                        {resets ? <span> · resets in {resets}</span> : null}
                        {item.eligible === false ? <span> · unavailable</span> : null}
                      </span>
                    );
                  })}
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
      {groups.length > 0 && context.delegationAvailable === false ? (
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
                  <span className="routing-context-card__revision-label">Routing update</span>
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
