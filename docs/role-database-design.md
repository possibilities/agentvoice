# Workspace-owned role databases

Broader proposal, September 8, 2026. The first implementation slice is recorded
in [ADR 0035](adr/0035-workspace-role-databases.md) and documented in
[workspace roles](workspace-roles.md). It uses explicit ejection, direct
workspace-hash bindings and voice-only typed editing. Catalogs, general editors
and platform restarters remain future work. Setting impacts are classified
mechanically, with conservative fallbacks until narrower apply paths are verified.

Original proposal: This describes a possible replacement
for directory-backed runtime roles; it is not an accepted ADR or implemented
behavior. Existing role, permission, workspace and restart policies still apply.

## Direction

Make each workspace's role an independently owned SQLite database. A template
initializes it once. Every new call and full runtime restart reads a coherent
revision from that database. Templates do not remain live parents. Updating a
template, source checkout or imported directory cannot change an existing role.

Store the role's authored contents in the database, including prompts and skill
assets. Generate files only where a native consumer requires paths. Generated
files are disposable projections of a revision, never an alternative authoring
surface. A role editor reads from and commits to the database.

Use the existing term **role**, extended to include its AgentVoice settings.
Distinguish a **role template**, a **workspace role**, and a **loaded revision**.
Neither the database nor its identity represents a Codex account or conversation.

## Ownership and storage

Suggested layout, honoring absolute XDG overrides and the normal home fallbacks:

```text
$XDG_DATA_HOME/agentvoice/
  catalog.sqlite              # workspace bindings, template aliases, local preferences
  roles/<role-id>.sqlite       # templates and workspace roles use the same format
$XDG_CACHE_HOME/agentvoice/
  materialized/<role-id>/<content-hash>/skills/...
$XDG_STATE_HOME/agentvoice/
  ...                         # existing runtime state, journals and transcripts
```

Authored roles belong in XDG data because they are durable user data. The catalog
maps a canonical absolute workspace to its role ID and maps template names to
template IDs. It contains no second copy of role contents. Machine-local choices
such as default workspace selection or executable locations can live there too;
portable role content must not acquire the source machine's bindings.

Initially bind one role per workspace. Keep the database schema capable of
identifying several roles, but defer workspace role slots and role switching
until there is a concrete requirement. Concurrent controllers targeting the
same canonical workspace share its saved role; their running snapshots remain
independent. A setting change targets the requesting controller, not every call.

At first call admission, resolve the existing canonical workspace, choose the
template, validate and publish a complete clone, and transactionally bind it.
Until separately changed, an unselected role means an empty role template plus
explicitly imported settings, preserving today's absence of default-role policy.
Concurrent first launches must select one winner and never overwrite it. Publish
the complete role database before committing the catalog reference; a crash may
leave an unreferenced clone, never a binding to an incomplete database. Recovery
of owned orphan staging artifacts is an explicit maintenance operation.

On subsequent calls, use the binding. A conflicting explicit template selection
must fail with an actionable message, not silently discard workspace edits.
Replacing, cloning or rebinding is an explicit operation. Moving a workspace
requires an explicit rebind; a Git worktree is a separate canonical workspace.
This proposal does not change today's default managed-workspace selection into
"use the current shell directory."

## What travels with a role

| Content | Representation |
| --- | --- |
| AgentVoice model, voice, permission and context choices | Validated settings document |
| Ordered native startup overrides and native passthrough | Structured JSON preserving types, order and omission |
| Prompt controls | Named text entries, retaining missing versus empty |
| MCP definitions | Structured definitions with explicit external dependencies |
| Skills, scripts, reference files and small bundled assets | Relative paths, bytes, executable flags and content hashes |
| Origin and edit history | Template/source provenance and immutable revisions |
| External requirements | Manifest of executables, environment/secret references and machine resources |

All prompt variants, including the delegation-mode text, remain distinct native
controls. Existing replacement/append conflicts and startup-context ownership
checks continue to apply. Storing prompts does not authorize merging them into
a new prompt layer. Preserve raw null, empty string and absent values exactly.

Use ordinary tables for metadata, revisions, prompt entries and asset references;
use validated JSON for nested native configuration. Avoid both an unvalidated
key/value bucket and a relational rewrite of Codex's entire config schema. Asset
blobs can be deduplicated by content hash inside each database. Retention and
compaction should be explicit; a template export normally includes only the
selected revision and its reachable assets.

