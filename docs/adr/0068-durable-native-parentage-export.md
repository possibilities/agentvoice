# 0068: Export durable native parentage from persisted history

Accepted 2026-09-14 under the operator's authorization to make every observed
non-root child carry automatic native parentage across AgentVoice restarts. This
refines the versioned observation boundary in
[0056](0056-independent-agenthud.md). AgentHUD remains the separate Work and UI
owner.

## Decision

`agentvoice threads --json` version 2 combines the current controller's live
thread inventory with bounded `thread/list` descendant pages for the exact
revalidated root, including archived rows. AgentVoice reads exact thread metadata
through its existing guarded conversation reader; it does not resume a thread or
read item bodies. The root thread ID is exported as `nativeSessionId`: it remains
stable when a server restart resumes that exact saved root, while the controller
instance and runtime generation continue to describe the current observer.

Every exported row carries one native parentage state. `root` identifies the
revalidated root. `verified` carries one exact parent thread ID. `missing` and
`conflict` preserve absent or contradictory native evidence instead of guessing or
dropping the row. Sources identify live inventory, persisted native history, or
both. `historyCoverage` is `complete`, `partial` or `unavailable`; bounded output
prefers every live row and marks truncated history partial.

The live inventory's nullable parent field is an unreported value until an exact
parent ID arrives; it is not evidence that a non-root thread is parentless. A
verified parent therefore names only the sources that reported that exact ID.

Native ancestry and semantic Work association are separate relations. AgentVoice
does not create or choose Work, Assignment or Result records from thread names,
nicknames, timing or tree position. AgentHUD may project this native tree without
classifying a child as unassigned Work.

## Protocol boundary

Current native collaboration items identify the sending thread, sending turn,
sending item and receiving thread. They do not identify the exact receiving turn.
Version 2 therefore establishes durable thread parentage but does not claim an
atomic dispatch-to-receiving-turn receipt. Exact Assignment turn bindings remain
manager-authored evidence until the native protocol supplies that identifier.

## Compatibility and verification

Version 1 remains historical wire documentation; AgentHUD accepts it as legacy
live-only ancestry during rollout. Version 2 is strict and bounded to 256 rows and
1 MiB. Tests cover persisted and archived descendants, live/history conflicts,
identity fences, malformed pages, output bounds and unavailable history. No check
starts or restarts a call or service.
