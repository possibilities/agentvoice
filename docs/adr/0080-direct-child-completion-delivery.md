# 0080: Deliver each direct-child completion immediately

Accepted 2026-09-15 at the operator's request. This supersedes
[0038](0038-thread-mailbox-wakeups.md) and the mailbox lifecycle, opening, and
guidance decisions in [0059](0059-clarify-mailbox-and-conversation-hold-guidance.md).
It does not change 0059's separate conclusion that conversational hold is prompt
policy rather than runtime state. Historical records remain intact and marked with
this replacement.

## Decision

AgentVoice observes terminal turns from verified direct native children of the
root. For each exact child/turn identity first observed in the current server
workspace session, it immediately submits one named standalone
`agentvoice.subagent_completion` tool output through native `turn/start`. A busy
root turn is steered by the same native request. Full worker text remains native
Codex delivery and is not copied into this output.

The version-1 payload has `type: "subagent.completion"`, event/controller/root
identity, one completion's thread, turn, name, agent path, waiting state, terminal
status and observation time, plus a fresh in-flight snapshot bounded to 256 child
rows. Inventory gaps remain explicit. The observer covers root direct children and
later turns on those children; native grandchildren report to their immediate
parents rather than directly to the root.

The controller retains only a bounded set of exact child/turn identities for
deduplication. That set survives frontend detach and runtime replacement within
the same workspace session. It clears on `new_session` and server shutdown. There
are no retained consumable completion entries, mailbox opening results, per-message
read receipts, external completion snapshot/replay, or agent-owned persistence.
The active runtime separately retains a bounded request digest and outcome promise
for same-`eventId` IPC idempotency, without retaining the completion payload or
surviving runtime replacement. Submission requires the selected root thread and a
live native transport, independently of general MCP readiness.

Every delivery is attempted once. Accepted native submission does not prove root
processing or full-result delivery. AgentVoice never automatically retries a
refused, unavailable, or ambiguous submission. Runtime replacement interrupts
native work and rebuilds live observation; already seen child/turn identities are
not resubmitted, and missing observations receive no recovery replay. New server
sessions likewise do not reconstruct or replay old completions from native history.

## API and ownership consequences

Remove `agentvoice.thread_mailbox_open` and
`agentvoice_thread_mailbox_open`; the retained control protocol version and other
schemas do not change. Remove mailbox event snapshot/replay and persisted or cached
opening state. Direct completion delivery is internal controller/runtime IPC and
native submission, not a public control operation.

AgentVoice still owns no worker executor, result archive, semantic Work registry,
or role guidance. AgentStart and AgentGuidance own their prompts and tool-use
instructions. The direct payload gives the root prompt-free lifecycle context while
stock Codex continues to own child creation, steering, and full response delivery.

## Verification boundary

Verification must cover strict bounds and payload identity. Observer checks should
cover direct ancestry, later child turns, gaps, terminal statuses, and the 256-row
in-flight bound. Controller/runtime checks should cover one submission per exact
turn, busy-root steering, retained dedupe across runtime replacement, reset at
`new_session`, capacity refusal, and no retry after ambiguous or failed outcomes.
These checks do not prove a model read the payload or that native full-result
delivery succeeded.
