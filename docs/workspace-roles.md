# Workspace-owned roles

For remaining implementation slices, dependencies and everyday-use observations,
see the [workspace-role roadmap](role-database-roadmap.md) and its linked
AgentBoard program.


Explicitly ejected workspaces own SQLite databases containing their AgentVoice
settings and captured role files: prompts, MCP definitions, skills, scripts and
references. Later calls and runtime restarts read database revisions; editing or
deleting source files has no effect. Unejected workspaces retain file-based
launch behavior. These commands never start a call, install, or restart a process.

Directory-backed calls additionally expose `directoryRole` through
`agentvoice.status` / `agentvoice_status`: source path, loaded preflight content
digests and generation, current source digests, and staleness or a bounded error.
This is read-only inspection; it does not apply changes. Directory skills retain
their live native path, so the initial observation is not proof of later native
consumption. Ejected calls omit this field and retain immutable revision status;
their source directories never become inputs again. See
[content status](adr/0069-directory-role-content-status.md) for framing and limits.

## Capture and run

```sh
agentvoice role eject --workspace /absolute/project \
  --config /path/to/server.json --role /path/to/role
agentvoice server --workspace /absolute/project
agentvoice client --workspace /absolute/project
```

Ejection accepts existing role-setting launch flags as inputs. With no role
selected it captures settings and convention prompts without adopting default-role
policy. It refuses an existing workspace database. Source symlinks are followed
once and captured as bytes, bounded to 4096 files and 32 MiB with cycle detection.
Executable bits and empty prompts survive. The captured bundle is locally
validated before publication. Keep the source stable during capture: directory
traversal cannot atomically snapshot concurrent file edits.

For a bound workspace, role-setting launch flags (`--role`, `--voice`, models,
permissions and native startup overrides) error instead of masking database edits.
Stop passing them after ejection. `--config` is not read once a bound workspace
is selected. Workspace, executable, debug, Fast and conversation selection remain
local launch controls. Source executable selection is not captured; use `--codex`
or `CODEX_PATH` when needed. An already-bound current managed workspace is selected
before legacy config lookup; use `--workspace` to select another workspace.

Ejection does not change an existing call's loaded settings. Start another call
to activate it. An existing server carrying role-setting flags must be relaunched
without those flags. Different canonical workspaces, including Git worktrees,
have separate bindings. Moving a workspace requires export before moving and
import into the new canonical directory.

## Adopt updated directory contents

An already-bound workspace can explicitly capture a selected directory role into
a new revision:

```sh
agentvoice role status --workspace /absolute/project
agentvoice role adopt --workspace /absolute/project \
  --role /path/to/role --expected-revision 2 --prompts-only --dry-run
agentvoice role adopt --workspace /absolute/project \
  --role /path/to/role --expected-revision 2 --prompts-only
```

`--role` also accepts a role name under `$AGENTROLES_HOME`. Adoption captures every
file supplied by that directory. Each supplied path replaces the corresponding
saved path, while existing asset paths absent from the source remain byte-for-byte
intact. This preserves separately managed skills and other local additions. Asset
deletion needs a future explicit editor/remove command; omission is never deletion.
Adoption also preserves the workspace binding identity and the current saved
settings document exactly. Voice, working model, permission
selection, native startup overrides, debug choice, and every other database-owned
setting therefore remain unchanged. A directory role does not own those settings.

Use `--prompts-only` when the source directory owns guidance while another tool
materializes its MCP or skill inventory. It updates only `SYSTEM_PROMPT.md`,
`APPEND_SYSTEM_PROMPT.md`, and the seven `VOICE_*` prompt/mode controls found in
the source. Every MCP, skill, metadata, and other asset stays unchanged. The
source traversal does not visit those paths, so an unrelated broken or oversized
subtree cannot block this mode. The output names the selected `mode` so a dry-run
makes this boundary reviewable.

