# 0055: One durable Work owner with an independent HUD

Accepted 2026-09-14 following the operator's explicit implementation and cutover
request. Extends the repository with a separate `agenthud` command and store.
It does not supersede native execution, the retained workspace session
([0053](0053-retain-workspace-session-across-frontend-detach.md)), or the native
mailbox ([0038](0038-thread-mailbox-wakeups.md)). It narrows the repository's
former blanket prohibition on result reports: declared work results now belong
to this separate Work owner; AgentVoice's execution runtime still owns no custom
worker execution, worker registry, result archive, or dispatcher.

## Supersession

[ADR 0056](0056-independent-agenthud.md) supersedes source colocation and the
initial no-resident-service delivery choice by explicit human request on 2026-09-14.
AgentHUD now owns implementation and delivery in its own project. The original
Work/native ownership semantics below remain historical rationale.

## Decision

`src/hud/` owns one local transactional SQLite store for Work, Assignment and
Result. `agenthud` CLI and MCP use that same owner. Work contains objective,
authorized scope/evidence, lead, parent/dependencies, disposition and next action.
Assignments retain bounded result contracts and exact native bindings. Results
retain return evidence, lead review history and human presentation history.
Idempotent operations and expected revisions fence changes; related changes can
commit atomically. Scope revisions prevent old accepted results from completing
a changed objective: semantic scope changes require a current-revision completed
result and review, while old receipts remain intact. Closed semantic edits require
explicit reopening; routine next-action/priority metadata does not change scope.
Actor identities are declarations within the trusted local
user boundary, not authenticated native agent identities.

Native execution remains native. Preparing an assignment records intent, native
spawn/follow-up performs execution, and binding records the exact observed
controller instance, runtime generation, root, thread and turn. The dispatch/bind
gap remains visible. A missing bind is never an automatic retry instruction.
A reused native child receives a new assignment and turn binding.

The sibling `hud/` web application projects durable records with the existing
read-only thread observer. It preserves every observed depth, retained idle
threads, unresolved assignments and unassigned native rows. Inventory gaps and
unavailable observation are explicit; a missing observation never becomes
completion. Native terminal state, returned result, lead acceptance, human
presentation, and overall disposition remain distinct.

The browser gets a read-only snapshot through a fixed loopback API. It cannot
select native endpoints, credentials, threads, or RPC methods. The HUD does not
start a voice call, acquire media, execute agents, select models, infer approvals,
or implement a scheduler. Work persists independently of the runtime and page.

## Cutover and delivery

New tracked work starts in AgentHUD. AgentStart replaces managed AgentBoard MCP
inventories and active Board/groom guidance with the HUD MCP and skill. The
operator explicitly chose no import, redirect, synchronization or dual writes.
Existing Board data and historical references remain intact. The operator explicitly
retains legacy query access for mining old records. The cutover audit found CLI
and stdio MCP access, with no Board-owned socket API/service to disable. Both
legacy entrypoints and the data remain; only managed advertisement changes. Already loaded
sessions may retain their old tool inventory until a human-managed reload;
source/resource convergence is not proof of loaded-session uptake.

`scripts/install-hud.sh --install` prepares dependencies and web assets, then
publishes only the owned editable `agenthud` command and deployment receipt from
a clean checkout. It never invokes AgentVoice's app/LaunchAgent installer.
`agenthud serve` is a foreground read-only view at the fixed local URL; no new
resident service is implied. Live AgentVoice restart remains a separate action.

## Verification

Disposable store/API/CLI fixtures verify transaction rollback, revision and retry
semantics, ownership boundaries, exact native correlations and observation gaps.
Installer fixtures verify refusal and preservation before publication. Headless
browser fixtures cover hierarchy, result milestones, stale data, responsive
layout and keyboard access. These checks do not establish live-model execution,
physical audio behavior, or current-session tool uptake.
