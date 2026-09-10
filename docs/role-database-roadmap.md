# Workspace-role follow-up roadmap

Recorded September 10, 2026. This is the implementation handoff for the unfinished
SQLite-role program, tracked in AgentBoard under **Mature AgentVoice workspace
roles** (`it-93f9997e`, tag `workspace-roles`). The board owns changing task state
and claims; this document owns the scope and acceptance intent. Record delivery
receipts and link new defects as work progresses. The umbrella stays open until
the remaining scope is delivered or explicitly changed by the operator.

## Shipped foundation

- Explicit `role eject` captures complete settings and prompts/MCP/skill assets
  into a private workspace-bound SQLite database. Bound calls and runtime
  replacements read immutable snapshots; original files are no longer live.
- Revisions and compare-and-swap protect edits. Export/import creates independent
  reusable copies with provenance, preserving authored contents.
- CLI voice save and equivalent API/MCP voice mutation support immediate
  voice-only application or saving for the next session. Saved and applied
  state are distinct; working thread/process/attachment survive voice changes.
- Schema settings have a mechanical impact classification. Only the voice-name
  change currently has a narrow apply implementation.
- Adaptive read-only/thinking delegation, useful parallelism and clear handoff
  communication are recorded in [ADR 0043](adr/0043-adaptive-conversation-first-delegation.md).
  Default prompts and the trial's revision 4 carry that policy.

The latest prompt update needed a one-off validated, compare-and-swap database
revision because the product has no general editor yet. That was an authorized
maintenance action, not a supported editing feature. **The recommended next
slice is the supported editor.**

See [current commands and limits](workspace-roles.md),
[ADR 0042](adr/0042-workspace-role-databases.md) and the
[broader design](role-database-design.md). Explicit first-slice ejection and
voice-only apply are settled; the old proposal's questions about those choices
are historical. Storage/catalog shape, migration UX and platform restart details
still need concrete designs within the corresponding slices.

## Build slices

Order below is recommended, not a requirement to serialize independent work.
Actual dependencies: general apply uses the editor; automatic ejection uses the
editor and template selection; platform lifecycle work uses the apply planner.
Maintenance and portability can be investigated in parallel. No build slice is
blocked on completing an everyday-use checklist.

### 1. Edit AgentVoice role settings and prompts through supported tools

AgentBoard: `it-64f9bd7e`.

Recommended next slice. Replace ad hoc SQL prompt updates with supported CLI and
equivalent controller-bound API/MCP read/edit operations for settings and named prompts,
extending to skills/MCP/bundled assets through the same validated transaction boundary.
Batch edits atomically with expected revision, preserve null/empty/absent values,
permissions/executable bits and unrelated bytes, validate the complete candidate without
native startup. Provide inspection, revision diff/history and explicit restore as a NEW
revision. Generated role trees are never authoring files; temporary editor buffers are
transaction inputs only. Save-only initially; return impact plan and saved-versus-loaded
state. Done when the approved two-prompt policy update can be performed through this
supported path without SQL and stale/malformed edits leave prior state intact.

### 2. Apply AgentVoice role changes with the smallest restart

AgentBoard: `it-208ef37c`.

Build on impact.ts and voice_set into a general plan/apply API/MCP contract. Mechanically
classify all schema-owned and local process settings, use conservative native-passthrough
fallback, compare desired versus per-component loaded content and explain exact required
actions. Preflight and pin a revision before teardown; preserve exact workspace/thread
leases and prevent later edits leaking into activation. Support save now/apply later,
honest saved/applied/failed/unknown outcomes, recovery without automatic mutation retries
and no repeated restart for a no-op. Keep working agent/attachment on voice-only changes.
Broader runtime changes currently revoke the attachment and close a composition; expose
this honestly until lifecycle work lands. Fake tests cover concurrency, preflight
rejection, lost replies and partial apply.

### 3. Reuse AgentVoice roles as named templates and defaults

AgentBoard: `it-ee939f19`.

Add user-owned template naming/default selection, clone and explicit promotion of a
selected workspace revision. Promotion copies authored contents to an independent
template; it never rewrites the source checkout or creates a live parent. Future ejections
use the template; existing workspaces adopt changes explicitly after a diff, preserving
independent edits and provenance. Define inventory and deliberate workspace
move/rebind/replacement with conflicts and recoverable publication; Git worktrees remain
distinct canonical workspaces. Existing export/import is implemented and should be reused,
not rebuilt. Native accounts/history stay outside. Catalog.sqlite versus direct bindings
remains an implementation decision.

### 4. Automatically eject AgentVoice workspace roles and retire live file config

AgentBoard: `it-bb071f14`.

