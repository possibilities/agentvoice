# 0099: Retire live manager routing orientation

Status: Accepted 2026-09-20 at the operator's request.

## Context

AgentVoice had become a live consumer of the fleet's AgentUsage, AgentHUD and
AgentFX routing stack. Runtime startup constructed a manager-routing producer,
sampled AgentUsage every minute, refreshed Grok catalog evidence when needed,
published routing revisions to AgentHUD and injected accepted revisions into the
native root with `turn/start`. The retained controller also exposed the last
accepted projection through `agentvoice.routing_context` and
`agentvoice_routing_context`.

The operator retired the AgentFX/Grok execution and routing integration. Native
Codex orchestration, its model and effort catalogs, service-tier selection,
roles, status/readiness, direct-child completion delivery and thread history
remain part of AgentVoice.

## Decision

Remove the live manager-routing producer and its delivery-state implementation.
AgentVoice startup and settings updates perform no AgentUsage or AgentHUD routing
subprocesses, Grok refresh or composition, HUD routing publication, routing
polling, or routing `turn/start` injection. Runtime-control activation no longer
passes a routing identity.

Remove the fresh routing-context socket method and MCP tool. Control protocol
remains version 9 because the current status, voice, redial, restart and new-session
contracts are unchanged; discovery through `tools/list` reports the smaller tool
set, and a saved caller of the retired socket method receives `unknown_method`.

Preserve historical `agentusage.routing_context` native items, their transcript
parser and routing card renderer. Existing private delivery-state files and
durable HUD routing receipts are historical data: AgentVoice neither deletes nor
rewrites them.

This decision supersedes the live behavior in [ADR 0090](0090-deliver-manager-routing-orientation.md),
[ADR 0093](0093-throttle-routing-context-turns.md) and
[ADR 0097](0097-gate-routing-updates-on-displayed-usage.md).

## Consequences

Starting or replacing an AgentVoice runtime has no routing-provider freshness or
publication dependency and cannot create a background routing turn. Historical
conversations still explain prior routing activity accurately. Any future routing
integration requires a new decision and an explicit owner; the retired state and
receipts do not authorize a restart of this producer.
