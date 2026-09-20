# 0093: Throttle routing-context turns and expose read-only context

Status: Superseded by [ADR 0099](0099-retire-live-manager-routing-orientation.md).

[ADR 0097](0097-gate-routing-updates-on-displayed-usage.md) supersedes the immediate
non-quota triggers and one-point threshold below. One-minute sampling, the initial snapshot,
private accepted receipt, read-only query and unknown-outcome rules remain active.

## Context

The first manager-routing producer coupled its five-minute refresh with publication and a
native `turn/start`. Native catalog capture IDs, observation revisions and timestamps change
even when the manager's routing choice does not. That behavior can create repeated tool
cards and manager turns without new routing information. Restarting the disposable runtime
also lost the in-memory delivery boundary.

A manager sometimes needs current routing facts on demand. Reading the full AgentHUD ledger
directly exposes a larger internal contract than the conversation control plane should
advertise, and a delta is unusable when the caller does not already hold its exact base.

## Decision

The AgentVoice producer samples at one-minute cadence. Before publication or native
submission it projects an allowlisted decision signal and quota readings. Repeated evidence
is suppressed. A quota-only update requires an absolute change of at least one percentage
point from the last accepted delivery and at least five minutes since that delivery. Samples
during the cooldown are coalesced naturally: the next sample compares the latest values with
the unchanged accepted baseline.

Changes to model/catalog capabilities or drift, current model/effort/tier, account/provider
generation, auth, eligibility, freshness, exclusions, reset boundary, Grok catalog visibility
or routability are decision-relevant and may deliver immediately. Observation timestamps,
source revisions and capture IDs alone are not.

After native `turn/start` returns an exact in-progress turn, AgentVoice atomically stores a
private mode-0600 receipt containing only the allowlisted projection, revision/digest,
freshness, exact runtime fence and delivery time. It then records the matching AgentHUD
consumer receipt. An unknown native outcome does not advance this baseline or cooldown and
is not retried. The private receipt survives disposable-runtime and server restarts; malformed,
oversized, redirected or non-private state fails closed.

Control protocol 8 adds `agentvoice.routing_context` and MCP
`agentvoice_routing_context`. It returns the last authoritatively accepted projection with
revision, digest, freshness and exact controller/thread/build fence. It performs no refresh,
publication, consumption, model choice or work dispatch. Provider account IDs, email, labels,
plan names, source notes, credentials and broker capabilities are never projected.

Explicit queries always return a self-contained full projection. AgentHUD still decides full
versus delta for background delivery: an initial delivery, gap, producer/static change is
full; a sequential quota-only revision may be delta. Each background native submission is a
tool-output transcript card. Explicit MCP reads create the ordinary requested MCP card. An
unchanged poll creates neither.

## Consequences

Polling freshness no longer implies conversational activity. One accepted delivery is the
only event that resets the percentage baseline and cooldown. Query callers must enforce both
freshness and `matches_current_runtime`; a stored result can remain inspectable after expiry
or runtime replacement without becoming decision-grade.

Controller code and the MCP catalog require a server restart to activate. Runtime-only
replacement can load the producer implementation but cannot add the retained controller's
new tool.
