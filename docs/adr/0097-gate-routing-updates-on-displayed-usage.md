# 0097: Gate routing updates on displayed usage

Status: Superseded by [ADR 0099](0099-retire-live-manager-routing-orientation.md).

## Context

[ADR 0093](0093-throttle-routing-context-turns.md) separated one-minute sampling from
five-minute quota delivery, but it also let model, catalog, eligibility, reset and freshness
changes bypass that delivery cooldown. AgentUsage can change those fields while every quota
percentage rendered by the routing card remains the same. AgentVoice consequently persisted a
new revision and submitted a native `turn/start`, producing an unchanged transcript card.
Attempt deduplication included the same non-percentage signal, so an unknown native outcome
could also be resubmitted after unrelated evidence drift.

## Decision

Keep one-minute sampling. After the initial accepted snapshot establishes the stream, a
background update is eligible only when the displayed percentage set changes: a balance is
added or removed, or a remaining percentage changes after the card's one-decimal projection.
Evidence revisions, capture IDs, timestamps, model/catalog state, eligibility, freshness,
reset boundaries and other decision metadata never create a background turn on their own.
They remain coalesced into the next percentage-triggered snapshot and available through the
existing accepted projection until then.

Every eligible update shares one five-minute cooldown measured from the last authoritatively
accepted native turn. Samples during the cooldown compare against that unchanged accepted
baseline, so the first eligible poll emits the latest coalesced snapshot. AgentVoice publishes
to AgentHUD and invokes `turn/start` only after this gate passes. Only an exact in-progress turn
acknowledgment replaces the accepted baseline or starts a new cooldown.

The durable attempt digest contains only the displayed percentage set. An unknown native
outcome is not retried merely because unrelated routing evidence changed. Version-two delivery
state stores displayed percentages directly. Existing private version-one accepted baselines
are migrated in memory from used percentage to the matching remaining percentage projection,
preserving restart suppression without rewriting state before a later accepted delivery.

This supersedes ADR 0093's immediate non-quota delivery triggers and one-point threshold. Its
one-minute sampling, initial snapshot, private accepted receipt, read-only query and
unknown-outcome rules remain in effect.

## Consequences

Unchanged polling creates no AgentHUD publication, native `turn/start`, or transcript card.
Capability and eligibility changes may wait for the next displayed percentage change before
appearing in a background card. Explicit routing-context reads remain bounded to the last
accepted delivery and therefore keep their existing freshness and runtime-fence requirements.

Activation still requires the AgentVoice controller/runtime restart described by ADR 0093.
