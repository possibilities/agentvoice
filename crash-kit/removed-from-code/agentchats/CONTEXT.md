# Context

**cass** — the third-party CLI/TUI (coding_agent_session_search) that indexes
and searches local coding-agent session history. Installed by this
repository's `scripts/install.sh`, always invoked by agents in robot mode.
_Avoid_: CASS-the-service, session search engine.

**chats** — this repository's agent skill: the runbook that
teaches agents to wield cass. The skill is the guidance; cass is the tool.
_Avoid_: cass skill, history skill.

**session store** — an agent CLI's on-disk session history that cass
indexes: `~/.claude/projects` (Claude Code), `~/.codex/sessions` (Codex),
`~/.pi/agent/sessions` (Pi). _Avoid_: logs, transcripts directory.

**Full-harness session** — a top-level interactive harness session. A modern
Codex rollout identifies it with `thread_source: "user"`; legacy rollouts with
no thread source remain in this class. This is the default search view.
_Avoid_: primary session (ambiguous with ranking or account selection).

**Auxiliary session** — a session created below or beside a full harness by an
app-server, realtime surface, or child-agent facility. A Codex rollout with an
explicit non-`user` thread source is auxiliary and opt-in in the search picker;
configured originators extend that classification to legacy source-less
rollouts. Workspace never decides the class.
_Avoid_: AgentVoice session (AgentVoice is only one producer), hidden session
(cass still indexes it).

**Agentchats config** — the optional XDG JSON file whose auxiliary policy
names legacy Codex originators. It refines the picker without changing cass's
index or rewriting a session store. _Avoid_: cass config, exclusion list (the
sessions remain indexed and opt-in).

**prepare** — what the installer does beyond installing the binary: build or
refresh the index and verify the session stores are covered, so the first
agent search works. _Avoid_: configure, setup.

**agentchats CLI** — the small surface this repository owns on top of cass:
`bin/agentchats`, linked editable into `~/.local/bin` by the installer. `state`
prints bearings; `search` picks a resumable session. _Avoid_: cass wrapper,
chats CLI.

**state dump** — the bearings section `agentchats state` prints for agents
re-orienting in a project: workspace-scoped, budget-capped, markdown a model
reads, silent when empty. The contract is shared across the `agent*` CLIs.
_Avoid_: status, health check (both are cass's own commands).
