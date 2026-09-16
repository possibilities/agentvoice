# Direct child completion delivery

During one server workspace session, AgentVoice observes native lifecycle events for
the root thread's verified direct children. The first time it observes a terminal
turn, it immediately submits one standalone `agentvoice.subagent_completion` tool
output to the root with native `turn/start`. If the root already has an active turn,
stock Codex steers that turn. Native Codex delivers the child's full response
separately; AgentVoice sends only bounded lifecycle metadata.

Grandchildren are outside the root observer's scope. Each native parent receives
its own children's normal native results, so a root completion output never claims
that a grandchild reported directly to the root. Later turns on an existing direct
child are independent completions.

## Payload

The standalone output has `type: "subagent.completion"` and contains:

- `eventId`, `instanceId`, and `rootThreadId` for the observed event and current
  controller identity;
- one `completion` with `threadId`, `turnId`, nullable `name` and `agentPath`,
  current `waitingOn`, terminal `status` (`completed`, `failed`, or `interrupted`),
  and `observedAt`;
- `inFlight`, a fresh snapshot with `revision`, `observedAt`, `complete`, and at
  most 256 current child rows using the same identity and waiting fields.

Strings and arrays are schema bounded. An incomplete inventory sets
`inFlight.complete` false rather than presenting partial observation as complete.
The payload contains no worker response text, prompt, credentials, or arbitrary
native item content.

## Delivery and lifetime

The workspace-session controller records the exact `(threadId, turnId)` before it
submits the output. That dedupe identity survives frontend detach and runtime
replacement, preventing a completion already seen from being submitted again after
a new runtime observes the same native history. The controller retains at most
16,384 identities and refuses later deliveries at capacity instead of evicting old
identities and risking duplicates.

Within the active runtime, a bounded request digest and outcome promise make an
IPC retry with the same `eventId` return the same outcome without resubmitting.
That runtime-local fence retains no completion payload and does not survive runtime
replacement. Delivery requires the selected root thread and a live native transport;
it does not wait for general MCP readiness.

There is no completion mailbox, consumable entry, opening operation,
opening-result cache, snapshot/replay API, or persistent completion store. `new_session` and server
shutdown clear the controller's dedupe identities. A newly started server therefore
does not replay prior completions from native history. Runtime replacement aborts
native work, rebuilds current observation, and provides no recovery replay.

Each event is submitted once. `accepted` means native Codex accepted the
`turn/start`; it does not mean the root processed the metadata or that the full
worker response was delivered. Refused, unavailable, and ambiguous outcomes are
reported locally and are never retried automatically. Observation or inventory
gaps stay explicit and cannot fabricate a completion.

See [ADR 0080](adr/0080-direct-child-completion-delivery.md) for the replacement
decision. [ADR 0038](adr/0038-thread-mailbox-wakeups.md) and the mailbox portion of
[ADR 0059](adr/0059-clarify-mailbox-and-conversation-hold-guidance.md) are retained
only as historical records.
