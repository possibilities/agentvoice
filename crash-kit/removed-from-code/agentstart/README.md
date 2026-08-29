# AgentStart

[![CI](https://github.com/possibilities/agentstart/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/possibilities/agentstart/actions/workflows/ci.yml)

AgentStart is the AI half of this machine: the installer and home for
everything the agent fleet in `~/code` depends on. The machine layer —
Homebrew, Stow, launchd, macOS settings — is owned separately and calls into
this checkout for the rest. The boundary rubric is one sentence:

> Depended on by, or deeply related to, the agent\* fleet → AgentStart.
> Otherwise → the machine layer, and not this repository's concern.

This is one operator's machine layer, published as working reference beside
the agent* fleet it installs. It is orderly — contracts, tests, recorded
decisions — and deliberately opinionated: the judgment calls stay in, stated
plainly, rather than generalized away.

If you are not that operator: the platform is macOS, every path resolves from
`$HOME`, and the installers drive sibling checkouts under `~/code` — the
agent* fleet and `agentguidance` for the general skills, with the machine's
own installer calling in. A checkout you do not have is a skip, not a
failure.
A vendor CLI installs by its own official installer, which reaches the
network. Run `scripts/install.sh --check` to see the whole plan before
believing any of this.

## Layout

- `scripts/` — the installers the machine invokes; the whole external
  interface.
- `prompts/` — the operator guidance the installer links into the home:
  - `agentguidance/` — the extension prompts `SYSTEM.md`, `GUIDELINES.md`,
    and `TOOLS.md`, which agentguidance renders into the collab and build
    skills. Linked into `~/.config/agentguidance/`.
  - `agentvoice/` — the voice orchestrator's doctrine and `server.json`,
    linked into `~/.config/agentvoice/` and read at server boot.
  - `AGENTS.md` — the deliberately empty harness guidance source, copied into
    the fixed private resources and linked from there into the Claude Code,
    Codex, and Pi global slots. Advice belongs in the extension prompts.
- `config/` — harness configuration and resource manifests, the
  agent-browser, Herdr, and fmx operator configs, and the launchd templates for
  fleet services AgentStart owns.
- `skills/` — skills this checkout exports through the agent* scan, like any
  other fleet repo. `fleet/` is the dependency map of the whole ecosystem.
- `tests/validate.sh` — the assertions; run it before committing.

Cross-project decisions and policy live in the wiki, not here — the
`tool-advertisement-policy` page (`agentwiki get <slug>`).

## Contracts

The machine's installer relies on exactly these entry points; their paths,
flags, and skip-versus-fail semantics are load-bearing:

- `scripts/install.sh --install` — the whole AI toolchain, each piece by its
  own checkout's contract, skipping checkouts that are absent:

  - Claude Code, Codex, and Pi, by their official installers;
  - Zig (an intentional duplicate of the machine's Brewfile), `llm`, and the
    Homebrew-installed Hunk review TUI with its version-matched bundled skill;
  - fmx's repository-owned source installer, given fxnk's exact gated Fx
    build, plus the generated live Herdr config and linked fmx key config;
  - the pinned `@native-sdk/cli` and `agent-browser` npm globals, plus the
    linked ordered agentbrowse deployment and provider configs backed by
    `agentbrowse provider`;
  - the shadcn MCP registration for Codex and Claude Code;
  - the `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` guidance links, and
    the extension prompt links;
  - the external skills and fixed private fleet resources;
  - the AgentVoice CLI, and the agentwiki, agentboard, agentbrowse-infra,
    agentbrowse, agentattention, agentsearch, agentkeys, codex-swap, agentusage,
    and agentlaunch CLIs;
  - the public `possibilities/claude-swap` fork and the codex-swap provider
    shim, through agentusage's installer;
  - ownership-verified cleanup of the retired AgentSurface, AgentBus, and Orca
    harness integrations and skills;
  - cass, the fleet launch agents, and finally `sync-skills`.

  The machine's installer calls this and refuses to finish without it.
  `--check` prints the plan without changing anything.
- `scripts/sync-skills` — the cheap convergence path: the agent* checkout
  scan into `~/.local/share/agentstart/resources`, followed by harness render
  refresh. The scheduled updater calls this every six hours. It
  never removes a skill from a compatibility root or restarts services.
  `--check` prints the plan.
- `scripts/install-agentlaunch-shims` — the balanced-launch shims for bare
  `claude`/`codex`/`pi`; the machine's wrapper of the same name delegates
  here.
AI desktop applications are not here by design: the claude and chatgpt casks
belong to the machine layer, as does the `gh` credential migration.

## Herdr and Ghostty color

There is no theme manager. Ghostty runs its built-in default colors, Herdr's
`terminal` theme follows whatever the terminal shows, and tmux styles its
chrome with ANSI indices that resolve the same way. No layer names a color of
its own, so the terminal is the only place a palette could ever be set.

`scripts/herdr-config install` renders AgentStart's tracked behavior config
into `~/.config/herdr/config.toml`, checks the candidate with `herdr config
check`, atomically replaces the live file, and asks a running server to reload.
It is rendered rather than linked because Herdr writes its own keys into that
file, and neither checkout may become program-written state.

Fmx installs through `~/code/fmx/scripts/install.sh`, its canonical consumer
path. AgentStart passes the Fx binary fxnk built from its gated Integration pin
and the exact SHA; Fmx owns the editable link, private `fmx-fx`, pinned
Companion, and doctor check. A machine without the fmx checkout skips it.

`scripts/fmx-config install` links `config/fmx/config.toml` into
`~/.config/fmx/config.toml`. fmx does not write that file, and its `[keys]`
schema is a strict subset of Herdr's; both operator configs use `ctrl+space` as
their prefix.

`scripts/agentbrowse-config install` links the locked version-2 deployment into
`~/.config/agentbrowse/config.json`: Artbird first, then an already-enabled
Apple container session with one 2-CPU, 6-GiB target. The provider never starts
Apple services or acquires an image; recovery remains the explicit
`agentbrowse-infra enable` plus pull/load lifecycle.

`scripts/agent-browser-config install` links
`config/agent-browser/config.json` into `~/.agent-browser/config.json`. It
selects agentbrowse and registers the managed
`~/.local/bin/agentbrowse provider` command as the short-lived
`browser.provider` plugin. It resolves that link through `$HOME`, not `PATH`,
so an older Bun-global command cannot shadow it. The plugin returns each
Browser target's CDP URL dynamically; no provider server or static instance
URL is configured.

## Working on it

Fix forward. A durable change to the AI stack lands in this repository and
converges by rerunning `scripts/install.sh --install`; never configure the
live machine by hand and call it done. After changing anything here, run:

```sh
tests/validate.sh
```

A new fleet tool usually needs almost no edit here. Name the checkout
`agent*` and export `skills/<name>/SKILL.md`, and the scan ships it into the
fixed private resources. AgentLaunch loads those resources into every managed
session: Claude Code exposes `/agent:<name>`, Codex `$agent:<name>`, and Pi
`/<name>`. The globally installed Codex plugin is skills-only and every name is
persistently disabled until AgentLaunch or AgentVoice enables it in a session;
Codex Desktop and deliberate real-binary bypasses therefore receive no fleet
skills. Participant source manifests remain portable and bare; only the Codex
plugin copy qualifies default prompts. Only a tool with its own CLI installer joins the
explicit loop in
`scripts/install-agent-clis`. Whether to advertise it in
`prompts/agentguidance/TOOLS.md` is a separate decision — make it
deliberately, per the `tool-advertisement-policy` wiki page.
