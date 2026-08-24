# 0006: Compose AgentStart common before opening threads

AgentVoice's resident is a standalone Codex App Server, so it cannot rely on
the desktop harness's compatibility plugin to discover fleet skills. On every
initial attachment and reattachment, immediately after `initialize`, the
Server resolves AgentStart's capability root and calls
`skills/extraRoots/set` with `packs/common/skills` before it starts or resumes
the orchestrator thread. A missing pack and a relative
`AGENTSTART_CAPABILITIES_ROOT` are installation errors.

That same projection is also installed as the persistently enabled `agent`
compatibility plugin, so its `agent:<skill>` aliases would list every fleet
skill a second time — and codex, which caps the skills catalogue at a share
of the context window, would shorten every description in the thread to fit.
The resident spawn once passed a session flag to disable that plugin, which
never took effect: codex resolves plugin enablement only from persistent user
and profile layers. Suppression is per thread instead. Every `thread/start`
and `thread/resume`, orchestrator and worker alike, carries a `skills.config`
naming each alias disabled, ordered before any operator rule so the operator
still decides. Thread params are the right home because AgentVoice opens its
own threads: the policy needs no argv placement and no cooperation from
whoever spawned the resident.

The pack remains owned and rendered by AgentStart; AgentVoice stores no copy.
The thread and rollout continue to live in Codex's native session store, and
account profiles continue to share that store, so Server restart, resident
rotation, cross-account resume, native history, and external indexing keep
their existing semantics. Re-registering the root on every attachment is
required because App Server capability roots are process/connection state,
not thread history.