The expected revision is required. If another edit wins first, the command fails
with a stale-revision error and publishes nothing. `--dry-run` checks that same
initial fence, captures and merges the source, validates the complete candidate,
and reports the prospective revision, total/source/preserved asset counts, and
impact plan without mutating the database. Invalid MCP JSON, prompt conflicts, unsafe or unsupported paths and file
types, cycles, and bundle limit violations leave the prior revision current.

Capture preserves file bytes and executable bits under the existing 4096-file,
32-MiB, and depth bounds. Keep the source stable while the command runs because a
directory traversal is not an atomic filesystem snapshot. Symlink targets are
captured as content; later source changes are not followed. Existing absolute
paths, external programs, environment references, and inline secrets retain their
meaning and should be reviewed before adoption.

A role database retains at most 4,097 immutable revisions and 256 MiB of
deduplicated asset bytes. A save exceeding either bound fails without advancing
the desired revision. Export/import the selected revision into another workspace
to compact it into a fresh independent role; in-place compaction remains future
work.

Adoption is save-only and reports `applied: false`. It does not touch a running
runtime, child, frontend, or voice session. An explicit runtime restart,
`new_session`, or later server workspace session loads the new desired revision;
frontend reattachment alone does not. Older revisions remain immutable, although
general history, diff, and restore commands are not yet implemented. See
[ADR 0083](adr/0083-adopt-directory-role-revisions.md).

## Voice editing

```sh
agentvoice role status --workspace /absolute/project
agentvoice role voice --workspace /absolute/project --voice maple
agentvoice role voice --workspace /absolute/project --clear-voice
```

The CLI saves for the next full runtime restart, `new_session`, or server workspace
session. Frontend reattachment alone does not reload it. Optional `--revision N`
requires that revision still be current; otherwise it checks the revision read
by the command. A raw `voice.extra.voice`, including null, makes managed voice
editing fail instead of changing a masked value.

For an active call, read `agentvoice_voice_get` (Unix method `agentvoice.voice_get`)
with `{}` for compatible choices, current requested voice, native fallback and
saved-versus-loaded role revisions. `refresh:true` rereads the owned native child's
catalog. File-backed calls support inspection but cannot save. For a database-backed
call, use the returned instance/generation and `role.desired.revision`, then call MCP tool
`agentvoice_voice_set` (Unix method `agentvoice.voice_set`):

```json
{
  "operationId": "voice-change-1",
  "expectedInstanceId": "instance-from-status",
  "expectedGeneration": 1,
  "expectedRoleRevision": 1,
  "voice": "maple",
  "apply": "voice"
}
```

Use `role.desired.revision` from status. Null clears the managed selection to
native resolution. `apply: "next-session"` saves without reconnecting; it means
the next runtime generation or server workspace session, not media reattachment.
Named API edits validate against the owned native catalog before save: loaded protocol
for immediate application, saved role protocol for deferred application. Missing or
invalid native catalogs reject named edits without a static list fallback; clearing
remains supported. The offline CLI keeps save-only behavior with native validation
at the eventual startup. There is no configuration watcher.

For a random different voice, omit `voice` and pass
`"selection":{"kind":"random","excludeCurrent":true}` with the same fences and
apply mode. The controller excludes the known active requested voice, chooses once,
and stores the concrete `voice`, selector intent and catalog provenance in its durable
receipt. The same operation ID never rerolls, including after save succeeded but
controller journaling failed. Unknown current voice, ambiguous prior application or
no compatible alternative rejects without saving. Pending desired voice is not the
exclusion target. Choosing randomly for `next-session` excludes today's known current
voice; it does not predict a later call's voice.

`inspection.requestedVoice` identifies an explicit request only after the matching
native started notification and live client media. `selectionSource:native-resolution`
with null means Codex chose it; `defaultVoice` is merely the native fallback, not proof
of the effective voice. `unknown` also covers reconnects, detach and ambiguous apply.
The native notification does not report resolved timbre. Catalog names are declared
runtime compatibility, not account eligibility or audible verification.

