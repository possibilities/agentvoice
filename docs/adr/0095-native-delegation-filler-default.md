# 0095: Preserve the native delegation-filler default

Accepted 2026-09-17.

## Decision

AgentVoice omits `delegationAckFiller` from each `thread/realtime/start` request
when neither `voice.delegation-ack-filler` nor raw
`voice.extra.delegationAckFiller` selects a value. This preserves Codex's native
service resolution on initial calls, automatic renewal, and redial.

Named `delegation-ack-filler: true` and `false` remain explicit selections. Raw
`voice.extra.delegationAckFiller` merges last and may also set `null`, restoring
native resolution after a named selection.

This does not change direct-child completion delivery, client-managed handoffs,
or any speech admission behavior.

## Rationale

The inspected installed ChatGPT desktop client omits this field on both relevant
realtime-start paths. Stock Codex resolves an omitted field at the Realtime
service boundary. AgentVoice's former request-level `false` therefore selected
a behavior that neither inspected client path requested and that did not retain
native default evolution.

## Verification

Focused parameter tests assert omission by default, explicit true/false values,
and raw precedence including null. Runtime fixture coverage verifies the same
request shape across initial call, renewal, and redial for fresh and resumed
conversations. These tests verify request assembly; they do not establish the
remote service's current filler behavior.
