# Conversation observation (event protocol 2)

The existing `.events.sock` endpoint exposes the native orchestrator and subagent
conversations for independent, read-only UIs. This is an observation API, with no
turn submission, steering, thread resume, approval responses, or arbitrary native
RPC forwarding. Codex remains the owner of execution and persisted history.

Use `agentvoice event-socket --workspace <directory>` to discover the endpoint.
Frames use the [event protocol](events.md); [events.schema.json](../events.schema.json)
is the complete request/response/event schema. Protocol 1 clients must update;
the controller must be fully relaunched to activate protocol 2.

## Identity and thread selection

Subscribe before reading `state.get`. Its `runtime.mainThreadId` is the exact
current orchestrator, not the most recently active thread. Its loaded inventory
contains native `parentThreadId` links, including old Fresh conversations still
loaded by the same owned app-server. Build the current family by following parent
links to the selected root; missing parents remain unresolved. Thread names do
not establish ownership, and workspace equality alone does not establish ancestry.

All native history and live-snapshot requests name `expectedInstanceId`,
`expectedGeneration`, `rootThreadId`, and, except descendant listing, `threadId`.
The controller requires a root lease acquired during this launch. The runtime
verifies the root's native AgentVoice source, canonical workspace and lack of a
parent, then verifies the requested thread's parent chain with metadata-only
reads. Children may use a different cwd; their native ancestry establishes scope.
Cycles, missing links, more than 32 ancestors, unowned roots, and late replies from
replaced runtimes fail explicitly. Reads never acquire a lease or resume a thread.

Fresh changes the current root while retaining old main-thread leases. A client
may explicitly inspect such an old root until full quit. After relaunch, only
roots acquired by the new controller are available. Loaded inventory is bounded
and is not a historical directory; use descendant listing to find stored children
that have unloaded. Native descendant listing covers spawned descendants, not
every review/Guardian/fork relationship. Preserve other native references as
references instead of manufacturing parent links.

## Methods

`conversation.capabilities` accepts empty params and reports the schema baseline,
event catalog, supported public methods, history mode and principal bounds. This
describes AgentVoice's contract, not a guarantee that every configured native
version supports every read or emits every event.

| Method | Additional parameters | Result |
| --- | --- | --- |
| `conversation.thread.get` | `threadId` | Native metadata: parent, name, nickname/role, cwd, status, model/effort where reported, timestamps and ephemeral flag |
| `conversation.threads.list` | `archived?: boolean`, `limit?`, `cursor?` | Stored spawned descendants of `rootThreadId`, at any depth, excluding the root |
| `conversation.turns.list` | `threadId`, `sortDirection?`, `limit?`, `cursor?` | Turn metadata, status, error and timestamps; items have a separate read |
| `conversation.items.list` | `threadId`, `turnId?`, `sortDirection?`, `limit?`, `cursor?` | `{turnId, item}` entries with full projected native item detail |
| `conversation.live.get` | `threadId` | An exact cut of the controller's bounded live item projection for that thread |
| `conversation.replay` | `expectedInstanceId`, `expectedGeneration`, `afterSequence`, `limit?` | Conversation events after the supplied sequence, plus `throughSequence` and `hasMore`; no root/thread filter |

The first five methods also require the identity/root parameters above. Pages
default to 20 entries, maximum 50. Turns default to `desc` (newest first); items
default to `asc`, ordered by turn then item. Descendant listing is newest-created
first and defaults to unarchived; request `archived:true` separately. A page can
be empty with a non-null cursor: continue until `nextCursor:null`.

```json
{"v":2,"type":"request","id":"items","method":"conversation.items.list","params":{"expectedInstanceId":"controller-id","expectedGeneration":2,"rootThreadId":"main-id","threadId":"child-id","turnId":"turn-id","limit":20}}
```

Native read results carry `method`, `instanceId`, `generation`, `rootThreadId`,
`threadId` where applicable, `data`, `nextCursor`, `revisionBefore`,
`revisionAfter`, and `changedDuringRead`. The method discriminates the data shape.
These revisions count native conversation notifications received by this runtime,
including rejected notifications that become gaps. A changed fence establishes
overlap; an unchanged fence does **not** establish an atomic native snapshot.

