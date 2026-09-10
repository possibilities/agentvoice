# Workspace-owned roles

Explicitly ejected workspaces own SQLite databases containing their AgentVoice
settings and captured role files: prompts, MCP definitions, skills, scripts and
references. Later calls and runtime restarts read database revisions; editing or
deleting source files has no effect. Unejected workspaces retain file-based
launch behavior. These commands never start a call, install, or restart a process.

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

## Voice editing

```sh
agentvoice role status --workspace /absolute/project
agentvoice role voice --workspace /absolute/project --voice maple
agentvoice role voice --workspace /absolute/project --clear-voice
```

The CLI saves for the next call or full runtime restart. Optional `--revision N`
requires that revision still be current; otherwise it checks the revision read
by the command. A raw `voice.extra.voice`, including null, makes managed voice
editing fail instead of changing a masked value.

For an active database-backed call, read `agentvoice_status` and call MCP tool
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
native resolution. `apply: "next-session"` saves without reconnecting. Codex
validates voice availability; there is no local catalog or watcher.

The controller commits the edit and retry receipt before returning acceptance.
Immediate application replaces only the voice session, preserving the working
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
256 operations; each database currently retains 4096 voice-edit receipts, then
refuses new edits. Export/import into a new workspace compacts to a fresh identity;
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
settings/prompt editors are not implemented in this first slice. Exported files
provide reusable templates. Other tools' directory role formats are unchanged.

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
selection. The planner explains supported actions, including closing/reopening
an attached composition when needed. Platform-specific full restarters are future
work.

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
