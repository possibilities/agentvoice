# 0103: Retire synthetic subagent lifecycle steering

Accepted 2026-09-20. Supersedes [0080](0080-direct-child-completion-delivery.md),
the delivery timing experiment in [0092](0092-defer-direct-child-delivery-during-human-speech.md),
and its rollback in [0094](0094-restore-immediate-direct-child-delivery.md).

## Decision

AgentVoice no longer turns observed child thread or turn lifecycle into manager
input. Remove the completion observer, controller/runtime completion IPC, delivery
dedupe state, and the `agentvoice.subagent_completion` `turn/start` submission.
Child `thread/started`, `turn/started`, `turn/completed`, status, and
`subAgentActivity` notifications remain observation only.

Stock Codex continues to own child execution and authoritative result return. In
the inspected Codex source at commit
`7498521d288b9b3b96ffba4eedf089d8d6e06a84`,
`Session::forward_child_completion_to_parent` formats the child's terminal
`AgentStatus` and submits an `InterAgentCommunication` with
`AgentCommunicationKind::Result` and `trigger_turn: false` directly to the native
parent input queue. That path carries the actual worker response. It is distinct
from both the native `subAgentActivity` history item and AgentVoice's retired
metadata-only `turn/start`.

The native queue does not promise to wake an idle parent. A parent already waiting
for activity can consume the result, and a later parent turn receives queued mail.
AgentVoice must not add a wake-up, steer, retry, or synthesized summary on top.

## Observation and presentation

Keep native thread inventory, parentage, current-turn timing, conversation history,
and exact history reads. These remain the evidence exported to AgentHUD for Work
and Assignment binding. Coding activity now derives direct-child state from the
same verified thread inventory instead of a second completion observer.

Keep `subAgentActivity` transcript cards. They render native persisted history and
remain useful read-only evidence; they are not manager input and are not orphaned by
this decision. Historical generic tool rows can still render an old
`agentvoice.subagent_completion` output. There was no source-specific completion
card or projection to remove, and native history is never rewritten.

## Verification boundary

Tests must show that a verified child's start, terminal turn, and native
`subAgentActivity` items produce no AgentVoice `turn/start` or `turn/steer`, while
the read-only conversation stream still carries native lifecycle and later manager
output. Existing guarded-gateway checks continue to prove explicit typed input and
speech reach native Codex. Thread-inventory checks continue to cover direct-child
activity without restoring any completion-delivery path.

The repository's [manager input audit](../manager-input-audit.md) records every
remaining non-human or programmatically dispatched input surface and its owner.
