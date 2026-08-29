# Funk agent guidance

## Repository context

- `/Users/arthack/code/funk` is the canonical Funk repository and
  `/Users/arthack` is the target account's home. In a worktree, treat that
  worktree's root as the repository path.
- The pre-migration account's dotfiles repository is reference material where
  it still exists locally; migrate useful ideas from it selectively and
  preserve Funk's narrower goals and safety constraints. Its path is not
  recorded here — it belongs to an account this repository no longer names.
- Migrate credentials or authenticated CLI configuration only when needed.
  Copy the minimum required files, preserve restrictive permissions, and never
  print, inspect unnecessarily, or commit secret values.

## Fix-forward configuration

Every durable system change belongs in this repository. A fresh account should
converge by running `./install`; do not rely on one-off live configuration.

- Add software to `Brewfile` and install it through Funk.
- Add user configuration to the appropriate GNU Stow package, edit the source
  here rather than its live path under `$HOME`, and run `funk stow`.
- Use `funk stow --check` before risky changes. Use
  `funk stow --adopt <package>` only to migrate an intentional existing config,
  then review the Git diff because adoption changes repository files.
- For a new package, register it in `libexec/stow-config`, add it to the table
  below, and test the forward installation path.
- Add user-level macOS preferences to `libexec/configure-macos`; route
  privileged machine settings through the guarded system helpers.
- Preserve common Emacs/readline movement, history, cutting, and yanking
  bindings when changing shell or terminal input behavior.
- Reload affected applications after changing live configuration when
  possible: source tmux's config and restart Yabai/skhd services. Karabiner
  reloads its configuration automatically.
- Managed configuration carries no raw palette: no hard-coded named color or
  hex literal, and no generated palette. Colors are named once, by
  `theme = ` in `ghostty/.config/ghostty/config`, and every other layer
  follows the terminal that results. Tmux's
  `tmux/.config/tmux/conf.d/theme.conf` styles the status bar against that
  palette using only ANSI indices (`colour0-15`) plus `default`.
  `tests/validate.sh` pins that theme line's presence, the named-color and hex
  bans, the tmux file's existence, and its confinement to the ANSI range, so a
  future theme cleanup cannot sweep the status bar away again the way `24663c1`
  did. Theme *files* still never live here: the Ghostty cask installs all of
  them under the application's Resources, and Funk names one by string.
- Picking a theme and tracking one are separate steps, and the seam between
  them is deliberate. `ghostty-themes` — upstream's picker, cloned to
  `~/src/ghostty-themes` by `funk install-ghostty-themes` and reached through
  Funk's wrapper at `bin/.local/bin/ghostty-themes`, bound to
  `ctrl+cmd+shift-t` in skhd — browses the cask's themes and writes the pick
  into Ghostty's macOS Application Support config rather than the XDG one.
  Ghostty loads that file second, so a pick outranks the tracked line until
  someone promotes it by editing `theme = ` here and deleting the
  machine-local file. That override is a known footgun, accepted to keep the
  picker: nothing warns when the machine drifts from the checkout. The wrapper
  still exists to pin `GHOSTTY_CONFIG` at the machine-local path, because the
  picker rewrites its target with `mktemp` + `mv` — aimed at
  `~/.config/ghostty/config` it would replace that Stow link with a real file.
  `tests/validate.sh` pins the wrapper's pin.
- `assets/chuchu/Signal Room` is outside that managed desktop-configuration
  rule. It is the canonical remote APK asset consumed only by
  `funk chuchu-theme`, which must prove the built application ID is
  `com.arthack.chuchu.lab` before contacting ADB and must never uninstall or
  mutate the official `com.jossephus.chuchu` package.

| Package | Target | `--no-folding` |
| --- | --- | --- |
| `git` | `~/.config/git/` | yes |
| `ssh` | `~/.ssh/` | yes |
| `ghostty` | `~/.config/ghostty/` | yes |
| `nvim` | `~/.config/nvim/` | no |
| `skhd` | `~/.config/skhd/` | no |
| `tmux` | `~/.config/tmux/` | yes |
| `zsh` | `~/.zshenv`, `~/.zshrc`, `~/.zsh/` | yes |
| `yabai` | `~/.config/yabai/` | no |
| `karabiner` | `~/.config/karabiner/` | yes |
| `tmuxctl` | `~/.config/tmuxctl/` | yes |
| `bin` | `~/.local/bin/` | yes |
| `btop` | `~/.config/btop/` | no |
| `herdr` | `~/.config/herdr/` | yes |
| `docker` | `~/.docker/cli-plugins/` | yes |

