# 0100: Export authoritative current-turn timing

Status: Accepted 2026-09-20 under Work `agenthud-agent-activity-time`.

## Context

AgentVoice's lifecycle inventory exposed current turn identity and status but no
authoritative time boundary. A consumer could see that an agent was working or
had stopped, yet could not calculate elapsed time without guessing from its own
observation clock. That guess becomes wrong after reconnect, runtime replacement
or hydration of a persisted descendant.

Stock app-server `Turn` records carry optional Unix-second `startedAt` and
`completedAt` fields. They appear on `turn/started` and `turn/completed`
notifications and in bounded `thread/turns/list` history. Older and partial native
records may omit either field.

## Decision

Event protocol 3 adds optional `startedAt` and `completedAt` fields to the current
`turn` on each thread row. `agentvoice threads --json` version 4 carries the same
fields. Values come only from native `Turn` records. AgentVoice never substitutes
notification receipt time, polling time, thread creation/update time or the export's
`observedAt`.

The live observer preserves timestamps from notifications and reconciles one
newest turn per loaded thread with `thread/turns/list`, `limit: 1`, descending
order and `itemsView: "notLoaded"`. This recovers current-turn timing after a
runtime starts without loading item bodies. A failed or unsupported timing read
does not discard otherwise valid inventory metadata.

The versioned thread monitor similarly requests one latest metadata-only turn for
each persisted descendant already admitted by exact root, generation, thread and
parentage checks. Live turn identity and status win races; history may fill missing
timestamps only for the same turn. A different historical turn never replaces a
newer live turn.

## Compatibility and consequences

Timestamp fields are optional. A row or turn without native timing remains valid
and explicitly supplies no duration anchor. Terminal `completedAt` applies to
completed, interrupted and failed turns. Error text, items, observation-time
estimates and unrelated thread timestamps remain excluded.

Event clients must use protocol 3. Export consumers must accept version 4 before
that producer is activated. The export remains bounded to 256 rows and 1 MiB;
parentage, collaboration identity, workspace/root fences and existing availability
semantics are unchanged.
