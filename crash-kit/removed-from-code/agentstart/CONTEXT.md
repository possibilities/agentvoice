# AgentStart context

**The fleet** — the agent apps in `~/code` whose checkouts are named
`agent*` — `agentguidance` carries the general skills — plus `cass` from
`agentchats` and `peekaboo` from `agentdesk`.
Each fleet repo owns its own hardened installer and exports its own skills;
AgentStart invokes contracts and never reaches inside a sibling checkout.
_Avoid_: suite, monorepo, workspace.

**The boundary rubric** — the one-sentence ownership test for this
repository: depended on by or deeply related to the fleet → AgentStart; the
machine itself (Homebrew, Stow, launchd, macOS settings, account migration)
→ the machine layer, which this repository does not own and does not name.
_Avoid_: split, refactor, migration (those name the event; the rubric names
the rule).

**The toolchain** — everything `scripts/install.sh --install` converges:
harness CLIs, pinned npm globals, MCP registration, guidance links,
extension prompts, and every fixed private fleet resource. The AI *desktop
applications* are not toolchain; they are Homebrew casks, and the machine's.
_Avoid_: stack, setup.

**Fmx source installation** — Fmx's repository-owned `scripts/install.sh`,
which AgentStart invokes with fxnk's exact already-gated Fx source build. It is
the same path consumers use and publishes no binary artifacts.
_Avoid_: release path, bucket installer, AgentStart-owned Fmx installer.

**Fx Integration consumer pin** — The exact published Fx commit AgentStart
passes to fxnk's installer after that commit has passed fxnk's Local
development gate and ship gate. Ordinary convergence reuses the pin; only an
Fx maintenance cycle advances it, so a moving remote branch is never treated
as approval.
_Avoid_: latest Fx, Fx version, integration tip.

**Harness** — an agent CLI a session runs inside: Claude Code, Codex, Pi, Fx.
Skills install into harnesses; AgentLaunch shims balance their bare
launches. _Avoid_: agent (ambiguous with the fleet apps), IDE.

**Extension prompts** — the operator's `SYSTEM.md`, `GUIDELINES.md`, and
`TOOLS.md` under `prompts/agentguidance/`, linked into
`~/.config/agentguidance` and rendered by agentguidance into the
collab/build skills. Their three names are agentguidance's contract; an
unrecognized file renders to nothing. _Avoid_:
config files, dotfiles.

**Advertisement** — a tool's one line in `TOOLS.md` saying when to load its
skill. A line is attention spent in every session and has to earn it; the
policy and its standing decisions live in the wiki
(`agentwiki get tool-advertisement-policy`). _Avoid_: documentation,
listing (an installed, unadvertised tool is still fully documented by its
skill).

**The sync path** — `scripts/sync-skills`: the unattended-safe convergence
the scheduled updater runs every six hours — the participant scan into the
fixed private resources, harness render refresh, no elevation, no
compatibility-root cleanup, no restarts. _Avoid_: update, upgrade (binaries
never move on this path).

**Fleet resources** — the one fixed private set under
`~/.local/share/agentstart/resources`: every fleet and external managed skill,
canonical guidance, the session-only Claude plugin, the globally installed but
inert Codex skills-only plugin, and explicit Pi extensions/templates. Every
managed AgentLaunch and AgentVoice session receives the skills; there are no
selectable packs. _Avoid_: capability pack, common pack, projection.

**Subagent capability** — the fleet's answer to a harness that dispatches no
workers of its own. Pi's is the pinned `pi-subagents` package, installed
self-contained and carried in the fixed Pi extension resources,
which registers a dispatch tool, its skills, and its workflow prompt
templates from one directory. _Avoid_: subagent plugin (Pi calls the unit a
package), worker (that is what a dispatched agent is, not the capability).

**Codex fleet plugin** — the globally installed, strictly skills-only plugin
`agent@agentstart-managed`. AgentStart persistently name-disables every
`agent:<skill>`; AgentLaunch and AgentVoice name-enable the fixed set in their
session layer, exposing `$agent:<name>` without leaking fleet skills into
unmanaged Codex or Fx-visible roots. _Avoid_: compatibility projection, extra
root.

**The Herdr config render** — the live `~/.config/herdr/config.toml` rendered
by AgentStart from its tracked behavior config, which carries no palette.
`herdr-config` validates and replaces the live file, so neither checkout
becomes program-written state; it is rendered rather than linked because Herdr
writes its own keys into it.
_Avoid_: dotfile, theme config (the render sets no colors at all).

**Participant** — an `agent*` checkout that exports
`skills/<name>/SKILL.md` and is therefore discovered by the scan. A
checkout without one is not misconfigured; it is simply not a participant.
This repository is itself a participant (the `fleet` skill). _Avoid_:
registered, enrolled (there is no registry — the convention is the whole
interface).

**Model invocation policy** — the portable fact recorded by
`disable-model-invocation` in a skill's `SKILL.md` frontmatter; absent or false
means model-invocable. The fixed-resource render derives Codex's inverse
`allow_implicit_invocation` field from it, while Claude and Pi consume the fact
directly. _Avoid_: OpenAI policy (that is one rendered representation).

**Peer** — an agent session doing ordinary work in its own worktree. Its
result stops at a clean, verified commit; it never moves `main` or a remote,
and it learns a supervisor exists only from the calling card in that
supervisor's first message. _Avoid_: worker (which runs a dispatched brief
under an orchestrator), child, sub-agent.

**Quiet worktree** — a worktree holding nothing for the supervisor: no
unmerged commits, nothing uncommitted, and either no commit ever made in it or
its agent still sitting there. It is counted in the roster and never
announced. _Avoid_: idle (which describes the agent, not the worktree), empty
(a quiet worktree is usually a full checkout).

**Supervisor** — a persistent agent role that watches peer lifecycle events,
obtains readiness for an exact commit, integrates that commit into local
`main`, pushes `origin/main`, and reaps a clean worktree only after Herdr has
observed its agent end and workspace close. It preserves the branch and a
durable association receipt. _Avoid_: orchestrator (a broader control-plane
role), Land (which combines integration and release).
