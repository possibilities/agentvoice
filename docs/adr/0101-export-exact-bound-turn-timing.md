# 0101: Export requested exact historical turn metadata

Status: Accepted 2026-09-20. Extends [0100](0100-export-authoritative-turn-timing.md).

The latest turn on a reused thread cannot time an Assignment bound to an older
turn. `threads --json` export v5 adds `exactTurns` and an optional
`--timing-targets <json>` argument. The input is at most 128 unique
rootThreadId/threadId/turnId triples and 64 KiB. No Work IDs, content, arbitrary
paths, sockets or credentials enter this boundary. The ordinary text command
and unqualified discovery are unchanged.

The monitor prioritizes these lookups before general descendant enrichment.
Existing `conversation.turns.list` authorization revalidates the root/workspace
and the target thread's ancestry, then reads Codex `thread/turns/list` metadata
with itemsView notLoaded. It does not resume a thread or scan local history files.
No new native method, event method or runtime protocol is required.

A sorted target set is grouped by exact thread, with at most four concurrent
readers, 50 turns per page, 20 pages per thread, 256 pages overall and a four-second
lookup scheduling budget inside the existing monitor deadline. An in-flight read
retains the existing socket request timeout; no new request begins after the
budget. Each requested identity receives one outcome: observed status and optional
native startedAt/completedAt, not_found only after coherent cursor exhaustion,
or unavailable with a bounded reason. Unsupported reads, changed revisions,
invalid pages, root mismatch and exhausted bounds never mean absence. Each page
must be internally revision-coherent; drift across pages prevents a not_found
claim. Exact records remain independent of latest thread rows and the 256-row
inventory limit. Final controller/root/generation revalidation fences the complete
export. The existing 1 MiB public output limit remains.

The exported records whitelist only identities, status and safe Unix-second
native timestamps. Duplicate identity, incompatible status/completion, reversed
timestamps or an observed record outside the monitor's root is invalid. Item
bodies, errors and observedAt estimates are excluded.

Deploy the v5-capable AgentHUD consumer before activating this CLI exporter.
HUD first observes the unqualified version and only sends targets after v5 is
seen, so it remains compatible with exporters 1–4. This implementation lives in
the CLI reader, not the running call runtime; supported command-only publication
can use the existing conversation read API without a call restart. No publication
or restart is authorized by this decision itself.

Both repositories carry the same `tests/fixtures/exact-turn-monitor-v5.json` as a
checked cross-repository contract. Paging, bounds, identity, timestamp, content
exclusion, unsupported/partial reads, older-turn matching and version negotiation
have adversarial tests. A read-only live probe recovered all six exact historical
turns previously unavailable to the tree-only Work.
