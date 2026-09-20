# 0088: Render native subagent lifecycle observations as transcript cards

Status: Superseded by [ADR 0105](0105-compose-transcript-events-from-primitives.md).

Accepted 2026-09-16. Extends [0085](0085-system-event-transcript-cards.md).

## Decision

Render native `subAgentActivity` kinds `started`, `completed`, and `interrupted`
as compact, independent system cards in the full transcript. Use the exact
canonical agent path as the visible identity and keep path, native thread ID,
activity kind, and activity ID in a keyboard-accessible Details disclosure.
Retain the existing turn/item row key, shared lane renderer, measurement, and
persisted disclosure ownership. Unknown or malformed events keep readable
fallback activity; `interacted` retains the existing tool disclosure.

Amended 2026-09-16: the web reader retains each exact lifecycle item it has
observed for the current verified conversation incarnation. Native paginated
history can omit these activity items, while the controller's live projection
evicts old items after its bounded window advances. A history refresh or live
snapshot replacement therefore merges retained lifecycle items back at their
prior position relative to surviving transcript rows. An explicit thread revert
or conversation-incarnation replacement clears them. Event metadata and the
turn/item row key remain unchanged; this is reader memory, not a durable
transcript or a reconstruction from prose.

Native history can also contain the same delayed completion under the older
parent turn that initiated the child. Once the reader has shown that completion
at the live edge, a history refresh must retain its observed stream position
rather than move it backward into the initiating turn. This is especially
visible when context compaction completes and refreshes canonical history.

The labels are “Subagent started,” “Subagent turn completed,” and “Subagent
interruption requested.” These are historical observations, not current running
status. In particular, successful turn completion does not close a reusable
subagent thread, and interrupt success also includes an already missing/dead
target. Neither is proof that durable Work has completed.

The source's `item/started` and `item/completed` envelopes surround one already
observed activity and are emitted back-to-back. Both map to the same complete
card, never to an invented “starting” or “stopping” state. Separate activity IDs
remain separate rows, including repeated completed turns from one child.
Context compaction keeps its existing distinct envelope-driven presentation.

## Evidence and intentionally absent metadata

Audited stock Codex 0.153.4 (`rust-v0.153.4`, commit
`3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`):

- `codex-rs/app-server-protocol/src/protocol/v2/item.rs` defines exactly
  `{id, kind, agentThreadId, agentPath}` for the native activity item; AgentVoice
  retains it in `src/events/conversation-native.ts`.
- `core/src/tools/handlers/multi_agents_v2.rs::emit_sub_agent_activity` publishes
  both envelopes immediately. `multi_agents_v2/spawn.rs` emits `started` after
  successful spawning, while `interrupt_agent.rs` emits `interrupted` after the
  operation succeeds (including missing/dead targets).
- `core/src/session/mod.rs` emits `completed` only for `AgentStatus::Completed`,
  attributed to the initiating parent turn. The activity has no structured child
  turn ID; its generated ID string must not be parsed into a foreign key.
- V2 collaboration-tool records go through `multi_agents_v2/analytics.rs` and
  `analytics/src/client.rs`, not the public transcript. `tui/src/multi_agents.rs`
  explicitly distinguishes those analytics-only variants. Legacy public
  `collabAgentToolCall` records retain ordinary readable activity and payloads.
- `interacted` represents accepted communication and cannot distinguish a
  queue-only message from a follow-up that triggers a turn.

The activity contains no model, reasoning effort, nickname, result text,
duration, Work ID, or Assignment ID. The reader performs no current-thread
metadata join or external HUD lookup. Requested settings, a currently observed
thread configuration, and historical settings are different claims. Omitting
these fields preserves that distinction. Native worker output remains separate;
no prose, generated activity ID, name, timing, or ancestry is parsed into an
association. [0068](0068-durable-native-parentage-export.md) and
[0056](0056-independent-agenthud.md) preserve HUD's ownership of semantic Work.

## Presentation and verification

The existing monochrome system-note boundary, readable type, exact wrapping
path, and quiet Details control follow the current Vercel guidance and wiki
native fleet adaptation without introducing a second visual language. Native
identity stays available without making every transcript row an ID ledger.
There is no live announcement, replay animation, inferred navigation link,
transport change, or durable transcript store. Voice does not acquire Agent
lifecycle events.

Focused checks cover strict kind/identity mapping, all three lifecycle kinds,
unchanged transport-envelope identity, saved-history/reconnect reconciliation,
bounded live-projection eviction, repeated child turns, tool-group separation,
unknown/malformed fallbacks, both Codex adapters, and legacy collaboration
payload preservation. Headless browser checks cover real lane rendering,
keyboard disclosure, narrow long paths, unmount/remount disclosure state under
virtualization, existing compaction, and full-transcript behavior.
