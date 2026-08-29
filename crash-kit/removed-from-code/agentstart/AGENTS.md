# AgentStart agent guidance

## Repository context

- `~/code/agentstart` owns AI-toolchain installation for this machine. The
  machine layer itself — Homebrew, Stow, launchd, macOS settings, account
  migration — is owned elsewhere and is not this repository's concern; its
  installer invokes this checkout, and that call is the whole relationship.
  When a change straddles the two, the scope test decides: depended on by or
  deeply related to the fleet → here; the machine itself → not here. Every
  path here resolves from `$HOME` — nothing may assume a particular account
  name.
- The fleet lives beside this checkout: every `~/code/agent*` checkout
  without exception — including `~/code/agentguidance`, the general guidance
  skills and their renderer — plus `~/code/codex-swap`, the first-party
  account-swapping launcher for codex and pi. Each fleet repo owns its own
  hardened installer and exports its own skills; AgentStart invokes
  contracts, it does not reach inside — but it decides that every
  one of them is installed. `install-agent-clis` runs each checkout's own
  installer, and `config/launchd/` defines every fleet service, because a
  service with two owners has them racing to render it. A fleet checkout
  ships the code; this repository decides that it is present and when it
  runs. Nothing outside this repository installs a fleet component.
- Two outside projects are managed fork dependencies, each under the `~/src`
  convention with our fork as the `fork` remote and bound at its `integration`
  branch — every patch carried, merged, and the only ref an installer builds.
  A patch offered upstream lives on its own branch beside it. `claude-swap` is
  owned by agentusage's `scripts/install-providers.sh`; it is not in the
  `install-agent-clis` loop, which is why that loop runs agentusage before
  agentlaunch. Fx's fork lifecycle and integration installer are owned by
  `~/code/fxnk`; AgentStart invokes `fxnk/scripts/install.sh --install --sha`
  with its tracked, ship-gate-approved Integration pin as the harness
  installation contract instead of reaching into `~/src/fx`. fxnk installs
  that exact source build to `~/.local/bin/fx` and disables Fx's independent
  auto-updater. Both fork owners refuse a checkout whose fork remote is not
  ours. The `fork-rebase-policy` wiki page is the contract.
  `codex-multi-auth` is no longer a managed fork
  dependency: upstream merged PRs #664 and #665, so codex-swap installs the
  exact stock npm pin instead. Its installer keeps the fork behind
  `NDY_FORK_ACTIVE=0` — dormant rather than deleted, which is what makes
  reviving it an edit rather than a rewrite.
- Herdr is moving from AgentStart's retired `~/src/herdr` updater to the
  official stable Homebrew formula. `scripts/select-herdr-runtime` is the
  cutover guard: stable must speak fleet protocol 21 or newer and every
  default/named server socket must be absent before the receipt-proved source
  binary is removed. While a socket is present or uncertain, full convergence
  leaves Homebrew's installed bytes unchanged and keeps the compatible client
  and its build evidence. Once every socket is proved inactive, convergence
  may stage stable, but the final cleanup additionally requires
  `AGENTSTART_HERDR_ALLOW_CUTOVER=1`; ordinary
  convergence may never win that race implicitly. Once no legacy binary or
  evidence remains, ordinary convergence recognizes Homebrew as already
  selected, and later formula upgrades require the same explicit inactive-run
  authorization. A clean install with no prior formula or legacy state still
  installs stable normally. Package-manager updates cannot use Herdr's live
  handoff, so never weaken the socket gate to replace client bytes around
  resident agents.
- Every fleet repo's `AGENTS.md` ends with the same "The fleet" section
  pointing back here: the skills scan and its cadence, the fleet-map rule,
  and agentguidance as the home of general doctrine. Changing any of those
  conventions updates that section in every fleet checkout in the same
  change — the uniformity is what keeps twelve copies maintainable.
  codex-swap is the deliberate exception: a one-way member — the fleet
  installs it, but it stands alone for anyone outside this machine who
  wants an account-swapping launcher, so its own guidance does not
  advertise the fleet back.

## Fix-forward installation

Every durable AI-stack change belongs in this repository and converges by
rerunning `scripts/install.sh --install`. Do not hand-configure the live
machine, and do not grow a second installer or synchronization path here or
in `~/code/agentguidance`.

The external interface is exactly `scripts/install.sh` (`--install`,
`--check`), `scripts/sync-skills` (`--check`),
`scripts/install-agentlaunch-shims`. The machine's installer and scheduled
updater call these by path with fixed semantics: a missing optional fleet
checkout is a skip inside the script, a present-but-broken one fails, and
the updater path (`sync-skills`) must stay unattended-safe
— no sudo, no uninstalls, no application restarts. Retired integration
cleanup belongs in the full installer. That caller's own test suite greps
these scripts, so renaming or resemanticizing them breaks it.