Snapshot imported skill trees, including their references and executable bits.
Resolve source symlinks into captured content with cycle and size bounds;
unresolved external links must become declared dependencies or import errors.
Do not pretend arbitrary paths embedded in shell scripts or prose can be made
portable automatically. Preserve relative bundle paths when materializing.
Generated trees need traversal-safe paths, private parents, content validation,
atomic publication and per-revision lifetime management. Never mutate a tree
being used by a live child. Make the tree read-only as an accidental-edit guard;
this is not a security boundary against the same user.

Codex authentication, native history, inherited native/project instructions,
workspace files and project memory remain outside the role. Native configuration
still resolves omitted values. A copied role carries all its authored contents,
but cannot promise identical behavior under different native defaults, binaries
or credentials. Store secret references rather than silently copying credential
stores; report external requirements during import/export. Database storage
itself is not encryption.

## Saved and running are separate facts

Each edit produces an immutable role revision and advances a desired-revision
pointer in a short transaction. Require the expected prior revision to prevent
lost edits. A runtime loads one explicit revision and records it. Read prompts,
settings and asset references under one database snapshot; never combine fields
read before and after an edit.

Full restart keeps today's candidate-preflight boundary: prepare and validate
the selected revision before touching the old runtime, then resume the exact
leased thread. An edit arriving afterward remains pending for a later apply.
The candidate must not reread "latest" halfway through activation.

Classify application scope conservatively:

| Change | Application boundary |
| --- | --- |
| Voice name | Explicit voice-session replacement, if the proposed narrow operation is adopted |
| Prompts, skills, MCP, native startup config and other role settings | Full runtime restart initially |
| Local server/client settings | Their owning process's launch/restart boundary |

Status exposes desired revision, loaded runtime revision, loaded voice-setting
revision/value, and application outcome. A voice-only update may load one field
from a newer revision while the working agent remains on an older revision.
It must not claim the whole role is current or pull in pending prompt/MCP edits.
Track the applied field's provenance and compare component content as needed.

Database commit and process activation cannot be one atomic transaction. If save
succeeds and apply fails, retain the desired revision and report that split.
Do not automatically undo a user's edit or keep bouncing processes. A later
explicit apply or new call may try the saved value. An invalid native voice
can therefore require a corrective edit before voice works again.

Automatic media renewal uses the last explicitly applied voice settings. Ordinary
redial remains recovery using loaded settings. Full runtime restart and new calls
load the selected current database revision. This keeps file edits, direct SQL
edits and unrelated pending changes from becoming implicit live controls.

## First feature: persistent voice selection

Proposed shared API/MCP operation: `agentvoice.voice_set` /
`agentvoice_voice_set`. Example conceptual input:

```json
{
  "operationId": "voice-change-17",
  "expectedInstanceId": "current-controller",
  "expectedGeneration": 3,
  "expectedRoleRevision": 12,
  "voice": "maple",
  "apply": "voice"
}
```

`apply: "next-session"` can save without touching a live session. Define
`voice: null` as clearing the managed voice selection to native resolution;
it is an API command, not a promise to send a raw native null. Keep native voice
validation authoritative; validate only bounded nonempty names locally.

The controller selects its own bound database. The tool cannot supply a path,
different workspace, default template, SQL or arbitrary process identifier.
Existing private socket/MCP authority and controller identity checks remain.

1. Check the immutable operation identity, controller/generation and expected
   role revision; serialize with redial, restart and shutdown.
2. Build and locally validate the prospective settings, both against the saved
   revision and the currently loaded runtime/prompts if immediate apply was
   requested. Refuse a named voice update when an existing raw voice override
   would mask it. Do not report a successful change that leaves another value
   winning.
3. Atomically commit the new role revision and a small mutation receipt in the
   role database. A repeated identical request returns its receipt; conflicting
   operation-ID reuse fails. Keep live-call identity and application records out
   of reusable template exports.
4. Return durable acceptance before asynchronously replacing the voice session.
   Feed the exact committed voice choice into a dedicated runtime operation;
   retain the validated runtime target across commit and dispatch, and fail
   application if that target disappears. Do not reload unrelated fields.
5. Mark applied only when the corresponding successor media session is live.
   RPC acceptance is not audible confirmation. Preserve the Codex child, native
   thread, attachment, microphone/speaker preferences and session fences.

The role database is authoritative for whether the edit committed. The existing
call journal records the apply lifecycle, linked to that revision and receipt;
do not claim two separate stores commit atomically. A crash between save and
apply leaves saved state plus pending/unknown application, recoverable through
status. A new call loads saved settings without adopting the old call journal or
replaying its operations. Receipt retention is bounded and its retry window must
be documented; retries after controller loss fail the old-instance check.

