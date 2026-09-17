# 0090: Deliver bounded manager routing orientation

Accepted at the operator's request to ship and use quota-aware delegation.
Extends ADR 0080's named native output transport without changing direct-child
completion ownership or adding an AgentVoice worker executor.

After the controller verifies the exact root thread and runtime incarnation,
AgentVoice obtains that owned Codex connection's paginated model/list catalog,
current model/effort/tier, and read-only AgentUsage public routing evidence.
AgentUsage composes reviewed qualitative model guidance and fresh account/reset
facts. The current native manager account is explicitly uncorrelated; numeric
cross-provider economics are unavailable. The reviewed context may include
official Codex API text-token prices as a within-provider proxy and a separate
preference for eligible included-allowance Grok targets that preserves finite
Codex main quota. Exact AgentFX target support remains a dispatch-time gate; API
prices do not establish subscription consumption or a Codex-to-Grok rate.
AgentHUD stores the full evidence and context with producer generation, context
revision, digest and source CAS.

The producer also requests AgentUsage's sanitized Grok catalog projection for
the exact same routing source revision. The native output carries complete live
visibility, explicit incompatible/review-required dispositions, reviewed 4.6
and retained 4.5 task/effort guidance, and the smaller reviewed/routable set
intersected with fresh included quota. A compatible unknown model raises the
runtime drift warning but does not disable independent Codex guidance. Catalog
visibility never authorizes execution; managers intersect the routable set with
AgentFX's exact configured targets, and broker admission rechecks the pin.

Before publishing, the producer checks that every visible Grok account has a
current-credential catalog with at least 30 seconds of freshness remaining. An
incomplete, stale, errored or credential-mismatched projection triggers the
existing credential-contained `agentusage refresh grok --json` operation with a
65-second subprocess bound. The producer then rereads both routing evidence and
the catalog at one exact source revision. A failed or unknown refresh outcome
does not discard last-good state: the reread still publishes its explicit stale
or unavailable disposition and empty routable set. Fresh catalog evidence and
review-metadata drift do not trigger a provider refresh.

One coalescing producer refreshes at startup, native settings changes, and every
five minutes. Each persisted revision receives at most one named native
`agentusage.routing_context` turn/start submission. Unknown transport outcomes
are not retried. Payload handling explicitly forbids speech, status messages or
new Work caused solely by background refresh. Native submission is not proof of
manager consumption: HUD acknowledgment remains separately explicit. The root
uses installed AgentFX's bounded CLI or MCP for authorized delegation, with
existing Work/routing-decision association and exact fresh source revision.

Publication and delivery stop at runtime shutdown. The read-only HUD routing
state remains available after process replacement; a new producer generation
requires a full snapshot. Commands and catalogs are bounded, stale or ambiguous
inputs fail closed, and catalog metadata drift produces a visible runtime
warning and disables recommendations. AgentVoice does not select, switch or
read native credentials, replace exhausted native runtimes, or modify Fx.

Activation requires the existing controller/runtime restart contract. Source
installation alone does not load this behavior into an already running call.

A retained controller from before this change can activate the new runtime
without a full server restart. The runtime reuses its existing authenticated
`agentvoice_status` readiness response to recover the exact controller instance,
generation, pinned root, runtime PID and build identity. Missing or mismatched
identity fails closed; no history inventory or guessed process identity is used.
