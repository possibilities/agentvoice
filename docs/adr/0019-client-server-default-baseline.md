# 0019: Compare defaults against the Codex client and server together

2026-09-06. Clarifies the vanilla baseline and supersedes [ADR 0012](0012-vanilla-voice-reconnects.md)'s statement
that AgentVoice targets the app-server rather than desktop parity. Documentation
decision only; runtime behavior and individual policy decisions are unchanged.

## Decision

AgentVoice's vanilla experience should follow Codex's client-and-server
experience, including the voice frontend and working agent. AgentVoice binds to
an unmodified server but implements its own client. Matching Codex can therefore
require explicitly sending values selected by Codex's client. Request omission
is not the definition of vanilla behavior.

For each default, distinguish the relevant client's selection, the server's
fallback, and an intentional AgentVoice departure. Investigate both layers and
state the inspected versions, call path and configuration or rollout limits.
Departures need an explicit product decision or operator customization. This
does not authorize copying every desktop mechanism, assuming feature gates are
enabled, reviving retired behavior or changing existing policy without review.

## Evidence and consequence

Codex desktop 26.831.20005 build 7524 (bundled CLI 0.152.0) explicitly selects
realtime v3 on its client-owned-call path. The alternative path can receive its
version from remote configuration. Stock app-server 0.153.4 selects v1 when a
WebRTC request omits version. Both facts hold: the server's fallback does not
make the desktop's explicit v3 selection non-vanilla.

The [default comparison audit](../field-guide.md#default-comparison-audit)
records the source paths and conditional behavior. Apply this distinction when
explaining and reviewing all defaults, not only protocol selection. The current
ordered review still determines individual runtime changes; this clarification
does not silently reverse or implement an earlier ruling.
