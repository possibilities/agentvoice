# AgentChats

[![CI](https://github.com/possibilities/agentchats/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/possibilities/agentchats/actions/workflows/ci.yml)

Every coding agent on this machine leaves a session history — Claude Code
under `~/.claude/projects`, Codex under `~/.codex/sessions`, Pi under
`~/.pi/agent/sessions`. Agentchats turns that scattered history into a
searchable archive, and teaches agents to use it.

Three pieces do that:

- **A cass installation contract.** [cass][cass] (coding agent session
  search) is the CLI and TUI that indexes and searches local coding-agent
  history across 23 agents. `scripts/install.sh --install` installs the
  upstream checksummed release into `~/.local/bin`, builds or refreshes the
  index, and verifies that the Claude Code, Codex, and Pi session stores are
  covered.
- **The `agentchats` CLI.** `bin/agentchats`, linked editable into
  `~/.local/bin` by the installer. `agentchats state` prints a budget-capped
  bearings dump for agents re-orienting in a project; `agentchats search` is
  the surface-hosted resume picker. State output is Markdown for a model to
  read and silent when the workspace has none.
- **The `chats` skill.** `skills/chats/SKILL.md` is a comprehensive runbook
  that lets agents wield cass expertly: robot-mode discipline, the triage
  preflight, search and query language, token budgeting, cited handoff
  packs, and recovery.

[cass]: https://github.com/Dicklesworthstone/coding_agent_session_search

## Installation

AgentStart owns installation. A full `~/code/agentstart/scripts/install.sh
--install` runs the cass installer, and its per-checkout skill scan
(`scripts/sync-skills`) ships `skills/chats/` through the default `common` pack
for Codex, Claude Code, and Pi.

Directly, from this checkout:

```sh
scripts/install.sh --install   # install/upgrade cass, prepare the index
scripts/install.sh --check     # print the plan without changing anything
~/code/agentstart/scripts/sync-skills   # refresh the common capability pack
```

The installer follows the latest upstream release unless that exact artifact
is quarantined for a reproduced installation failure. Cass `v0.6.26` is held
at `v0.6.25` because its lexical rebuild can deadlock before the upstream
GH#413 fix; any later release is eligible automatically. Search and index
subprocesses are time-bounded so a regression fails the install with a useful
error instead of parking AgentStart indefinitely.

## The agentchats CLI

```sh
agentchats state [--workspace <dir>] [--budget <tokens>]
agentsurface host -- agentchats search [query…] [--workspace <dir>] [--include-auxiliary]
```

Prints the recent sessions for one workspace (the current git project by
default), newest first, bounded by `--budget` (approximate tokens, default
400):

```
## chats — recent sessions in $HOME/code/agentvoice
- 2026-08-06T21:18 · codex · 108 msgs (2 human) · <recommended_plugins>
- 2026-08-05T23:50 · codex · 84 msgs (2 human) · <recommended_plugins>
more: cass sessions --workspace $HOME/code/agentvoice --limit 10 --json · deeper: the chats skill
```

The contract, shared with the other `agent*` state dumps: workspace-scoped,
budget-capped, fast, offline, read-only, and silent when there is nothing to
say (one line when cass cannot serve). Searching and reading the sessions
themselves is cass in robot mode — the chats skill is that runbook.

The search picker shows full-harness sessions by default. Modern Codex
rollouts whose explicit `thread_source` is not `user` — app-server, realtime,
and child-agent sessions — are auxiliary. Include them for one invocation with
`--include-auxiliary`, or toggle them from the ctrl+k command palette. Cass
continues to index both classes.

Search starts in the current git project (or cwd outside Git). The project row
beneath the search field makes that scope a first-class control: Tab focuses
it, Space or Enter opens its fuzzy chooser, and the arrows step through its
values. The chooser offers all projects, the opening project, then `~/code`
and `~/src` one level deep—the same bounded, transcript-independent discovery
rule as AgentLaunch. Ctrl+g still toggles between the selected project and all
projects, and **choose project** remains in the ctrl+k palette.

Legacy producers that predate `thread_source` can be classified by their
Codex `originator` in the optional XDG config at
`~/.config/agentchats/config.json` (`$XDG_CONFIG_HOME` honored):

```json
{
  "auxiliary": {
    "codex-originators": ["agentvoice"]
  }
}
```

This fallback applies only when `thread_source` is absent. An explicit
`thread_source: "user"` is always a full-harness session, regardless of its
workspace, so ordinary Codex CLI work inside an auxiliary producer's project
remains searchable. A missing config file means no legacy originators are
classified as auxiliary; unknown keys or malformed values fail visibly.

## Layout

```
scripts/install.sh     cass installation contract (AgentStart calls this)
bin/agentchats         the agentchats CLI (state + search), linked into ~/.local/bin
skills/chats/SKILL.md  the chats skill (AgentStart's skill scan ships it)
skills/chats/agents/   per-agent skill manifest (openai.yaml)
```
