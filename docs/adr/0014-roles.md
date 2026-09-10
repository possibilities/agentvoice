# 0014: Roles are directories delivered to the owned child

For explicitly ejected workspaces, [ADR 0035](0035-workspace-role-databases.md)
supersedes live directory loading with database snapshots. This format remains
an ejection input and the behavior for unejected workspaces.

Accepted 2026-09-05. Extends [ADR 0013](0013-convention-prompt-files.md) and
settles the skill-isolation question left open by [ADR 0007](0007-defer-skill-policy-to-codex.md).

A role is a directory of skills, an mcp.json, and prompt replacement or append
files, selected per launch with --role or the role key. The same format is
delivered to Claude Code and the Codex CLI by the agentroles CLI through
command-line arguments; AgentVoice reads it natively because only its process
can call skills/extraRoots/set on the child it owns. That RPC is process-local
(stable in app-server since rust-v0.136.0, verified live on stock 0.153.4 with
the app-server probe), so role skills are invisible to every other Codex
process and nothing is written under CODEX_HOME. Role MCP servers ride
per-thread config for the same reason; workspace-level .agents/skills or
.codex/config.toml would leak to any Codex opened there, and global
skills.config or plugin changes were rejected as isolation mechanisms.

Inside a role, SYSTEM_PROMPT.md and APPEND_SYSTEM_PROMPT.md are the general
orchestrator prompt every harness receives; the VOICE_ORCHESTRATOR pair stands
in for the same kind for AgentVoice only, and the replace-or-append rule from
[ADR 0013](0013-convention-prompt-files.md) applies to the result. A role replaces the config directory as the
prompt source rather than merging with it.
