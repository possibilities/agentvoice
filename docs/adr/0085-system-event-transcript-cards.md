# 0085: Render observed system events as transcript cards

Accepted 2026-09-15. Extends the owned Transcript UI in
[0075](0075-own-web-transcript-ui.md) and preserves the measured rows and stable
identities in [0057](0057-responsive-web-transcripts.md).

## Decision

Native context compaction is a system event, not authored conversation or a tool
call. Amended 2026-09-16: the host maps its existing `contextCompaction` item to a
`system` message and copies the exact native spelling into
`Message.nativeItemType`. A small static component registry selects the card from
that source metadata; unknown types retain the ordinary activity fallback and
their readable content. This copy into the render DTO is the only necessary
projection because React does not receive the event socket's native item object.
There is no second provider-neutral event vocabulary, dynamic plugin loader, new
transport, or second transcript pipeline.

Explicit system events form independent rows in the single full transcript.
They separate adjacent tool groups, retain the host's original message ID, and
use existing measurement, reconciliation and scroll ownership. The first card
says “Compacting context” while the item is incomplete and “Context compacted”
after completion. It explains that older conversation context is summarized;
the native item supplies no summary text or token counts, so none are invented.

The card is a semantic note with a text label, readable secondary copy and one
quiet boundary. It uses the existing typography and palette, has no invented
action, animation, speech author or replay-triggered live announcement. This
applies the current Vercel design guidance and the wiki's native fleet adaptation
to AgentVoice's established reading surface.

## Source boundary

`src/events/conversation-native.ts` defines the exact native item as
`{ type: "contextCompaction", id: string }`. It appears inside `item/started`
and `item/completed` notifications with `threadId`, `turnId`, and the respective
`startedAtMs` or `completedAtMs`. The existing event adapter publishes
`conversation.item.started` / `conversation.item.completed`; native history
items use the same bounded projection. `web/server/messages.ts` uses the existing
turn/item key, exact `item.type`, and completion flag for both live and saved
observations. The retained Codex adapter uses its existing `itemType` field. No
changes to event schemas or native history are necessary.

Codex rollout JSONL has separate shapes: `type: "compacted"` is a history
checkpoint with a summary/replacement history, not the card event. Paginated
history persists `event_msg` / `item_completed` with the core item spelling
`{ type: "ContextCompaction", id }` and snake-case lifecycle fields. Legacy
history instead records `event_msg` / `context_compacted`; native projection can
assign it a synthetic item ID. These encodings must not be inferred from prose.
Compaction can fail after `item/started` without an `item/completed`; the card
does not claim completion without that observation.

The existing reader obtains saved items through `thread/turns/list` with
`itemsView: "full"` (`src/core/conversation-items.ts`), not direct JSONL reads.
For successful paginated compaction, native `project_rollout_line` materializes
the canonical completed item into the thread store, and full turn pages hydrate
those rows with the original item ID (inspected in upstream `112be0bd`, also
present in 0.153.4). The older stateful `ThreadHistoryBuilder` is a different
reconstruction path and must not be used to infer paginated history behavior.
Legacy history can use synthetic IDs. A failed compaction has no persisted
completed item; retained controller-memory observations can still survive reader
reload until eviction or controller replacement. The UI does not reconstruct
missing history or promise that a legacy synthetic ID matches the live item.

The AgentVoice voice JSONL recording is a separate `type: "event"` envelope of
`voice.item.started`, `voice.item.completed`, and transcript deltas plus recording
boundaries. Its current item schema has no compaction variant. `VoiceMessages`
projects only `transcriptSegment` items. Both panes share card rendering, but
Agent compaction is not copied into Voice and saved speech is never interpreted
as a compaction event. Native Codex rollout JSONL is not read by this web reader.

## Verification and limits

Mapping and reader fixtures cover start/completion identity, saved history,
reconnection, separation from tools, unknown native items, and the retained Codex
adapter. Headless browser checks cover both lane renderers, narrow wrapping,
stable DOM identity, unknown card fallback, windowing and scroll behavior. The
transcript has no messages-only mode or detail selector; activity remains present
for these checks and for the live app.
The Voice card fixture is deliberately synthetic renderer coverage; it does not
claim a native Voice compaction event exists. Live desktop and call verification
are separate from source delivery and build preparation.