A `--no-folding` package's target directory stays a real directory, so it can
hold files Funk does not track. That is the whole reason those rows are marked:
`~/.ssh/config.d` is written by `funk ssh-tailnet-config` and
`~/.config/git/config.local` by `funk git-identity`, and under normal folding
both generators would be writing straight back into this checkout.

The `docker` package owns only CLI-plugin launchers. Docker contexts,
credentials, and generated state remain machine-local under `~/.docker`; in
particular, never track or Stow `~/.docker/config.json` just to make Homebrew's
plugin directory discoverable.

Machine-identifying data is generated onto the machine at converge time, never
tracked and never adopted back. `home-awake --learn-network` records the home
router that way, `funk ssh-tailnet-config` records the tailnet that way, and
`funk git-identity` records the commit name and address that way; all three
write outside this repository, and none may be pulled back in with
`funk stow --adopt`.

The identity case is the one where getting the folding wrong is worst, and it
is worth understanding before touching the `git` package. A relative
`include.path` resolves against the directory of the *link* git opened, not the
file behind it — so a real `~/.config/git` puts `config.local` on the machine,
while a folded one puts the operator's name and address inside this working
tree. `tests/validate.sh` asserts both halves: no identity in the tracked file,
and a real directory to hold the untracked one.

Never Stow credentials, secrets, generated application state, remote-device
configuration, root-owned helpers, LaunchDaemons, rendered LaunchAgents, or live
tailnet identity — MagicDNS suffixes and the accounts this machine logs into
other machines as. `tests/validate.sh` pins that last one with a `git ls-files`
check on `ssh/.ssh/config.d` and a `.ts.net` grep over the tree, so re-adding a
host file is a deliberate, reviewable change rather than a convenience. Bare
device names are the one part of a tailnet this rule does not chase: several are
overridable defaults in the helpers that address a specific machine, and a label
that resolves nowhere off its own tailnet is not worth the churn of generating.
Do not widen the rule to cover them without also changing those helpers — a rule
the tree already breaks teaches the next reader to ignore it. Install privileged files through Funk's guarded helpers; never link
a root execution path into this user-writable checkout.

An unattended agent that needs root gets a purpose-built helper, not a
passwordless rule on a general-purpose system binary. `system/funk-home-awake`
is the model: sudoers names that helper with an enumerated argument list, and
the helper validates every argument before touching `pmset` or `sysadminctl`.
`tests/validate.sh` pins the granted list, so widening it is a deliberate,
reviewable change rather than a side effect.

A keychain item's access list is the same argument in another form.
`bin/.local/bin/home-awake` stores the login password with `-T ""` and has a
human approve the first read, rather than granting `/usr/bin/security` — a
general-purpose binary any process can invoke — a standing read at creation
time. `tests/validate.sh` asserts both the flag and the absence of that grant,
so restoring it is not a convenience fix either.

## Validation

`tests/validate.sh` is the whole suite and runs anywhere, but it does not run
*everything* everywhere. The checks that need macOS to mean anything — the
`pfctl` parse of the travel firewall, Gatekeeper quarantine xattrs, the
Homebrew cask helpers that read ownership with BSD `stat -f`, the `funk update`
path through AgentStart's Darwin-gated skill sync, and the home-awake and
Android launcher suites — skip themselves off Darwin and print what they
skipped, and the summary line repeats the list. Everything else is portable:
the policy greps, `bash -n` over every shell file, shellcheck, and the launchd
plist assertions, which read through `tests/lib/plist` (stdlib `plistlib`)
rather than PlistBuddy and plutil. `tests/ssh-tailnet-config.sh` is portable
too: it drives `tests/fixtures/tailscale` rather than the daemon, so it runs
everywhere and never joins the skip list.

CI runs the portable half on Ubuntu, so a green run there is not a claim that
the macOS-only checks passed — only that nothing portable regressed. **Run
`tests/validate.sh` on the machine before landing anything that touches the
guarded halves**; that run is the one where the skip list is empty.

