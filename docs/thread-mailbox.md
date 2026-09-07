# Thread mailbox

During a call, each observed `turn/completed` from a verified direct child of the
orchestrator adds a completion notice and immediately submits a native
`turn/start`. The notice counts finished turns (`completed`, `failed`, or
`interrupted`), not unique threads or only successful results. Reusing a child
for another turn produces another notice. Runtime teardown and call shutdown
do not generate wake-ups.

The model receives a named standalone `agentvoice.thread_mailbox_notice` tool
output. Its JSON contains version/type, a correlation event ID, the target
call/root identity, two tallies, observation time, and the exact mailbox-opening
tool arguments. Its message reads, with appropriate singular/plural forms:

> 3 completion notices are waiting in your thread mailbox; 2 subagents are still working. Call agentvoice_thread_mailbox_open for details.

The working tally is sampled in the runtime when it sends `turn/start`.
Children waiting for native approval or user input remain in flight. Retained
idle child threads and grandchildren are excluded. An incomplete inventory is
explicitly qualified rather than presented as an exact count. The notification
has no child names, task prompts, result summaries, output, or error bodies.
No system/developer prompt is added; the new tool's description explains opening.

Codex may incorporate several notices into an active turn. Submitted notices
are snapshots and are never cancelled or coalesced. An old notice can arrive
after another opening has cleared those completions. An empty mailbox result is
valid and creates no further wake-up. Native Codex continues delivering full
child results independently, potentially after the wake notice has arrived.

## Open and clear

The MCP tool `agentvoice_thread_mailbox_open` and Unix control method
`agentvoice.thread_mailbox_open` take:

```json
{"operationId":"<notice eventId>","expectedInstanceId":"<call instanceId>"}
```

Use the exact arguments supplied by the notice. For a new opening without a
notice, read `agentvoice_status` for the instance and choose a new operation ID.
A successful opening returns completion entries with event ID, child thread/turn
IDs, native name/path where available, terminal status and observation time.
It also returns current in-flight child metadata, count and completeness.
Only the returned completion entries are removed. A completion arriving after
the atomic read cut remains pending; with no later arrivals or additional pages,
`remainingCompleted` is zero. The working count is never cleared.

Retries with the same operation ID return the same immutable result, including
its original in-flight snapshot, without consuming newly arrived notices. Use a
new ID for another opening. The operation commits before its response is sent;
a lost response is recovered by retrying that ID. This is application state
consumption, not proof of model ingestion or comprehension.

Native MCP calls are correlated using Codex's caller thread and call ID against
the observed root's `mcpToolCall` item. Ordinary child tool calls cannot consume
the root mailbox. Caller metadata is not authentication: the private Unix socket
and MCP bearer remain controller capabilities, and explicitly authorized external
control clients can open the mailbox too. Event-socket observation never clears it.

Mailbox contents and cached openings belong to the call controller and survive
runtime replacement; they are cleared on call shutdown and are not recovered by
a new call. The native child inventory is rebuilt for each runtime. Old runtime
callbacks and delayed reads cannot change a successor's mailbox inventory or
consume its entries. No old wake-up is automatically resubmitted after restart.

## Event API

Subscribe to `mailbox.*` on the existing read-only event socket. All events have
the usual call instance, runtime generation and monotonically increasing sequence.

| Event | Meaning |
| --- | --- |
| `mailbox.child.started` | Verified direct child turn started; identity metadata and time |
| `mailbox.child.completed` | Terminal child turn; completion metadata and stable event ID |
| `mailbox.changed` | Replace current mailbox state, inventory and recent wake records |
| `mailbox.opened` | One committed opening, returned event IDs, unavailable count and remaining tally |
| `mailbox.wake.changed` | Wake pending/submitting/accepted/refused/unknown/unavailable state, exact payload and recorded-item correlation |
| `mailbox.gap` | Observation or capacity limitation; do not infer missing lifecycle facts |

These are lifecycle and operation observations, not per-message read receipts.
Native conversation events/history still expose actual child answers.
The `recorded` field on a wake means native `item/completed` reported the injected
function-call output. It can arrive before the RPC reply. Acceptance means Codex
accepted start-or-steer input; neither milestone proves that the agent acted or
that audio was played. Unknown acceptance is never blindly retried.

Read without clearing:

```json
{"v":2,"type":"request","id":"snapshot","method":"mailbox.get","params":{"expectedInstanceId":"<call>"}}
{"v":2,"type":"request","id":"replay","method":"mailbox.replay","params":{"expectedInstanceId":"<call>","afterSequence":42,"limit":100}}
```

`mailbox.get` returns `{instanceId,generation,sequence,state}`. Subscribe first,
then apply the snapshot and later mailbox events beyond that sequence. Its
watermark does not supersede voice or conversation events. `mailbox.replay`
returns mailbox events plus `throughSequence` and `hasMore`; continue from
`throughSequence`. On `resync_required`, obtain a new mailbox snapshot. Mailbox
replay survives runtime generation changes within a call, unlike conversation
replay; requests are scoped to the instance, not a particular generation.
Use ordinary `state.get` to obtain the root identity and runtime availability.

## Bounds and failure behavior

Observation tracks up to 256 loaded threads and reads only native metadata;
unknown ancestry, wrong workspace, inventory failures and capacity limits cannot
authorize child work or fabricate a completion. Lifecycle facts use reserved
worker/controller IPC capacity before the lossy conversation projection. A hard
transport failure terminates that runtime visibly rather than silently dropping
automation facts. This cannot recover native notifications the app-server itself
never delivered.

The mailbox retains 256 pending completion entries. Further completions still
emit their metadata event and a wake-up, but their retained details are counted
as `unavailableCompletions` with an explicit capacity gap. An opening reports and
clears that unavailable count. Full entries remain available through native
history and any external observer that recorded the events.

Each opening returns at most 32 completion entries and approximately 12 KiB of
completion metadata. When `remainingCompleted` is nonzero, open again with a new
operation ID. Completion plus in-flight metadata is bounded to approximately
20 KiB; `inFlightTotal` and `inFlightTruncated` distinguish a shortened list from
the count. The event snapshot exposes the retained full lists. Cached openings
are bounded to 4,096 operations or 16 MiB per call; further openings fail before
consuming entries. Completion deduplication is capped at 16,384 identities per
call (4,096 lifecycle identities per tracked child per runtime); reaching the
cap reports a gap rather than forgetting IDs and re-waking on old events.

Event replay retains up to 512 mailbox frames or 4 MiB. Snapshots contain the
32 most recent wake records. Transport refusal, unknown acceptance, and these
explicit observation limits prevent an unconditional wake guarantee.
