# 0051: AgentStart owns manager and worker roles

Accepted September 12, 2026. Supersedes the source ownership and naming in
[ADR 0049](0049-worker-role.md), retaining responsibility and native runtime
contracts. The operator requested roles that carry both their prompt Markdown
and MCPs, with independently changeable rosters.

Move the former default role to AgentStart's `roles/manager` and worker to its
`roles/worker`, preserving prompt contents. Each source owns `mcp.json`, initially
the full fleet inventory. AgentStart renders account-relative commands and links
the shared skills root and authored prompts into `resources/roles/manager` and
`resources/roles/worker`. Its tracked AgentVoice config selects manager.

AgentVoice's generic loader, native prompt slots, per-thread MCP configuration,
and controller-owned control MCP stay unchanged. Tests here cover external role
consumption; AgentStart tests authored assets and rendering. The native policy
probe takes an explicit role path.

The old source paths are removed without aliases. AgentStart's former managed
default directory is no longer selected or rendered. Publish replacement roles
before switching the selector and removing old sources. Existing snapshots and
runtime generations keep their loaded contents. This requires no call restart.