shellcheck runs at `--severity=warning`, and that floor is deliberate rather
than lazy. The style tier disagrees between releases — 0.9.0 raises SC2015 on
assertions 0.11.0 will not emit even when asked for SC2015 by name — so
enforcing it means pinning a version, and the pinned release binary needs
roughly 3.7GB of RSS whether it is handed all 76 files or one five-line
fixture. That was tried and reverted. Fix what errors and warnings find; do not
raise the floor back to style without solving the memory cost first.

## Unprivileged convergence

A default `./install` must not ask for a password once the machine has
converged — not for sudo, and not for the keychain, which asks in a dialog no
scheduled run can answer either. Two rules keep that true, and both are asserted
by `tests/validate.sh`:

- The scheduled `funk update` path never elevates. Anything needing
  administrator authentication is identified by `libexec/list-unattendable-casks`
  and skipped through `HOMEBREW_BUNDLE_CASK_SKIP`, then reported, rather than
  attempted and failed.
- A privileged step runs only when it would actually change something. Compare
  the installed state first, as `libexec/install-window-manager` does before
  invoking `system/install-yabai-root`, and skip the step when it already
  matches.

`funk install-home-awake` follows the same rule. It compares the installed root
helper's digest and its granted sudo invocations first, and elevates only when
they differ from this checkout. It extends the rule to the login keychain by
probing the stored item attribute-only, without `-w`, so the lookup never
reaches the item's data and never raises a dialog, and by reporting the verdict
`home-awake` last recorded instead of reading the secret. The prompt belongs to
`home-awake --authorize`, which a human runs on purpose.

A step that cannot converge is reported rather than failed.
`funk ssh-tailnet-config` exits `EX_TEMPFAIL` when Tailscale cannot answer,
having written and removed nothing, and `./install` prints a Deferred note and
finishes.

Repair state that makes Homebrew elevate instead of letting it recur:
`libexec/reclaim-app-ownership` for applications left by a previous account,
and `libexec/repair-cask-artifacts` for Caskroom state left by an aborted
upgrade.

## AI tooling and skills

Funk no longer owns AI-toolchain installation; `~/code/agentstart` does. The
boundary rubric lives in the wiki (`agentwiki get funk-boundary`):
anything depended on by or deeply related to the agent* fleet — harness CLIs,
pinned npm globals, MCP registration, guidance links, extension prompts, and
every globally managed skill — belongs in AgentStart, and the machine itself —
Homebrew, Stow, launchd, macOS settings, account migration — stays here.

Concretely, Funk keeps the AI *desktop applications* (the claude and chatgpt
casks, converged from `./install`). `./install` then
calls `~/code/agentstart/scripts/install.sh --install` and refuses to finish
if that checkout is missing; the scheduled updater calls
`~/code/agentstart/scripts/sync-skills` the same way. Do not grow a second
installer or skill-synchronization path in this repository — a new AI tool,
skill, or harness configuration belongs in AgentStart.

Every operator guidance file the harnesses and the voice orchestrator read
is AgentStart's, linked by its installer rather than stowed here: the
deliberately empty `~/AGENTS.md` (with `~/.claude/CLAUDE.md` and
`~/.codex/AGENTS.md` linked at it), the extension prompts at
`~/.config/agentguidance/`, and the AgentVoice doctrine at
`~/.config/agentvoice/`. The `agents`, `arthack`, `agentvoice`, and `llm`
Stow packages are all gone; do not recreate one — edit
`~/code/agentstart/prompts/` or `~/code/agentstart/config/` instead.

Funk's repository guidance lives in this `AGENTS.md`, not in a priming skill.
Do not install or synchronize a separate `funk` skill.

Configuration another program writes is overlaid, never adopted. The llm CLI
and its model configuration are AgentStart's (`config/llm/`, and the formula
left the Brewfile with them). Herdr's live `config.toml` is also AgentStart's:
`scripts/herdr-config` renders it from that checkout's tracked source, while
Funk's `herdr` package retains only the machine-owned `agent-mem.sh` helper.
Adopt a file only when Funk is its sole writer.

Prove a configuration file is read before adopting it. A directory under
`~/.config` named for a program is not evidence that the program loads it —
programs move their configuration into the checkout and leave the old files
behind. Find the code path that reads the file, or leave it where it is;
adopting a retired file publishes dead configuration as live.

After changing the AI application or migration steps here, or anything in the
AgentStart-owned toolchain, run:

```sh
~/code/agentstart/scripts/install.sh --install
```

Then compare the installed `collab` manifest with its agentguidance source
template.
Do not substitute a manual copy or a second helper for this convergence check.
