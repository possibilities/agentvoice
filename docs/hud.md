# Durable Work HUD

AgentHUD keeps the objective and outstanding obligations readable when no voice
frontend or native agent is available. The `agenthud` command and MCP share one
private SQLite Work store. The sibling web HUD combines those durable records
with bounded observations from the current local AgentVoice session.

## Install and open

From a clean committed AgentVoice checkout:

```sh
scripts/install-hud.sh --install
agenthud serve
```

The view uses **https://agenthud.localhost** and the existing shared loopback
portless HTTPS proxy. The installer prepares locked dependencies and `hud/dist`,
then publishes the editable command at `~/.local/bin/agenthud` and its
`deployed-sha` receipt. It does not restart AgentVoice, install a LaunchAgent,
start a call or open a browser. A missing proxy requires its existing AgentStart
setup; the HUD does not install one automatically.

The store is `$XDG_STATE_HOME/agenthud/work.sqlite3`, falling back to
`~/.local/state/agenthud/work.sqlite3`. It is independent of AgentVoice runtime
state and preserved Board data. Work rows, assignments, immutable returned
outcomes and append-only review/presentation histories share one transaction
owner. Snapshots include the latest 100 operation events; the database retains
the complete operation history for idempotency and audit.

## Work protocol

Use `agenthud guide --json` or the MCP guide for the exact current schemas.
`--help-json` is the same discovery contract. `snapshot` reads stored Work;
`snapshot --native` also obtains current native observation.

Each mutation supplies a unique `operationId`, declared `actor`, entity `id`,
`expectedRevision`, action and data. Creation uses revision 0. The same operation
ID and identical payload returns the original response after a lost response;
a changed payload under that ID is rejected. A revision conflict requires a new
read and decision. `batch` commits related mutations together or rolls all back.
The CLI accepts JSON through `--json`, `--file PATH` or `--file -` for stdin.

Create Work with its authorized objective/scope, source references, accountable
lead and next action. Prepare an assignment with a bounded result contract before
native dispatch. After native spawn/follow-up, inspect its exact identity and bind
the assignment to controller instance, generation, root, thread and turn IDs.
A reused child needs a new assignment. The gap between dispatch and binding is
not atomic; missing binding is visible, and never authorizes a blind retry.
When evidence proves no dispatch occurred or dispatch failed before native
acceptance, an explicit `dispatchResolution` with a failed/interrupted result
settles that assignment without inventing a binding. Unknown acceptance cannot
use this resolution.

Record a returned outcome with artifact/source/native evidence. Review and human
presentation are later explicit writes. Acceptance requires the responsible
owner to check the evidence; presentation needs evidence of actual delivery.
Presented results retain their history unchanged; further findings use a new
result. Reopen closed Work before adding obligations or changing reviews.
Changing a closed objective or authorized scope requires explicit reopening.
A scope revision advances when the objective, scope, authority, lead, containment
or dependencies change. Each returned result records that revision; completion
requires an accepted completed result for the current scope revision. Historical
receipts remain visible, while routine priority, next-action and attention-reference
updates do not invalidate them.
Overall completion is another explicit Work disposition change and checks its
outstanding obligations. A completed native turn alone establishes none of these
durable milestones. Genuine human dependencies reference the existing Attention
owner, which remains authoritative for the answer or resource grant.

This is one trusted local OS-user domain. Actor identities are declarations with
owner checks, not native authentication or a multiuser access-control system.
Tools do not execute agents, supply approval, choose models, or schedule work.
The browser cannot mutate the store or choose a native controller/endpoint.
Read-only native discovery supports current and compatible loaded control
protocols 5/6 without restarting a call; ambiguous matches are refused. Native
mutation discovery retains its current-protocol requirement.

## Reading the HUD

Durable Work and native execution appear separately. Work carries its lead,
next action, assignments, returned results, acceptance and presentation. Native
rows retain the observed all-depth hierarchy, coordinator, retained idle threads
and unassigned threads. Native model/effort values are shown only when observed.

An assignment is current only when its complete native binding matches the
observation. A different turn on a reused thread cannot satisfy it. Missing,
pending or incomplete inventory is explicit; working counts in an incomplete
inventory are lower bounds. Unavailable native observation leaves durable records
readable and never implies that work or agents stopped. Failed browser refreshes
mark the retained view stale instead of presenting old activity as fresh.

`GET /api/hud` is read-only, same-origin and loopback-only, with no query selectors.
Native socket paths and capabilities remain in the local process. Serving or
closing the page does not change the native runtime or media lifecycle.

## Cutover

AgentStart's managed MCP inventory and roles advertise `agenthud mcp` and the
HUD skill. New tracked work starts here. Board data and history remain available
through the legacy CLI and stdio MCP for mining old items. Board currently owns
no socket API/service; existing legacy access is preserved. No import, redirect, migration, dual write
or automatic reconciliation happens. Current-session MCP/guidance can remain
loaded from before resource convergence until a human-managed session reload.
Successful installation is not evidence that a running call loaded new tools.

## Development

```sh
bun install --frozen-lockfile
npm --prefix hud ci
bun run hud:check
bun run hud:build
bun run hud:test
bun run typecheck
bun run lint
bun run test
```

Store, CLI, MCP, API and installer tests use disposable state and synthetic native
evidence. Browser tests run headlessly with fixtures and write ignored screenshots
under `hud/test-results`. No check starts inference, media, a VM, or the live
AgentVoice service. The architecture is recorded in
[ADR 0055](adr/0055-durable-work-hud.md).
