# 0108: Use one AgentStart default role

Accepted September 23, 2026. Supersedes the separate shipped worker role in
[ADR 0049](0049-worker-role.md) and the external `manager`/`worker` naming in
[ADR 0051](0051-agentstart-owns-working-roles.md). Their assignment ownership,
parent return, and generic directory-role runtime contracts remain current.

AgentStart now publishes one external working role at
`~/.local/share/agentstart/resources/roles/default`. AgentVoice's tracked launch
configuration selects that directory. The former `manager` and `worker` names
have no compatibility aliases; AgentStart removes only intact outputs proven by
its ownership receipts.

The default role carries the human-facing manager doctrine. Native Codex
subagents remain bounded workers that return to their exact parent, but
AgentVoice does not associate them with another role directory or inject a role
selection into native delegation. A directly selected arbitrary role remains
supported through AgentVoice's generic `--role` and workspace-role contracts.

This changes no AgentVoice role loader, prompt slot, skill-root registration,
per-thread MCP translation, workspace-role database, or adoption-source digest.
Existing runtime generations and captured workspace-role revisions retain their
loaded bytes. Source convergence neither restarts the server nor reloads an
active call.

Evidence: `AGENTS.md`, `CONTEXT.md`, `roles/README.md`, `docs/manual.md`,
`docs/architecture.md`, and AgentStart's
`config/agentvoice/server.json` plus role renderer.