Pagination tokens are opaque, held in runtime memory for five minutes and scoped
to the method, root, thread, turn filter and ordering. They cannot be transplanted
or survive runtime replacement. Reducing page size is allowed. At most 256 tokens
are retained, so clients must handle `cursor_expired` by restarting pagination.
They are not bearer credentials and never contain raw native cursors on the wire.

Stock Codex **0.153.4** declares `thread/items/list` but returns “not supported yet”.
AgentVoice implements item pages using `thread/turns/list` with `itemsView:"full"`
and one native turn per call. Large turns are split into public item pages; a
digest detects changes between pages and expires the cursor rather than silently
skipping or duplicating items. Filtering by `turnId` can therefore require empty
pages while the native turn cursor advances. The server can internally replay a
legacy rollout for a native turn read; AgentVoice does not scan or edit it.

## Typed content and streaming

Subscribe to `conversation.*` for all work content. Event names convert native
slashes to dots and camelCase to snake_case, with a `conversation.` prefix:

| Native notification | Published event |
| --- | --- |
| `item/started`, `item/completed` | `conversation.item.started`, `conversation.item.completed` |
| `item/agentMessage/delta` | `conversation.item.agent_message.delta` |
| `item/plan/delta` | `conversation.item.plan.delta` |
| `item/commandExecution/outputDelta` | `conversation.item.command_execution.output_delta` |
| `item/fileChange/outputDelta` | `conversation.item.file_change.output_delta` |
| `item/reasoning/textDelta` | `conversation.item.reasoning.text_delta` |
| `item/reasoning/summaryTextDelta`, `summaryPartAdded` | `conversation.item.reasoning.summary_text_delta`, `conversation.item.reasoning.summary_part_added` |
| `item/commandExecution/terminalInteraction` | `conversation.item.command_execution.terminal_interaction` |
| `item/mcpToolCall/progress` | `conversation.item.mcp_tool_call.progress` |
| `turn/started`, `turn/completed` | `conversation.turn.started`, `conversation.turn.completed` |
| `turn/diff/updated`, `turn/plan/updated` | `conversation.turn.diff.updated`, `conversation.turn.plan.updated` |
| `thread/tokenUsage/updated`, `thread/settings/updated` | `conversation.thread.token_usage.updated`, `conversation.thread.settings.updated` |
| `thread/reverted` | `conversation.thread.reverted` |
| `hook/started`, `hook/completed` | `conversation.hook.started`, `conversation.hook.completed` |
| `error` | `conversation.error` |

`conversation.gap` is AgentVoice's explicit loss/schema notice. Every conversation
event includes controller `instanceId`, `generation`, `sequence`, and runtime
`revision` alongside projected native fields. Retain native thread/turn/item IDs;
do not attach events to whichever tab is currently selected. IDs are scoped by
thread and turn; a lifecycle snapshot watermark does not supersede conversation
content. `event.subscribe` filters by event name, not thread; filter thread IDs in
the client after receipt. Unknown ancestry can be resolved with metadata reads.

The item union covers user and assistant messages, plans, native reasoning content,
commands, file changes, MCP/dynamic tools, collaboration calls and subagent
activity, searches, image references, sleep, hook prompts, review markers and
compaction. Preserve assistant phase, citations, tool arguments/results, command
status/exit/output, collaboration sender/receivers and native model/role fields.
Only known schema fields are projected. Unknown/malformed or oversized items use
`{type:"unavailable", id, nativeType, reason}`. No ID is invented; an invalid
identity produces an event gap or read failure instead.

Audio and inline binary media are omitted, encrypted payloads are not exposed,
and generated images expose metadata/saved paths rather than base64 results.
Opaque tool JSON is bounded; known controller capability values are scrubbed from
content before it leaves the runtime. Arbitrary text can contain user/private
information, just as in native Codex. This does not grant file or media retrieval.

Completions contain the canonical replacement item; never append their text to
the accumulated deltas. Plans can change between their delta stream and canonical
completion. Turn events carry turn metadata rather than duplicating item arrays.
`voice.item.*` promoted-work references can be resolved using the native
thread/turn/item identity in this contract; voice items remain a separate stream.

## Initial display and reconnect

1. Subscribe and buffer events. Read `state.get` for lifecycle identity/inventory.
2. Select a root and thread; call `conversation.live.get`. Replace that thread's
   live projection with the result, discard buffered **conversation** events for
   that thread at or below `throughSequence`, and apply later events in order.
   Keep voice events independent; this snapshot contains no speech.