The controller commits the edit and retry receipt before returning acceptance.
Immediate application requires an attached frontend and replaces only the voice session, preserving the working
child, leased thread, attachment and mute preferences. Pointer holds are released.
Renewal cannot supersede an in-progress voice change. Ordinary redial and renewal
use loaded settings, not pending database edits.

The operation's `voiceEdit.saved` identifies the revision. Its `application` is
`pending`, `applied`, `deferred`, `failed` or `unknown`. Applied means the successor
client reported live media, not that the user heard the requested timbre. A lost
worker reply leaves acceptance unknown. Failed/unknown application retains the
saved edit without automatic resubmission. Explicitly retry with a new operation
or save a correction. Failure cannot guarantee uninterrupted old-voice fallback.

Status separates `role.loaded` (full runtime snapshot), `role.desired` (latest
saved revision) / `role.desiredVoice`, and `role.voiceRevision` / `role.voice` (last confirmed managed
voice selection). A voice update never marks other pending settings loaded.
Identical operation IDs return their original results; conflicting reuse fails.
Controller/generation/revision checks prevent cross-call writes and lost edits.

Save and application/journal updates are separate commits. A journal failure
after save reports that application did not start. New calls load saved values
without adopting old journals or replaying operations. Each controller accepts
256 operations; each database currently retains 4096 voice-edit receipts and at
most 4097 total revisions, then refuses new edits. Export/import into a new
workspace compacts to a fresh identity;
in-place receipt/revision compaction is future work.

## Copy and reuse

```sh
agentvoice role export --workspace /absolute/project --output /safe/path/template.sqlite
agentvoice role import --workspace /absolute/other-project --from /safe/path/template.sqlite
```

Export reads one transactional snapshot and creates a standalone database with
that revision and its assets. It never overwrites an existing destination.
Import validates and publishes an independent copy with a new identity, source
revision provenance, and no
workspace binding or operation receipts from the source. Use export instead of
copying an open database's main file. Exported files are ordinary portable files;
retain private mode `0600` when transferring them.

Named defaults, automatic template selection, replacement/rebinding, and general
settings/prompt editors are not implemented in this first slice. Explicit
directory adoption updates supplied paths but is not a general file-by-file editor,
deletion surface, or live template link. Exported files provide reusable
templates. Other tools' directory role formats are unchanged.

## Storage and application planning

Bindings use `$XDG_DATA_HOME/agentvoice/workspaces/<workspace-sha256>/role.sqlite`
(default `~/.local/share/agentvoice/...`). Canonical workspace identity comes
from the path, not portable database contents. A future alias catalog need not
change content ownership. SQLite rollback journaling, durable commits and revision
checks protect writes. Unsafe paths and unknown/newer schemas fail closed.

Each load generates a private tree below `$XDG_CACHE_HOME/agentvoice/roles/`
(default `~/.cache/agentvoice/...`) with read-only files. Native consumers receive
these paths. Successors never mutate the live child's tree. Normal runtime
shutdown removes its tree; forced process loss can leave disposable cache data.
Generated files are not an authoring surface or a security boundary against the
same OS user. Source-file changes are never pulled back into the database.

`src/roles/impact.ts` classifies every schema-owned setting key. Unknown local
keys fail; open native config/extra objects conservatively require runtime restart.
Named realtime settings have voice impact, but only voice name currently has a
narrow application implementation. Other changes and prompt/skill/MCP asset edits
require full runtime restart. Workspace changes require a new call/server
selection. The planner explains supported actions, including web revalidation after
runtime replacement. Platform-specific full restarters are future work.

The database captures authored contents, not a whole machine. External programs,
absolute paths embedded in scripts/prompts, environment dependencies and inline
MCP configuration retain their meanings. Relative bundled assets travel with the
role. Inspect copies for external dependencies and inline secrets: existing
configured values are preserved, not silently scrubbed. Codex authentication,
native configuration/instructions/history and workspace/project memory stay
outside. Native credential stores are never discovered or copied.

Validation uses disposable databases, fake signaling and fake native children.
Android cross-compilation includes SQLite; on-device execution and audible voice
selection still require device/live validation.
