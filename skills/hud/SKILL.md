---
name: hud
description: Record and inspect durable work, bounded assignments, returned results, lead acceptance, and human presentation with agenthud. Use for work that needs tracking across agents or sessions and for HUD status or recovery.
---

# Durable work and HUD

AgentHUD owns the durable Work record. Use its directly connected MCP tools;
`guide` gives the current contract and `snapshot` combines stored facts with
native observation. The CLI provides the same owner through `agenthud`.

Record the objective, authorized scope/evidence, accountable lead and next action
when work needs tracking. Parent work and dependencies describe the work, not the
native agent tree. Tiny conversational answers need no work record. Existing
legacy Board data and its CLI/stdio MCP access are preserved for mining old records;
new work goes here, with no dual writes.

Prepare a bounded assignment before native dispatch. Spawn or follow up through
the harness, then bind the assignment using the exact observed controller
instance, generation, root, native thread and turn IDs with evidence. A reused
child gets a new assignment. Missing binding means dispatch outcome is unresolved:
inspect native evidence before any retry; never infer permission to spawn again.
Do not invent IDs from a task name, a retained idle thread, or an older turn.
If evidence proves no dispatch occurred or dispatch failed before acceptance,
record the explicit no-execution resolution with its evidence. Unknown native
acceptance remains unresolved.

A worker records its returned result and evidence. The issuing parent or work
lead records acceptance after checking that evidence. Record presentation only
when the result was actually delivered to the human, with delivery evidence.
Returning, accepting, presenting and completing work are separate facts. Keep
partial results and requested changes visible. Reopen closed Work explicitly
before changing its objective or scope; a changed scope needs a fresh completed
result and acceptance at its new scope revision. Quiet or unavailable native
observation never completes an objective.

Use a unique operation ID for each intended mutation and its expected entity
revision. Retry an ambiguous response with the identical operation and ID;
a changed payload needs a new ID. Revision conflict calls for rereading before
revising the action. Use an atomic batch for dependent durable changes.
Actor identities are local-user declarations, not authenticated native identities;
retain authority/source references and do not impersonate another owner.

The HUD is a read-only projection. Counts cover the observed hierarchy at all
depths and distinguish working, waiting and idle threads. Incomplete inventory
is a lower bound. Unavailable observation leaves durable work readable and does
not prove native agents stopped. Exact association requires the whole native
identity, including the turn. An unassigned observed thread is not lost work or
an automatic new assignment.

Reference the existing Attention/notification owner when an actual human answer
or resource lease is required; Work stores the reference, not invented approval.
HUD never executes agents, selects models, restarts a runtime, schedules work,
or grants permission. Its records do not expand the user's authorized scope.