Reach the original run-in-any-workspace model: first admission atomically creates and
binds a complete user-owned role; subsequent sessions/restarts use the bound DB. Reuse a
named template/default or explicitly captured inputs; no selected role must preserve
absence of default-role policy. Concurrent first launches select one complete winner.
Define existing file-based workspace migration, conflicting role/CLI flags and explicit
template selection before cutover; never silently overwrite edits or interpret old
one-launch flags as persisted writes. Close AgentVoice-owned live server.json/prompt
fallback paths and move machine-local preferences to appropriate owned storage, while
preserving native Codex config/auth/history ownership. Files can remain explicit
import/export/editor inputs, never an ambiguous live source. Fleet publication or
agentroles changes need a separate dependency audit.

### 5. Restart AgentVoice owning processes without losing the user

AgentBoard: `it-86b5c7c8`.

Implement platform-aware actions produced by the apply planner for runtime, server, client
and any whole-UI setting. For each supported platform, either perform an authorized
orderly restart/re-attachment or explain exactly what the user must close/reopen; no
invented universal restarter or automatic new call. Address the current
full-runtime-restart -> attachment revoked -> composition ends call behavior. Preserve
mute/hold-release, exact thread authority, lifecycle fences, pending approval behavior and
safe failure/rollback reporting. Never make observer attachment a call owner or expose
native capabilities through network transport. Device/live checks happen only with current
authorization; IRL validation can accompany normal use.

### 6. Maintain AgentVoice role databases over long-term use

AgentBoard: `it-9d241a6e`.

Add versioned transactional schema migrations with recoverable backups, integrity
diagnostics, explicit revision/asset/receipt retention and in-place compaction. Resolve
the current 4096 voice-edit receipt ceiling without weakening idempotency or accepting
expired retries; document the separate 256-operation controller limit and its lifecycle.
Clean only verifiably owned abandoned staging/materialized trees, never a live tree or
unrelated path. Test disk-full/write failure, corruption/newer schemas, interrupted
migration/compaction and concurrent export/write using disposable state; preserve atomic
publication and private paths. Existing backup/export stays a standalone copy, not copying
the main file of an open DB.

### 7. Make AgentVoice role portability and external requirements explicit

AgentBoard: `it-77694f44`.

Provide an inspectable external-dependency manifest/report for copied roles: programs,
absolute paths, environment/secret references and machine-specific resources. Preserve
bundled relative assets and executable flags; do not promise automatic rewriting of
arbitrary scripts/prose or copy native credentials. Report unresolved requirements before
apply/import activation and keep imported data inert. Verify desktop and Android
SQLite/materialization/import/export compatibility with appropriate automated fixtures;
use ordinary authorized device use for live fidelity. Keep native defaults/version
differences explicit. Multiple role slots, a role marketplace and cross-fleet format
replacement are deferred product decisions, not implicit scope.

## Learn during ordinary use

AgentBoard: `it-e5a5f34e` — **Observe AgentVoice roles and delegation during everyday use**.

The operator prefers most live validation to happen while using the product.
Keep ordinary requests ordinary; do not require tool names, internal identifiers
or repeated formal voice trials. Review recorded evidence when an interaction
is useful or fails, and make a specific defect its own bounded item. Keep
unobserved behavior marked unobserved rather than turning this preference into
a claim that everything passed.

Observe naturally as opportunities arise:

- A saved voice survives closing/reopening; a next-session choice leaves the
  current voice alone until the next call.
- A new prompt revision loads after reopening or explicit runtime replacement.
- Quick read-only work stays local when sensible, independent work overlaps,
  handoffs are announced, and attention shifts without losing prior requests.
- Voice changes and completion reports become quicker and less repetitive.
- Failed/unknown application states are explained accurately and repaired
  without silent retries or loss of saved edits.
- Real client/platform differences are recorded without claiming cross-platform
  acceptance from compilation alone.

Known evidence: the September 10 Maple and Cove operations both applied in
about 1.1 seconds while preserving the runtime/thread. Spoken completion took
roughly 36/23 seconds because of surrounding agent work and communication.
The new delegation policy was saved afterward; its live behavioral effect,
reopen persistence and deferred voice selection were not established by that
recording. The terminal capture wrapper lost resize propagation; direct launch
passed an isolated resize/click check and the live UI recovered after its PTY
size was corrected.

Meaningful automated validation remains part of implementation: transactions,
crash recovery, identity fences, schema/transport contracts and lifecycle races
cannot be reliably established by casual use alone. Use disposable state and
fake media/protocol tests. No automatic audio/inference probes, emulators,
service restart or phone access follows from this backlog; current operator
handoff and resource constraints still apply.

## Preserve boundaries and deferred decisions

The target is database ownership of all AgentVoice-authored role configuration,
including prompts; avoid a permanent database overlay on live config files.
Machine-local choices and native Codex-owned configuration/auth/history retain
separate ownership. Settings changes must identify the smallest correct process
boundary, including an explicit close/reopen instruction when automatic restart
is unsupported.

Do not implicitly expand this into multiple role slots per workspace, a template
marketplace, account/profile management, or a shared cross-fleet role format.
Those require a concrete request and, for fleet entrypoint changes, a dependency
audit. Existing Android Persona work is tracked by its owner independently;
this roadmap does not replace or reorder that queue.
