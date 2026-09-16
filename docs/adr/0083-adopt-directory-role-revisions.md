# 0083: Adopt directory role contents as a fenced workspace revision

Accepted 2026-09-16 for explicit workspace-role refresh. Extends
[0042](0042-workspace-role-databases.md) without restoring a live relationship to
source role directories.

An already-bound workspace may explicitly capture one selected directory role as
a new immutable revision with `agentvoice role adopt`. The command requires the
current expected revision. It retains the workspace role ID and copies the current
serialized AgentVoice settings document unchanged, including voice, model,
permission, native override, and other saved choices. Every path present in the
selected directory replaces that path in the saved asset bundle. Existing paths
absent from the source remain byte-for-byte intact. This preserves separately
materialized managed skills and other local assets; deletion requires a future
explicit editor/remove operation. The selected directory cannot silently replace
database settings.

`--prompts-only` narrows the same fenced capture to the two general role prompts
and seven AgentVoice prompt/mode controls. MCP, skills, metadata, and all other
assets remain unchanged and are not traversed during source capture. This
supports guidance refresh from an authored role
source when another owner separately materializes its MCP inventory or skills.

Capture uses the existing traversal, path, file-count, depth, byte-size, symlink,
and executable-bit rules. The complete candidate is locally preflighted before a
write. Publication runs in one immediate SQLite transaction, rechecks role identity
and expected revision, stores assets by content hash, appends the revision, and
advances the desired pointer. A stale writer or invalid candidate leaves the prior
revision current. Older revisions and their reachable assets remain intact.

`--dry-run` performs the same merge, validation, impact planning, and initial
revision check without opening the database for mutation. Both dry-run and save
report the selected mode, planned next revision, total/source/preserved asset counts,
settings-preservation fact, impact boundary, and `applied: false`. Offline adoption
never starts inference, audio, installation, or a process restart.

The database accepts at most 4,097 immutable revisions and 256 MiB of stored
deduplicated asset bytes. A save that would exceed either limit fails before the
head advances and directs the operator to export/import into another workspace,
which compacts the selected revision into a fresh independent role. This bounds
both identical no-op revision growth and changing historical blobs while retaining
lossless history below the limit.

The saved revision becomes live only through a later explicit runtime restart,
`new_session`, or server workspace-session boundary. Frontend reattachment does not
load it. A running controller continues to report its older loaded revision until
that activation boundary.

This command is a one-way source capture, not template inheritance or automatic
migration. Later source edits do nothing until another explicit fenced adoption.
General settings editing, explicit asset deletion, arbitrary file-by-file patching,
diff/history inspection, restore, template catalogs, rebinding, and automatic
activation remain separate work.
