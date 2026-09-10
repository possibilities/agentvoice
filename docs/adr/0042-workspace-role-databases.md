# 0042: Workspace-owned role snapshots and explicit voice application

Accepted September 8, 2026 for the operator-requested first slice. For explicitly
ejected workspaces, supersedes ADR 0014's live directory inputs and skill-watcher
authoring behavior. Unejected workspaces retain the existing directory behavior.

A workspace explicitly captures complete role/settings contents into a private
SQLite database in XDG data. The canonical workspace selects the database;
portable contents contain no binding authority. Prompts and assets are stored
as bytes. Each runtime reads one revision and generates its own disposable native
filesystem projection. No source/template edit changes an existing workspace role.
Export/import copies a selected revision with a fresh identity and no receipts.

Explicit ejection avoids silently converting historical one-launch flags into
persistent writes. Bound workspaces reject role-setting overrides instead of
masking API edits. Local process/workspace/call selectors remain separate. Native
Codex configuration, credentials, history and managed permissions remain native-owned.

Each edit advances an immutable revision with optimistic concurrency checks.
Settings receive exhaustive mechanical impact classifications; unknown native
passthrough is conservative. The first typed mutation is voice name. Its shared
API/MCP operation saves with a durable retry receipt, then optionally replaces
only the voice session. Working child, thread and attachment remain. This avoids
full restart revoking the TUI and ending the bare-command composition. Other
changes use full runtime restart until narrower apply paths are verified.

Desired revision, loaded runtime revision and last confirmed voice selection are
distinct. Save and application cannot be one atomic transaction. Failure or
unknown acceptance retains the edit without automatic resubmission. Startup and
restart load saved settings; renewal and ordinary redial use loaded settings.
A voice-only apply cannot import other pending settings. The call journal tracks
application but is never recovered into another call; SQLite owns durable edits.

Control protocol 5 and the exact MCP catalog add `agentvoice.voice_set` /
`agentvoice_voice_set`. Older Unix versions are rejected. A waiting server must
restart to load changed controller code; this implementation does not restart it.
Database commands and tests open no microphone and start no inference.

See [workspace roles](../workspace-roles.md) for commands and limits. The
[broader proposal](../role-database-design.md) retains future catalog,
template-management and general-editor design work.
