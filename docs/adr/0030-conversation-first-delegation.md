# 0030: Conversation-first delegation through native operator configuration

Accepted September 8, 2026. The operator approved a native custom multi-agent
mode for the default voice role: the root delegates substantial work, including
a single blocking assignment, while owning conversation, decisions, integration
and verification; workers execute their assignments rather than recursively
becoming conversational managers.

The operator's AgentStart-owned AgentVoice server configuration supplies
`orchestrator.config["features.multi_agent_v2"].multi_agent_mode_hint_text`,
explicitly superseding Codex's earlier delegation and model-selection guidance
while preserving native fork constraints, permissions and approvals. This is an
operator opt-in, not an unconditional AgentVoice runtime default or a Codex
binary/base-prompt fork; the role append alone does not activate the mode.

Stock 0.153.4 with a localhost fake model verified that the full policy follows
the append on both thread start and exact resume after owned-child replacement.
The native spawn description remains present, with a later explicit policy
exception; behavioral responsiveness still needs a separately scoped live
trial. See [the audit](../delegation-policy-audit.md).
