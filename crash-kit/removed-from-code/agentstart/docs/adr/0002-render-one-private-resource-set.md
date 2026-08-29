# 0002: Render one private resource set

AgentStart renders one fixed set under `~/.local/share/agentstart/resources`.
Claude receives a session-only `agent` plugin, Pi receives explicit paths with
ambient discovery disabled, and Codex receives a globally installed strictly
skills-only `agent` plugin whose qualified names are persistently disabled and
session-enabled only by AgentLaunch and AgentVoice.

This keeps fleet skills out of Fx-visible ambient roots while letting
AgentLaunch use native `codex-swap run/resume`, restoring Codex's linked-
worktree trust and eliminating AgentLaunch's App Server/socket/remote-TUI
dependency. Selectable packs, projections, receipts, bare Codex skill names,
and fleet skills in Codex Desktop are deliberately retired; native stores,
balancing, claims, guidance, statuslines, Pi utilities, and AgentVoice's
independent realtime App Server remain.