3. Page native turn/item history to populate older content. Merge by
   `(threadId, turnId, item.id)`; the live projection wins for overlapping active
   items. Completed native items replace partial items, never concatenate with
   them. Do not use a native read's revision fence as a delta-discard watermark.
4. On a short disconnect, request `conversation.replay` from the last conversation
   sequence applied. Buffer concurrent live frames, consume replay pages, dedupe
   by `(instanceId, generation, sequence)`, then apply frames beyond
   `throughSequence`. Advance through empty pages too; other event families cause
   legitimate sequence gaps. Replay contains only `conversation.*` events.
5. On `resync_required`, a changed generation, or loss of local UI state, repeat
   the live snapshot plus history reads. On `conversation.gap`, mark affected
   partial items incomplete and recover canonical history/completions. A null
   gap thread ID affects all observed threads. On `thread.reverted`, discard
   cached history for that thread and reload it.

A live snapshot includes `items` (`item`, `turnId`, `complete`, `completed`, optional
file-output/progress), `turns`, and the latest plan, diff, usage, settings and error
`updates`, plus `throughSequence` and `revision`. `coverage` is always `partial`:
the controller only retains bounded received content. An item's `complete:true`
means a known start with no observed loss or a canonical completion, not that it
contains the entire thread or that upstream delivered every notification.

For an item already in progress when observation began, a history page alone
does not establish which following deltas are already in its text. Show it as a
partial historical item until a canonical completion or a complete live snapshot
is available; do not blindly concatenate overlapping sources. Similarly, missing
transient hook/terminal progress is not necessarily recoverable from persisted
history. The API does not promise a lossless audit trail.

## Limits and failure behavior

Conversation events are at most 64 KiB of projected data, with small framing
overhead. Replay retains at most 512 events / 8 MiB per controller's current runtime
generation; replay pages contain at most 100 events and fit below 512 KiB. The
live projection retains at most 64 threads / 8 MiB, with 128 items, 128 turns and
384 KiB per thread. Eviction is normal; coverage stays partial. Both caches clear
when the runtime becomes unavailable or is replaced, and on full quit. There is
no on-disk AgentVoice conversation store and no voice-event replay.

There are four concurrent reads, a six-second native read budget, and bounded
metadata traversal. Public history replies are at most 512 KiB. A native full
turn is limited locally to 4,096 items / 16 MiB after receipt; the native transport
has its own frame bound. Reduce `limit` on an oversized public page. An oversized
native turn cannot be made smaller by a public page limit and remains unavailable.
Content traversal is capped at 8,192 nodes and depth 32. Reads are demand-driven.

At 16 pending runtime IPC writes, conversation events drop without consuming the
control queue. The sender emits a gap when it drains, including for a trailing
drop with no subsequent native event. Missing runtime revisions also produce a
gap at the controller. A slow Unix subscriber disconnects under the shared socket
bound and uses replay/recovery. No per-subscriber backlog blocks voice media.

Stable errors include `invalid_params`, `instance_mismatch`, `stale_generation`,
`forbidden_thread`, `busy`, `cursor_expired`, `resync_required`, `oversized`,
`unsupported`, `history_unavailable`, and `unavailable`. An unmaterialized thread
(before its first user message) or ephemeral history is unavailable, not an empty
transcript. Unsupported native methods/schema shapes remain explicit failures.
No error returns raw native request bodies or private provider diagnostics.

## Verification and maintenance

Schemas were generated from stock `codex-cli 0.153.4 --experimental` API output.
To regenerate the native projection after an intentional upstream update:

```sh
codex app-server generate-json-schema --experimental --out /tmp/codex-schema
bun scripts/generate-conversation-native.ts /tmp/codex-schema
bun run format
bun run generate:events-schema
```

The native generator explicitly removes turn item arrays and generated image
bytes; runtime projection handles bounds and unavailable items. Review upstream
changes instead of assuming schema presence proves implementation support.
`bun scripts/conversation-probe.ts` verifies metadata, descendant listing and the
unmaterialized-history error with disposable state, network denial and no turns
or media. Fake-protocol/socket tests cover populated pages, nested ancestry,
content routing, projection/replay and stale generations. Local Codex source
auto-attaches initialized clients to newly created threads; that listener path is
best effort and logs native creation-channel lag rather than guaranteeing replay.
No live inference or audio fidelity is established by these tests.
