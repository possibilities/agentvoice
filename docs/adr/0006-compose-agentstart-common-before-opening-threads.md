# 0006: Compose AgentStart common before opening threads

AgentVoice's resident is a standalone Codex App Server, so it cannot rely on
the desktop harness's compatibility plugin to discover fleet skills. The
resident spawn disables that compatibility projection explicitly. On every
initial attachment and reattachment, immediately after `initialize`, the
Server resolves AgentStart's capability root and calls
`skills/extraRoots/set` with `packs/common/skills` before it starts or resumes
the orchestrator thread. A missing pack and a relative
`AGENTSTART_CAPABILITIES_ROOT` are installation errors.

The pack remains owned and rendered by AgentStart; AgentVoice stores no copy.
The thread and rollout continue to live in Codex's native session store, and
account profiles continue to share that store, so Server restart, resident
rotation, cross-account resume, native history, and external indexing keep
their existing semantics. Re-registering the root on every attachment is
required because App Server capability roots are process/connection state,
not thread history.