Where things go:

- A new AI tool, harness configuration, npm global, or external skill pack:
  `scripts/install.sh`, with its plan line in the `--check` output and
  assertions in `tests/validate.sh`.
- Fmx installation: invoke `~/code/fmx/scripts/install.sh --install`, passing
  the exact Fx binary the fxnk installer just built together with its proved
  Integration SHA. Fmx owns the consumer path, editable Bun link, private
  `fmx-fx`, pinned Companion, and doctor verification. AgentStart owns only
  fleet ordering and the exact-pin equality check.
- A new fleet tool: add the checkout to the `install-agent-clis` loop if it
  has a CLI installer, and note the ordering constraint in the comment there
  if it has one. The `agent*` skills scan needs nothing. A loop member's
  installer must be rerunnable, because a present checkout that fails stops
  the whole install.
- A new long-running fleet service: a noun-role template in `config/launchd/`,
  an entry with its explicit lifecycle (`resident`, `periodic`, or
  `queue-triggered`) in the manifest at the top of
  `scripts/install-launchagents`, and assertions in `tests/validate.sh`.
  `config/launchd/README.md` is the
  contract — what every service shares and what is deliberately
  per-service. Labels are bare `<tool>.<service>`; a reverse-DNS label is a
  machine service and does not belong here.
- A fleet TUI bound to a Herdr popup: always add a pane entrypoint to the
  `agentsurface` plugin, then bind the key to `herdr plugin pane open`. The
  tool continues to own its TUI; the shared plugin owns the popup title and
  geometry so the dialog is also exposed through Herdr's plugin surface.
- A third-party harness capability the fleet decides every session gets:
  its own pinned installer script invoked by `scripts/install.sh`, with
  `scripts/render-capabilities` carrying the result into the fixed resources.
  `install-pi-subagents` is the standing example — Pi ships no subagents by
  design and points at third-party packages, so the fleet picks one and pins
  it. Install it self-contained and let the renderer carry it; never register
  it in a harness's own settings, which is exactly what a managed launch
  suppresses.
- A statusline change: `config/statusline/`, converged by
  `scripts/install-statusline`. One bar in three harness idioms, because
  that is all the harnesses offer — claude runs a render command per frame,
  pi replaces its footer from an extension, and codex draws its own bar and
  only lets an operator choose and order a fixed set of items. A field
  added to one renderer belongs in the others wherever they can know it;
  each renderer's comments record what its harness cannot.
- An operator extension prompt edit: `prompts/agentguidance/`, then
  `scripts/install.sh --install` (or wait for the six-hour sync plus the
  next render) so the rendered skills pick it up. A GUIDELINES.md bullet
  is a rule plus, when detail exists, the named wiki contract page
  (`fork-rebase-policy`, `document-placement-policy`, `fleet-tui-design`)
  — never the detail itself, which lives in the page and is read at the
  trigger. These lines render into every session, so each one is paid for
  in every conversation.
- A voice orchestrator doctrine edit: `~/code/agentguidance`
  (`prompts/agentvoice/`, spliced from the shared orchestrator fragments),
  then the same render path. This repository keeps only
  `prompts/agentvoice/server.json` and links the rendered doctrine from
  `~/.agents/prompts/agentvoice/` into `~/.config/agentvoice` — after
  sync-skills, so the rendered source exists.
- A cross-project decision that belongs to no single repo: the wiki
  (`agentwiki new`), one page per subject, wikilinked to its neighbours
  and pointed at from wherever it constrains. `tool-advertisement-policy`
  is the standing example.
- A change in who calls what between fleet apps: update the map the
  `fleet` skill serves (`skills/fleet/MAP.md`) in the same change.

## Skills

This checkout participates in the same convention it administers: skills
under `skills/<name>/SKILL.md` ship into the fixed private fleet resources via
`scripts/sync-skills`. AgentLaunch loads them into each managed session:
Claude Code exposes `/agent:<name>`, Codex uses `$agent:<name>`, and Pi uses
`/<name>`. The `fleet` skill is the dependency map of the ecosystem;
its `MAP.md` claims to be current, so a stale edge there is a bug, not a doc
nit.

## Validation

```sh
tests/validate.sh
```

After changing installation behavior, also run
`scripts/install.sh --install` and compare the installed `collab` manifest
with its agentguidance source template — the same convergence check the
fleet's guidance prescribes. `AGENTS.md` is the canonical guidance file;
`CLAUDE.md` is a symlink to it.