Voice replacement is a brief reconnect, not a guaranteed seamless voice change.
Native realtime supersession can invalidate the previous session before the new
one is healthy, so failure cannot promise uninterrupted old-voice fallback.
Existing session attribution, stale-completion fences and client peer cleanup
remain load-bearing. Serializing with automatic renewal requires runtime-side
coordination too, beyond the controller's mutation queue.

## Copy, edit and template semantics

Provide application commands for inspection, editing, clone, export/import and
template promotion. An editor may use a temporary text file and `$EDITOR`, then
validate and commit the result. That file has no authority after the transaction.

Clone assigns a new role identity and preserves source provenance. Promotion
copies a selected revision to a named template; it never makes the workspace
and template share mutable state. Future ejections use the new template version;
existing workspaces change only through explicit adoption. Do not overwrite a
source checkout when promoting to the user-owned default template.

Use SQLite's consistent backup/export facilities, followed by atomic publication,
for a standalone `.sqlite` artifact. Copying only a live main database file is
not a supported export, especially with WAL. Closed exported databases are
ordinary copyable files. Prefer rollback-journal mode initially for these small,
infrequently written stores; measure before adding WAL. Use durable commits,
bounded busy waits, private directories/files and transactional schema upgrades
with recoverable backups. Refuse schemas newer than the running binary supports.

Export validates and imports authored content; it never restores controller
capabilities, local workspace bindings, active process state or receipt authority.
An imported role must pass current permission/config invariants before launching
its tools. Receiving a database does not execute it.

## Transition and implementation boundaries

Current code has useful seams:

- `src/core/launch-config.ts`: separate local launch/workspace selection from
  bound role loading. Pinned server argv must not repeatedly overwrite database
  edits after ejection.
- `src/core/config.ts`, `role.ts`, `params.ts`: retain validation and native
  mappings while changing their inputs from live files to a revision snapshot.
- `src/runtime-control/worker.ts`, `protocol.ts`, `controller.ts`: pin and report
  revisions; carry the narrow voice-setting application operation.
- `src/core/runtime.ts`, `src/console/host.ts`, `client-session.ts`: supply a
  session-specific voice snapshot and coordinate replacement/renewal.
- `src/control/contract.ts`, `types.ts`: add the shared method, status and protocol
  changes, including the exact injected MCP catalog.

The completed design replaces AgentVoice's live `server.json` and prompt-directory
configuration with database authoring. Directory roles and configuration files
may remain explicit import/export formats, never an undocumented fallback for a
bound workspace. Existing CLI role settings need a deliberate contract: use them
as first-ejection inputs, then require explicit persisted edits on an existing
binding. Do not silently turn historical one-launch flags into writes. Local
operational flags such as workspace, device and conversation selection remain
separate. Native Codex's own config continues to be native-owned.

Build the voice slice on the final role identity/revision/binding model. It can
initially support only typed voice mutation, but must not create a permanent
"database voice overlay over live role files." A bounded implementation may
first require explicit import of a complete existing role/config bundle before
enabling workspace database mode. Compatibility migration and automatic import
are separate product choices, not assumed implementation conveniences.

Changing the shared `agentroles` CLI or AgentStart's publication/link behavior
requires a separate fleet dependency audit. AgentVoice can consume database
snapshots and materialize its native inputs without immediately changing that
other CLI's directory format.

## Decisions still open

- Adopt the narrow voice-session application boundary, or use full runtime
  restart for the first feature? Recommend the narrow boundary. Today restart
  revokes the TUI, and the bare-command composition ends its call when that pane
  exits; a full restart is therefore not a smooth voice-setting control.
- Choose cutover scope after this architecture discussion: explicit import into
  a complete database-backed role first, or a coordinated replacement of all
  current role/config entry points. Do not silently migrate global configuration.

## Verification for implementation

Use disposable databases and fake protocol/media. Cover concurrent ejection,
revision conflicts, unchanged templates after workspace edits, exact empty/null
prompt round trips, captured skill dependencies, generated-tree regeneration,
consistent export during writes, source-file changes having no effect after
import, and pinned candidate revisions during concurrent edits.

For voice setting, cover durable retry identity, crash boundaries between save
and apply, hidden raw overrides, native rejection, save-only behavior, unchanged
working-agent settings and process identity, successor-session attribution,
renewal races, frontend loss, retained mute state, and identical MCP/socket
semantics. Run repository typecheck, lint and appropriate tests. Verify Bun SQLite
in the Android standalone build as well as desktop before claiming support.
Live voice quality and audible selection require a separately scoped live trial.

The original proposal made no runtime or live-state changes. See ADR 0035 for
the subsequent implementation scope. Findings come from the repository implementation and
its documented native contract; no new upstream/default or live-media probe was
performed.
