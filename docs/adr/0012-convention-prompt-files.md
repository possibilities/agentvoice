# 0012: Convention prompt files, one native control each

Accepted 2026-09-05. Supersedes the explicit-only prompt references of commit
3dc3b95 and the matching provision in [ADR 0009](0009-one-foreground-workspace.md).

The operator wants a directory of drop-in files that also serves a later
cross-harness capability format, so prompt overrides load by fixed filename from
the selected config directory again: `VOICE_AGENT_SYSTEM_PROMPT.md` (realtime
`prompt`), `VOICE_AGENT_APPEND_SYSTEM_PROMPT.md`, `VOICE_ORCHESTRATOR_SYSTEM_PROMPT.md`
(`baseInstructions`), `VOICE_ORCHESTRATOR_APPEND_SYSTEM_PROMPT.md`
(`developerInstructions`) and `VOICE_ORCHESTRATOR_SESSION_START.md` / `_END.md`
(realtime start/end instructions). The `prompt-files` config section is gone.

Every file is exactly one native Codex 0.153.4 control; the three seed files were
an AgentVoice-shaped overlay on `initialItems` and are removed (raw
`voice.extra.initialItems` remains). An override and an append for the same agent
cannot coexist. Codex has no voice-prompt append field, and the orchestrator
default is per model and partly remote, so the orchestrator append is Codex's own
developer message while the voice append uses the one native concatenation path:
`includeStartupContext: true` plus `experimental_realtime_ws_startup_context` in
thread config, which Codex renders after its built-in prompt in place of the
Recent Work snapshot. That slot has one owner; other startup-context settings
conflict at launch rather than merge. The key is labeled experimental upstream and
must be re-verified on Codex bumps.
