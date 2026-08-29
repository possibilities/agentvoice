# Agentguidance agent guidance

Skill directories under `skills/` and prompt templates under
`prompts/<consumer>/` are templates. The installed copies under
`~/.local/share/agentstart/resources/skills/`
and `~/.agents/prompts/` are rendered artifacts — never edit them. After
changing any template, a fragment in `fragments/`, or an extension prompt in
`~/.config/agentguidance/`, run `scripts/render` to rebuild them.

Two kinds of render point, spliced by `scripts/render`:

- `<!-- fragment: NAME.md -->` — repo-owned shared doctrine from
  `fragments/`, so the skills that share a spine (collab, build,
  orchestrate, and prompt share classification, the sketch contract, build
  norms, the domain-model discipline, the orchestrator's conduct, and the
  orchestrator's own tools) cannot drift apart. A missing fragment fails
  the render.
- `<!-- extension-prompt: NAME.md -->` — operator-owned machine voice from
  `~/.config/agentguidance/` (linked there by AgentStart from its
  `prompts/agentguidance/`). An absent file renders to nothing.

A prompt template under `prompts/<consumer>/` is doctrine one app consumes
as a prompt file rather than a skill — agentvoice's orchestrator files, for
now. It renders to `~/.agents/prompts/<consumer>/NAME.md`; the consumer's
own installer links the rendered file from wherever that app discovers it
(AgentStart links `~/.config/agentvoice/` for agentvoice), so this repo owns
the content and the consumer's installer owns that it is wired. Deleting a
template prunes its rendered copy, banner-matched like a skill's.

This checkout is an ordinary agent* scan participant: AgentStart's sync-skills
ships `skills/<name>/` whole into the fixed private fleet resources, then runs
`scripts/post-sync` — the render — so the raw templates it just shipped are
immediately replaced by rendered artifacts. That hook is why the templates
may live in `skills/` at all; without it, every six-hour sync would strip the
extensions until the next render. Do not add an installer here and do not
bypass the hook.

Model invocability is declared only by `disable-model-invocation` in
`SKILL.md`; AgentStart derives Codex's inverse `allow_implicit_invocation`, so
never maintain that field in source.

Retiring a skill is deleting its directory: the render prunes the installed
copy it once produced (banner-matched, so other tools' skills are untouched).
`collab` and `build` replaced `hack` — the same doctrine forked only on
whether a human answers mid-run. Keep that fork honest: shared meaning
belongs in a fragment, not copied into both templates.

`maintain` is doctrine for a kind of repository — a fork workshop such as
`fxnk` or `zmax` — rather than for a tool, which is why it lives here; the
one script it ships, `skills/maintain/scripts/reconcile-branches.sh`, is
the deterministic owner of the mirror and carry refs every workshop declares,
proven by `tests/branch-policy.sh`, and a workshop calls the installed copy
through a thin entrypoint rather than copying it. Other fork heads are
reported and left unchanged; `DELETEME/*` is explicit human state.

A tool-specific runbook normally lives with its tool, but `notify` and
`email` wrap `terminal-notifier` and `gog` — third-party binaries with no
fleet repo to live in, so they live here. That is the whole exception; a
runbook for a fleet tool still belongs in that tool's checkout. `email` is
deliberately unadvertised and reached through its own description alone.

`AGENTS.md` is the canonical guidance file; `CLAUDE.md` is a symlink to it.
Run `tests/validate.sh` before committing.

## The fleet

This checkout is one of the agent* fleet under `~/code`. Shared machinery
lives in two siblings, and some changes here must cascade:

- Skills under `skills/<name>/` ship into AgentStart's fixed private
  fleet resources (`~/code/agentstart/scripts/sync-skills`, run six-hourly
  by the scheduled updater). AgentLaunch loads them into every managed
  session: Claude Code exposes `/agent:<name>`, Codex uses
  `$agent:<name>`, and Pi uses `/<name>`. A SKILL.md edit is live within
  six hours, or on demand by running that script. Whether a new skill earns a TOOLS.md
  advertisement line is a deliberate decision —
  `agentwiki get tool-advertisement-policy`.
- Adding or removing a call to another fleet tool changes the fleet map:
  update `~/code/agentstart/skills/fleet/MAP.md` (served by the `fleet`
  skill, every edge with evidence) in the same change.
- General agent doctrine — collab, build, maintain, story, the resource
  skills — is `~/code/agentguidance`; tool-specific runbooks stay here.
