# 0031: The selected role owns its native delegation mode

Accepted September 8, 2026. Supersedes ADR 0030's server-configuration ownership:
the operator wants the default role to carry its own conversation-first policy,
so selecting another role must not inherit that policy from managed config.

`VOICE_ORCHESTRATOR_MULTI_AGENT_MODE.md` is one native prompt control, loaded
through the existing role/config-directory mechanism and sent as
`features.multi_agent_v2.multi_agent_mode_hint_text` with the required V2 feature
enabled. The default role ships this file; absence preserves native policy,
empty text suppresses the native mode message, and the file owns the request
slot rather than merging with another mode owner. Preserve unrelated V2
configuration and native permission requirements. Contents reload per runtime
generation, including exact resume in a replacement child.

AgentStart publishes a link to the role's file and removes the earlier policy
copy from server.json. Model/effort, logging and permission choices remain
operator settings. AgentRoles validates the new AgentVoice-only file; no
Codex binary fork or generic role configuration overlay is introduced.

The operator subsequently clarified that delegation covers task execution even
for quick lookups. The root answers from existing context and owns dialogue,
coordination, decisions, integration and result verification. It dispatches
independent actionable assignments in parallel, including new requests while
workers run; neither a substantial-work threshold nor another local task is
required. See the audit's live lookup evidence and policy correction.
