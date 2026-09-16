# 0091: Export canonical collaboration task identity

Accepted 2026-09-16 under the operator's approval of Work
`agenthud-worker-task-path-identity`. This extends the bounded observation
boundary in [0056](0056-independent-agenthud.md) and the durable parentage
reconciliation in [0068](0068-durable-native-parentage-export.md).

## Decision

`thread.source.subAgent.thread_spawn.agent_path` from native `thread/read` is
the authoritative task path. AgentVoice reads it with the same exact child
thread ID used by live inventory and persisted `thread/list` history. It
normalizes only that field into a small identity evidence value; it does not
scan turn or transcript bodies and does not derive identity from names,
nicknames, roles, timing or parentage.

`agentvoice threads --json` version 3 adds `collaborationIdentity` to every row:
`root`, `verified {path}`, `missing {reason}`, or `conflict {paths}`, with the
live/history evidence sources where applicable. Canonical worker paths begin
with `/root/` and contain only Codex task-name segments. Multiple distinct paths
for one exact thread are a conflict. Malformed reported data remains an error
even when another observation has a valid path; absence can be filled by valid
evidence from the other source. The exact revalidated root is always `root`.

This reconciliation naturally retains nested paths and unloaded or archived
workers across controller restart because persisted thread metadata is the
source. A reused native thread retains its persisted identity across new turns;
turn state remains a separate mutable field. Partial history affects coverage,
not the meaning of evidence already observed. Missing, malformed and conflicting
identity stay explicit.

## Boundary and compatibility

The export remains bounded to 256 rows and 1 MiB. Task paths are capped at 4 KiB
per row and are the only newly exposed native source data. Friendly `name` and
`nickname` fields remain untouched for other consumers.

AgentHUD accepts versions 1, 2 and 3. Versions 1 and 2 become explicit legacy
identity errors in its worker tree. Deploy AgentHUD's compatible reader before
activating the version 3 AgentVoice command. AgentVoice does not persist a second
identity database; native thread history remains authoritative.

Tests cover source extraction, nested persisted workers, live/history conflicts,
malformed paths, legacy adaptation and export bounds. No test starts or restarts
a call.
