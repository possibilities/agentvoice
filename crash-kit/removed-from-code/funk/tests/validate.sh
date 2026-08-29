#!/bin/bash

set -euo pipefail

root=$(cd -P -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

fail() {
    printf 'validate: %s\n' "$*" >&2
    exit 1
}

skipped=""
skip() {
    skipped="$skipped  - $1
"
    printf 'validate: SKIPPED (%s): %s\n' "$2" "$1" >&2
}

# The plists this suite checks are static XML in the repository, so they are read
# with stdlib plistlib rather than PlistBuddy and plutil. Same assertions, same
# output spellings, same exit codes — minus the macOS-only runner they required.
plist_buddy() {
    "$root/tests/lib/plist" "$@"
}

plist_lint() {
    "$root/tests/lib/plist" -lint "$@"
}

shell_files="
install
bin/funk
libexec/funk-update
libexec/converge-brewfile
libexec/converge-brew-casks
libexec/install-apple-container
libexec/release-cask-quarantine
libexec/repair-cask-artifacts
libexec/repair-cask-user-dirs
libexec/reclaim-app-ownership
libexec/list-unattendable-casks
libexec/stow-config
libexec/install-chuchu-lab-theme
libexec/android-screen-copy
libexec/install-android-launchers
libexec/install-ghostty-terminfo
libexec/initialize-configs
libexec/install-update-agent
libexec/install-tailscale-agent
libexec/install-home-awake
libexec/install-home-awake-agent
libexec/verify-local-services
libexec/install-transcript-vault-agent
libexec/install-cass-window-reset-agent
libexec/configure-macos
libexec/verify-notifications
libexec/configure-system
libexec/funk-harden-client
libexec/install-hardening
libexec/funk-yabai
libexec/reload-karabiner
libexec/install-window-manager
system/funk-harden
system/install-hardening-root
system/funk-home-awake
system/install-home-awake-root
system/funk-yabai-maintain
system/install-yabai-root
system/apply-system-settings
yabai/.config/yabai/yabairc
bin/.local/bin/tmux-cycle-session
bin/.local/bin/tmux-move-window
bin/.local/bin/focus-address-bar
bin/.local/bin/dismiss-terminal-notifier
bin/.local/bin/ginit
bin/.local/bin/ghinit
bin/.local/bin/tailscale-ensure-online
bin/.local/bin/home-awake
bin/.local/bin/ssh-tailnet-config
bin/.local/bin/git-identity
bin/.local/bin/transcript-vault
bin/.local/bin/cass-window-reset
bin/.local/bin/adb-wireless-connect
bin/.local/bin/adb-wireless-pair
bin/.local/bin/raycast/localhost-8789-kiosk.sh
tests/adb-wireless.sh
tests/apple-container-install.sh
tests/android-launchers.sh
tests/chuchu-theme.sh
tests/ghostty-terminfo.sh
tests/home-awake.sh
tests/ssh-tailnet-config.sh
tests/kiosk-launcher.sh
tests/tailscale-online.sh
tests/gog-authed.sh
tests/funk-notify.sh
tests/dismiss-terminal-notifier.sh
tests/fixtures/adb
tests/fixtures/adb-chuchu
tests/fixtures/adb-wireless-connect-chuchu
tests/fixtures/apkanalyzer-chuchu
tests/fixtures/brew
tests/fixtures/bun
tests/fixtures/gog
tests/fixtures/chrome
tests/fixtures/codex
tests/fixtures/dscacheutil
tests/fixtures/dns-sd
tests/fixtures/gh
tests/fixtures/gradlew-chuchu
tests/fixtures/home-awake/security
tests/fixtures/nc
tests/fixtures/npx
tests/fixtures/spctl
tests/fixtures/systemextensionsctl
tests/fixtures/tailscale
tests/fixtures/terminal-notifier
tests/fixtures/terminal-notifier-remove-limit
tests/fixtures/unzip-chuchu
tests/fixtures/zig
tests/validate.sh
"

# Every one of these is exec'd by path rather than passed to an interpreter: CI
# runs `tests/validate.sh` directly, the operator runs ./install, launchd execs
# the helpers. A lost executable bit turns all of that into exit 126, and it is
# invisible in a diff. This is asserted rather than assumed because it already
# happened once — validate.sh shipped 100644 and no run caught it, since the CI
# that would have was failing for an unrelated reason at the time.
for file in $shell_files; do
    /bin/bash -n "$file"
    [ -x "$file" ] || fail "shell file is not executable: $file"
done

/bin/zsh -n zsh/.zshrc
if grep -R -Eqi 'keeper|KEEPER_ZSH_DROPINS' zsh; then
    fail "removed Keeper shell integration is still present"
fi
if grep -R -Eqi 'starship' Brewfile libexec/stow-config zsh; then
    fail "removed Starship prompt integration is still present"
fi
[ ! -e starship ] || fail "removed Starship Stow package is still present"

if command -v shellcheck >/dev/null 2>&1; then
    # Errors and warnings only. The style tier is not portable across releases —
    # 0.9.0 raises 39 SC2015 notes on assertions 0.11.0 will not emit even when
    # asked for SC2015 by name — and pinning a version to stabilise it means
    # carrying a checksummed 3.7GB binary that dies on any machine with less than
    # about 4GB free. The style tier has never found anything here; errors and
    # warnings, which find real defects, are what stays fatal.
    # The checker treats the skhd DSL as shell, so it is intentionally excluded.
    # shellcheck disable=SC2086
    shellcheck --severity=warning --shell=bash $shell_files
else
    skip "shellcheck static analysis of every shell file" "shellcheck is not installed"
fi

tests/apple-container-install.sh

# A suite that reaches tailscale-ensure-online without pinning the notifier
# posts the fixture's fictional tailnet into the operator's real Notification
# Center, which reads as a genuine outage on a machine that is fine. Nothing in
# the run itself reports that, so the wiring is checked rather than the output.
for file in tests/*.sh; do
    [ "$file" != tests/validate.sh ] || continue
    grep -q 'tailscale-ensure-online\|adb-wireless-connect' "$file" || continue
    grep -q 'FUNK_TERMINAL_NOTIFIER_BIN' "$file" \
        || fail "$file drives the Tailscale helper without pinning the notifier"
done

# ./install runs with a deliberately minimal PATH, so a service check that
# probes Agentweb, Agentbrain, or Tailscale by bare name finds nothing and
# reports a healthy daemon as not answering — the shape of failure that looks
# like a broken machine and is really a broken probe.
grep -q '\.local/bin:/usr/local/bin:' libexec/verify-local-services \
    || fail "verify-local-services must resolve its CLIs outside the installer's minimal PATH"
for probe in agentweb agentbrain; do
    grep -q "command -v $probe" libexec/verify-local-services \
        || fail "verify-local-services must report a missing $probe as missing, not as an unhealthy service"
done
for label in agentbrain.worker agentweb.broker agentusage.observer; do
    grep -F "$label" libexec/verify-local-services >/dev/null \
        || fail "verify-local-services omits the AgentStart service label $label"
done
if grep -E 'agentweb\.daemon|agentusage\.daemon' \
    libexec/verify-local-services >/dev/null; then
    fail "verify-local-services still checks a retired AgentStart service label"
fi

plist_lint launchd/com.arthack.funk.update.plist.in >/dev/null
plist_lint launchd/com.arthack.funk.tailscale-online.plist.in >/dev/null
plist_lint launchd/com.arthack.funk.gog-authed.plist.in >/dev/null
plist_lint launchd/com.arthack.funk.transcript-vault.plist.in >/dev/null
plist_lint launchd/com.arthack.funk.cass-window-reset.plist.in >/dev/null
plist_lint system/com.arthack.funk.harden-boot.plist >/dev/null
plist_lint launchd/com.arthack.funk.home-awake.plist.in >/dev/null
plist_lint launchd/com.arthack.funk.home-awake-caffeinate.plist >/dev/null
update_plist=launchd/com.arthack.funk.update.plist.in
expected_update_hours='0
6
12
18'
actual_update_hours=$(
    for index in 0 1 2 3; do
        plist_buddy \
            -c "Print :StartCalendarInterval:$index:Hour" "$update_plist"
    done
)
[ "$actual_update_hours" = "$expected_update_hours" ] \
    || fail "updater does not run every six hours"
for index in 0 1 2 3; do
    [ "$(plist_buddy -c "Print :StartCalendarInterval:$index:Minute" "$update_plist")" = 0 ] \
        || fail "updater minute is not 00"
done
[ "$(plist_buddy -c 'Print :ProgramArguments:1' "$update_plist")" = update ] \
    || fail "scheduled updater does not invoke funk update"
[ "$(plist_buddy -c 'Print :ProgramArguments:2' "$update_plist")" = --notify ] \
    || fail "scheduled updater does not request a notification"
if plist_buddy -c 'Print :RunAtLoad' "$update_plist" >/dev/null 2>&1 \
    || plist_buddy -c 'Print :KeepAlive' "$update_plist" >/dev/null 2>&1; then
    fail "scheduled updater has an unapproved extra trigger"
fi

tailscale_plist=launchd/com.arthack.funk.tailscale-online.plist.in
[ "$(plist_buddy -c 'Print :RunAtLoad' "$tailscale_plist")" = true ] \
    || fail "Tailscale recovery agent does not run at login"
[ "$(plist_buddy -c 'Print :StartInterval' "$tailscale_plist")" = 300 ] \
    || fail "Tailscale recovery agent does not run every five minutes"
[ "$(plist_buddy -c 'Print :ProgramArguments:0' "$tailscale_plist")" \
    = __TAILSCALE_ENSURE_ONLINE__ ] \
    || fail "Tailscale recovery agent does not invoke the shared helper"
[ "$(plist_buddy -c 'Print :EnvironmentVariables:HOME' "$tailscale_plist")" \
    = __FUNK_HOME__ ] \
    || fail "Tailscale recovery agent does not pin the target user HOME"
if plist_buddy -c 'Print :ProgramArguments:1' "$tailscale_plist" \
    >/dev/null 2>&1 \
    || plist_buddy -c 'Print :KeepAlive' "$tailscale_plist" \
        >/dev/null 2>&1; then
    fail "Tailscale recovery agent has an unapproved argument or trigger"
fi

home_awake_plist=launchd/com.arthack.funk.home-awake.plist.in
[ "$(plist_buddy -c 'Print :RunAtLoad' "$home_awake_plist")" = true ] \
    || fail "home-awake agent does not run at login"
[ "$(plist_buddy -c 'Print :StartInterval' "$home_awake_plist")" = 30 ] \
    || fail "home-awake agent does not re-check every thirty seconds"
[ "$(plist_buddy -c 'Print :WatchPaths:0' "$home_awake_plist")" \
    = /Library/Preferences/SystemConfiguration ] \
    || fail "home-awake agent does not react to network changes"
[ "$(plist_buddy -c 'Print :ProgramArguments:0' "$home_awake_plist")" \
    = __HOME_AWAKE__ ] \
    || fail "home-awake agent does not invoke the stowed helper"
[ "$(plist_buddy -c 'Print :EnvironmentVariables:HOME' "$home_awake_plist")" \
    = __FUNK_HOME__ ] \
    || fail "home-awake agent does not pin the target user HOME"
if plist_buddy -c 'Print :ProgramArguments:1' "$home_awake_plist" \
    >/dev/null 2>&1; then
    fail "home-awake agent has an unapproved argument"
fi

caffeinate_plist=launchd/com.arthack.funk.home-awake-caffeinate.plist
[ "$(plist_buddy -c 'Print :ProgramArguments:0' "$caffeinate_plist")" \
    = /usr/bin/caffeinate ] \
    || fail "home-awake idle-sleep job does not run caffeinate"
[ "$(plist_buddy -c 'Print :ProgramArguments:1' "$caffeinate_plist")" = -i ] \
    || fail "home-awake idle-sleep job does not hold off idle sleep only"
[ "$(plist_buddy -c 'Print :KeepAlive' "$caffeinate_plist")" = true ] \
    || fail "home-awake idle-sleep job does not stay running while bootstrapped"
if plist_buddy -c 'Print :RunAtLoad' "$caffeinate_plist" >/dev/null 2>&1; then
    fail "home-awake idle-sleep job runs at load instead of on demand"
fi
# Everything in ~/Library/LaunchAgents loads at login, so this job has to be
# installed somewhere home-awake alone can bootstrap it.
# shellcheck disable=SC2016 # The installer's literal source line is the subject.
grep -F 'caffeinate_path="$state_dir/$caffeinate_label.plist"' \
    libexec/install-home-awake-agent >/dev/null \
    || fail "home-awake idle-sleep job would load at login"

# The privileged surface is exactly these five invocations; a wildcard anywhere
# else would hand the unattended agent a general-purpose root path.
expected_home_awake_rules='sleep 0
sleep 1
screenlock off
screenlock immediate
screenlock [0-9]*'
actual_home_awake_rules=$(
    grep -oE "NOPASSWD: %s [a-z]+ [^\\\\']+" system/install-home-awake-root \
        | sed 's/^NOPASSWD: %s //'
)
[ "$actual_home_awake_rules" = "$expected_home_awake_rules" ] \
    || fail "home-awake sudoers rules differ from the approved set"

# The login password those screen-lock changes authenticate with is stored
# trusting no application, so reading it costs a human decision once. Leaving -T
# out does not achieve that: security(1) says "the application which creates an
# item is trusted to access its data without warning", and the creating
# application here is security itself -- the same binary the unattended agent
# reads with. Only an explicit empty -T revokes it, so assert the flag rather
# than the absence of the grant it replaced.
grep -F -- '-T "" -l' bin/.local/bin/home-awake >/dev/null \
    || fail "home-awake stores its keychain item trusting the application that created it"
home_awake_code=$(grep -v '^[[:space:]]*#' bin/.local/bin/home-awake)
if printf '%s\n' "$home_awake_code" | grep -F -- '-T /usr/bin/security' >/dev/null; then
    fail "home-awake grants /usr/bin/security unattended access to the login password"
fi
# Revoking a grant by writing over the item would only be as good as the merge
# rules of whatever performs the write, and a revocation that silently does
# nothing is worse than none at all, because it reads as done.
printf '%s\n' "$home_awake_code" \
    | grep -F 'security delete-generic-password' >/dev/null \
    || fail "home-awake updates its keychain item in place instead of replacing it"
if printf '%s\n' "$home_awake_code" | grep -F 'add-generic-password -U' >/dev/null; then
    fail "home-awake relies on -U to replace an existing keychain access list"
fi

# shellcheck disable=SC2016 # The installer's literal source line is the subject.
grep -F '"$funk_command" install-home-awake' install >/dev/null \
    || fail "installer does not install the trusted-network agent"

transcript_vault_plist=launchd/com.arthack.funk.transcript-vault.plist.in
[ "$(plist_buddy -c 'Print :RunAtLoad' "$transcript_vault_plist")" = true ] \
    || fail "transcript vault agent does not run at login"
[ "$(plist_buddy -c 'Print :StartInterval' "$transcript_vault_plist")" = 3600 ] \
    || fail "transcript vault agent does not run hourly"
[ "$(plist_buddy -c 'Print :ProgramArguments:0' "$transcript_vault_plist")" \
    = __TRANSCRIPT_VAULT__ ] \
    || fail "transcript vault agent does not invoke the stowed helper"
[ "$(plist_buddy -c 'Print :EnvironmentVariables:HOME' "$transcript_vault_plist")" \
    = __FUNK_HOME__ ] \
    || fail "transcript vault agent does not pin the target user HOME"
if plist_buddy -c 'Print :ProgramArguments:1' "$transcript_vault_plist" \
    >/dev/null 2>&1 \
    || plist_buddy -c 'Print :KeepAlive' "$transcript_vault_plist" \
        >/dev/null 2>&1; then
    fail "transcript vault agent has an unapproved argument or trigger"
fi

# The vault exists to preserve transcripts; nothing in it may ever delete
# archive or repository content, and its snapshots must stay identifiable.
if sed 's/#.*//' bin/.local/bin/transcript-vault \
    | grep -E -- '--delete|restic forget|restic prune' >/dev/null; then
    fail "transcript vault contains a deletion path"
fi
grep -q -- '--tag claude-transcripts' bin/.local/bin/transcript-vault \
    || fail "transcript vault snapshots are not tagged"

# shellcheck disable=SC2016 # The installer's literal source line is the subject.
grep -F '"$funk_command" install-transcript-vault' install >/dev/null \
    || fail "installer does not install the transcript vault agent"

# The window reset keeps cass bounded to the live stores; it discards only
# derived index state and must never reach the archive or the repositories.
window_reset_plist=launchd/com.arthack.funk.cass-window-reset.plist.in
[ "$(plist_buddy -c 'Print :RunAtLoad' "$window_reset_plist")" = false ] \
    || fail "cass window reset agent must not fire at every login"
[ "$(plist_buddy -c 'Print :StartCalendarInterval:Day' "$window_reset_plist")" = 1 ] \
    || fail "cass window reset agent is not monthly"
[ "$(plist_buddy -c 'Print :ProgramArguments:0' "$window_reset_plist")" \
    = __CASS_WINDOW_RESET__ ] \
    || fail "cass window reset agent does not invoke the stowed helper"
if plist_buddy -c 'Print :StartInterval' "$window_reset_plist" >/dev/null 2>&1 \
    || plist_buddy -c 'Print :KeepAlive' "$window_reset_plist" >/dev/null 2>&1; then
    fail "cass window reset agent has an unapproved trigger"
fi
if sed 's/#.*//' bin/.local/bin/cass-window-reset \
    | grep -E 'claude-archive|restic' >/dev/null; then
    fail "cass window reset reaches preservation paths"
fi

# shellcheck disable=SC2016 # The installer's literal source line is the subject.
grep -F '"$funk_command" install-cass-window-reset' install >/dev/null \
    || fail "installer does not install the cass window reset agent"

if command -v ruby >/dev/null 2>&1; then
    ruby -rjson -e '
      data = JSON.parse(File.read(ARGV.fetch(0)))
      rules = data.fetch("profiles").fetch(0)
                  .fetch("complex_modifications").fetch("rules")
      abort "unexpected Karabiner rule count" unless rules.length == 5
      abort "unexpected Karabiner manipulator counts" unless rules.map { |r| r.fetch("manipulators").length } == [9, 9, 4, 2, 1]

      browser_ids = [
        "^com\\.google\\.Chrome$",
        "^com\\.google\\.Chrome\\.canary$",
        "^com\\.brave\\.Browser$",
        "^org\\.mozilla\\.firefox$"
      ]
      browser_rules = rules.fetch(0).fetch("manipulators")
      abort "unexpected Karabiner browser applications" unless browser_rules.all? { |m|
        m.fetch("conditions").fetch(0).fetch("bundle_identifiers") == browser_ids
      }

      focus_keys = rules.fetch(1).fetch("manipulators").map { |m| m.fetch("to").fetch(0).fetch("key_code") }
      abort "unexpected Karabiner Space focus keys" unless focus_keys == %w[f13 f14 f15 f16 f17 f18 f19 f20 f12]

      arrow_rules = rules.fetch(2).fetch("manipulators")
      abort "unexpected Karabiner arrow sources" unless arrow_rules.map { |m| m.dig("from", "key_code") } == %w[h j k l]
      abort "unexpected Karabiner arrow targets" unless arrow_rules.map { |m| m.dig("to", 0, "key_code") } == %w[left_arrow down_arrow up_arrow right_arrow]
      abort "Right Option arrow modifiers do not preserve Shift" unless arrow_rules.all? { |m|
        m.dig("from", "modifiers") == {
          "mandatory" => ["right_option"],
          "optional" => ["shift"]
        }
      }

      swap_rules = rules.fetch(3).fetch("manipulators")
      abort "unexpected built-in modifier swap" unless swap_rules.map { |m|
        [m.dig("from", "key_code"), m.dig("to", 0, "key_code")]
      } == [["left_command", "left_option"], ["left_option", "left_command"]]
      abort "modifier swap is not limited to the built-in keyboard" unless swap_rules.all? { |m|
        m.dig("conditions", 0, "type") == "device_if" &&
          m.dig("conditions", 0, "identifiers") == [{ "is_built_in_keyboard" => true }]
      }

      caps_rule = rules.fetch(4).fetch("manipulators").fetch(0)
      abort "Caps Lock does not send Escape" unless
        caps_rule.dig("from", "key_code") == "caps_lock" &&
        caps_rule.dig("to", 0, "key_code") == "escape"
    ' \
        karabiner/.config/karabiner/karabiner.json
elif command -v jq >/dev/null 2>&1; then
    jq -e '
      (.profiles[0].complex_modifications.rules | length) == 5 and
      ([.profiles[0].complex_modifications.rules[].manipulators | length] == [9, 9, 4, 2, 1]) and
      (all(.profiles[0].complex_modifications.rules[0].manipulators[];
        .conditions[0].bundle_identifiers ==
          ["^com\\.google\\.Chrome$", "^com\\.google\\.Chrome\\.canary$",
           "^com\\.brave\\.Browser$", "^org\\.mozilla\\.firefox$"])) and
      ([.profiles[0].complex_modifications.rules[1].manipulators[].to[0].key_code] ==
        ["f13", "f14", "f15", "f16", "f17", "f18", "f19", "f20", "f12"]) and
      ([.profiles[0].complex_modifications.rules[2].manipulators[].from.key_code] ==
        ["h", "j", "k", "l"]) and
      ([.profiles[0].complex_modifications.rules[2].manipulators[].to[0].key_code] ==
        ["left_arrow", "down_arrow", "up_arrow", "right_arrow"]) and
      (all(.profiles[0].complex_modifications.rules[2].manipulators[];
        .from.modifiers == {"mandatory": ["right_option"], "optional": ["shift"]})) and
      ([.profiles[0].complex_modifications.rules[3].manipulators[] |
        [.from.key_code, .to[0].key_code]] ==
        [["left_command", "left_option"], ["left_option", "left_command"]]) and
      (all(.profiles[0].complex_modifications.rules[3].manipulators[];
        .conditions[0] ==
          {"type": "device_if", "identifiers": [{"is_built_in_keyboard": true}]})) and
      (.profiles[0].complex_modifications.rules[4].manipulators[0].from.key_code ==
        "caps_lock") and
      (.profiles[0].complex_modifications.rules[4].manipulators[0].to[0].key_code ==
        "escape")
    ' karabiner/.config/karabiner/karabiner.json >/dev/null
else
    fail "Ruby or jq is required to validate Karabiner JSON"
fi

expected_brewfile='tap "asmvik/formulae"
tap "oven-sh/bun"
tap "openclaw/tap"
brew "git-delta"
brew "bat"
brew "neovim"
brew "tmux"
brew "nvm"
brew "gh"
brew "azure-cli"
brew "jq"
brew "docker"
brew "docker-buildx"
# pdftotext, required by Agentscrape and Agentbrain to read PDFs.
brew "poppler"
brew "terminal-notifier"
brew "yq"
# Snapshots the Claude Code transcript archive to silverbird (transcript-vault).
brew "restic"
brew "ripgrep"
brew "fzf"
brew "btop"
brew "uv"
brew "stow"
brew "pnpm"
brew "oven-sh/bun/bun", trusted: true
brew "zig"
brew "scrcpy"
brew "asmvik/formulae/yabai", trusted: true
brew "asmvik/formulae/skhd", trusted: true
brew "openclaw/tap/gogcli", trusted: true
cask "tailscale-app", greedy: true
cask "alt-tab", greedy: true
cask "ghostty", greedy: true
cask "google-chrome", greedy: true
cask "google-chrome@canary", greedy: true
cask "brave-browser", greedy: true
cask "firefox", greedy: true
cask "obs", greedy: true
cask "obsidian", greedy: true
cask "raycast", greedy: true
cask "android-platform-tools", greedy: true
cask "karabiner-elements", greedy: true
cask "font-0xproto-nerd-font", greedy: true
cask "finetune", greedy: true'
actual_brewfile=$(grep -Ev '^[[:space:]]*$' Brewfile)
[ "$actual_brewfile" = "$expected_brewfile" ] \
    || fail "Brewfile declarations differ from the approved set"

if command -v brew >/dev/null 2>&1; then
    HOMEBREW_NO_AUTO_UPDATE=1 brew bundle list --file=Brewfile --formula >/dev/null
    HOMEBREW_NO_AUTO_UPDATE=1 brew bundle list --file=Brewfile --cask >/dev/null
fi

update_test_dir=$(mktemp -d "${TMPDIR:-/tmp}/funk-update-test.XXXXXX")
# The scheduled updater delegates skill synchronization to the AgentStart
# checkout, so these tests exercise the real sibling scripts against the
# fixture stubs. Resolve it from the real HOME before any test overrides it;
# a machine without the checkout cannot validate Funk, by design.
update_agentstart_root="${FUNK_AGENTSTART_ROOT:-$HOME/code/agentstart}"
[ -x "$update_agentstart_root/scripts/sync-skills" ] \
    || fail "Funk requires the AgentStart checkout to validate: $update_agentstart_root"
# AgentStart's real sync-skills path is Darwin-gated, so the behavioral updater
# test remains macOS-only. Static wiring and safety assertions still run in CI.
if [ "$(uname -s)" = Darwin ]; then
update_home="$update_test_dir/home"
update_state="$update_test_dir/brew-state"
update_brew_log="$update_test_dir/brew.log"
update_npx_log="$update_test_dir/npx.log"
update_notifier_log="$update_test_dir/notifier.log"
update_code_root="$update_test_dir/code"
update_resources_root="$update_test_dir/resources"
update_brew_prefix="$update_test_dir/prefix"
update_node_bin=$(command -v node) \
    || fail "AgentStart's capability renderer requires node for the updater integration test"
mkdir -p \
    "$update_home" \
    "$update_code_root/agentfixture/skills/fixture" \
    "$update_brew_prefix/bin"
# funk-update prepends Homebrew's bin directory to launchd's minimal PATH. Seed
# the fake prefix the same way so AgentStart's Node-based policy renderer tests
# the production path contract instead of inheriting the invoking shell's PATH.
ln -s "$update_node_bin" "$update_brew_prefix/bin/node"
printf '%s\n' '---' 'name: fixture' '---' '# Fixture' \
    >"$update_code_root/agentfixture/skills/fixture/SKILL.md"
# The real AgentStart renderer now follows synchronization by building the
# fixed private resource set. The npx fixture records the requested skill copy
# rather than performing it, so seed the same copied skill and isolate the
# renderer from the operator's live resources and Codex plugin state.
mkdir -p "$update_resources_root/skills/fixture"
cp "$update_code_root/agentfixture/skills/fixture/SKILL.md" \
    "$update_resources_root/skills/fixture/SKILL.md"
export AGENTSTART_RESOURCES_ROOT="$update_resources_root"
export AGENTSTART_CODEX_BIN="$root/tests/fixtures/codex"
printf '%s\n' $'formula:terminal-notifier\t1.0.0' >"$update_state"
: >"$update_npx_log"
set +e
update_output=$(
    HOME="$update_home" \
        FUNK_AGENTSTART_ROOT="$update_agentstart_root" \
        AGENTSTART_CODE_ROOT="$update_code_root" \
        AGENTSTART_NPX_BIN="$root/tests/fixtures/npx" \
        PATH="$root/tests/fixtures:/usr/bin:/bin:/usr/sbin:/sbin" \
        FUNK_TEST_BREW_EXIT=23 \
        FUNK_TEST_BREW_PREFIX="$update_brew_prefix" \
        FUNK_TEST_BREW_STATE="$update_state" \
        FUNK_TEST_BREW_LOG="$update_brew_log" \
        FUNK_TEST_NPX_LOG="$update_npx_log" \
        FUNK_SPCTL_BIN="$root/tests/fixtures/spctl" \
        "$root/bin/funk" update 2>&1
)
update_status=$?
set -e
[ "$update_status" -eq 23 ] || fail "funk update did not propagate brew exit 23"
grep -F "brew-stub <bundle> <install> <--upgrade> <--file=$root/Brewfile>" \
    "$update_brew_log" >/dev/null \
    || fail "funk update did not explicitly request Brewfile upgrades"
printf '%s\n' "$update_output" | grep -F 'FAILED with exit status 23' >/dev/null \
    || fail "funk update did not log failure"
[ ! -s "$update_npx_log" ] \
    || fail "funk update ran skill synchronization after a Brewfile failure"
HOME="$update_home" \
    FUNK_AGENTSTART_ROOT="$update_agentstart_root" \
    AGENTSTART_CODE_ROOT="$update_code_root" \
    AGENTSTART_NPX_BIN="$root/tests/fixtures/npx" \
    PATH="$root/tests/fixtures:/usr/bin:/bin:/usr/sbin:/sbin" \
    FUNK_TEST_BREW_EXIT=0 \
    FUNK_TEST_BREW_PREFIX="$update_brew_prefix" \
    FUNK_TEST_BREW_STATE="$update_state" \
    FUNK_TEST_BREW_LOG="$update_brew_log" \
    FUNK_TEST_FORMULA_NEW=2.0.0 \
    FUNK_TEST_NPX_LOG="$update_npx_log" \
    FUNK_TEST_NOTIFIER_LOG="$update_notifier_log" \
    FUNK_TERMINAL_NOTIFIER_BIN="$root/tests/fixtures/terminal-notifier" \
    FUNK_SPCTL_BIN="$root/tests/fixtures/spctl" \
    "$root/bin/funk" update --notify >/dev/null
notification=$(grep -F '<Funk Update>' "$update_notifier_log" | tail -n 1)
printf '%s\n' "$notification" | grep -F 'terminal-notifier 1.0.0 → 2.0.0' >/dev/null \
    || fail "change-aware notification omitted the upgraded formula"
grep -F 'npx-stub <--yes> <skills> <add>' "$update_npx_log" >/dev/null \
    || fail "scheduled update did not synchronize fleet skills"
: >"$update_notifier_log"
HOME="$update_home" \
    FUNK_AGENTSTART_ROOT="$update_agentstart_root" \
    AGENTSTART_CODE_ROOT="$update_code_root" \
    AGENTSTART_NPX_BIN="$root/tests/fixtures/npx" \
    PATH="$root/tests/fixtures:/usr/bin:/bin:/usr/sbin:/sbin" \
    FUNK_TEST_BREW_EXIT=0 \
    FUNK_TEST_BREW_PREFIX="$update_brew_prefix" \
    FUNK_TEST_BREW_STATE="$update_state" \
    FUNK_TEST_BREW_LOG="$update_brew_log" \
    FUNK_TEST_FORMULA_NEW=2.0.0 \
    FUNK_TEST_NPX_LOG="$update_npx_log" \
    FUNK_TEST_NOTIFIER_LOG="$update_notifier_log" \
    FUNK_TERMINAL_NOTIFIER_BIN="$root/tests/fixtures/terminal-notifier" \
    FUNK_SPCTL_BIN="$root/tests/fixtures/spctl" \
    "$root/bin/funk" update --notify >/dev/null
grep -F '<-message> <Installer ran; no updates.>' "$update_notifier_log" >/dev/null \
    || fail "no-op scheduled update did not send the required concise notification"

: >"$update_notifier_log"
set +e
update_output=$(
        HOME="$update_home" \
        FUNK_AGENTSTART_ROOT="$update_agentstart_root" \
        AGENTSTART_CODE_ROOT="$update_code_root" \
        PATH="$root/tests/fixtures:/usr/bin:/bin:/usr/sbin:/sbin" \
        FUNK_TEST_BREW_EXIT=0 \
        FUNK_TEST_BREW_PREFIX="$update_brew_prefix" \
        FUNK_TEST_BREW_STATE="$update_state" \
        FUNK_TEST_BREW_LOG="$update_brew_log" \
        FUNK_TEST_NPX_LOG="$update_npx_log" \
        FUNK_TEST_NPX_EXIT=17 \
        FUNK_TEST_NOTIFIER_LOG="$update_notifier_log" \
        AGENTSTART_NPX_BIN="$root/tests/fixtures/npx" \
        FUNK_TERMINAL_NOTIFIER_BIN="$root/tests/fixtures/terminal-notifier" \
        FUNK_SPCTL_BIN="$root/tests/fixtures/spctl" \
        "$root/bin/funk" update --notify 2>&1
)
update_status=$?
set -e
[ "$update_status" -eq 1 ] \
    || fail "funk update did not propagate an installer failure"
printf '%s\n' "$update_output" | grep -F 'FAILED with exit status 1' >/dev/null \
    || fail "funk update did not log the installer failure"
grep -F 'npx-stub <--yes> <skills> <add>' "$update_npx_log" >/dev/null \
    || fail "installer failure test did not reach a skill installer"
failure_notification=$(tail -n 1 "$update_notifier_log")
printf '%s\n' "$failure_notification" | grep -F '<-title> <Funk Update Failed>' >/dev/null \
    || fail "installer failure did not send the failure notification"
printf '%s\n' "$failure_notification" \
    | grep -F '<-message> <Installer failed; no updates completed. See update.log.>' \
        >/dev/null \
    || fail "installer failure notification omitted the log pointer"
else
    skip "funk update behaviour (Homebrew convergence, skill sync, notifications)" \
        "needs macOS: AgentStart sync-skills is Darwin-gated"
fi

# The skill synchronization behavior itself is AgentStart's and is asserted by
# ~/code/agentstart/tests/validate.sh. Funk asserts only its own wiring: the
# scheduled updater must preflight and invoke the AgentStart sync path.
# shellcheck disable=SC2016 # Match the literal declaration in the script.
grep -F 'skill_sync="$agentstart_root/scripts/sync-skills"' \
    libexec/funk-update >/dev/null \
    || fail "scheduled updater does not preflight the AgentStart skill sync"
# shellcheck disable=SC2016 # Match the literal default checkout resolution.
grep -F 'agentstart_root="${FUNK_AGENTSTART_ROOT:-$HOME/code/agentstart}"' \
    libexec/funk-update >/dev/null \
    || fail "scheduled updater does not resolve the AgentStart checkout"
# shellcheck disable=SC2016 # Match the literal helper invocation in the script.
grep -F '"$skill_sync" || status=$?' libexec/funk-update >/dev/null \
    || fail "scheduled updater does not synchronize the globally managed skills"
# Gatekeeper quarantine is a macOS kernel feature: these assertions write and
# read real com.apple.quarantine xattrs, so there is nothing to port. On any
# other platform the block is skipped out loud rather than silently.
if [ "$(uname -s)" = Darwin ] && [ -x /usr/bin/xattr ]; then
    quarantine_home="$update_test_dir/quarantine-home"
    quarantine_app="$quarantine_home/Applications/Funk Test.app"
    quarantine_info="$update_test_dir/cask-info.json"
    quarantine_spctl_log="$update_test_dir/spctl.log"
    mkdir -p "$quarantine_app/Contents"
    quarantine_app_canonical=$(
        cd -P -- "$(dirname -- "$quarantine_app")" && pwd
    )
    quarantine_app_canonical="$quarantine_app_canonical/$(basename -- "$quarantine_app")"
    touch "$quarantine_app/Contents/test"
    /usr/bin/xattr -w com.apple.quarantine '0081;funk-test' "$quarantine_app"
    /usr/bin/xattr -w com.apple.quarantine '0081;funk-test' "$quarantine_app/Contents/test"
    /usr/bin/jq -n --arg target "$quarantine_app" \
        '{casks:[{artifacts:[{app:["Funk Test.app"],target:$target}]}]}' \
        >"$quarantine_info"
    HOME="$quarantine_home" \
        PATH="$root/tests/fixtures:/usr/bin:/bin:/usr/sbin:/sbin" \
        FUNK_TEST_CASK_INFO="$quarantine_info" \
        FUNK_TEST_SPCTL_LOG="$quarantine_spctl_log" \
        FUNK_SPCTL_BIN="$root/tests/fixtures/spctl" \
        "$root/libexec/release-cask-quarantine" funk-test >/dev/null
    grep -F "spctl-stub <--assess> <--type> <execute> <$quarantine_app_canonical>" \
        "$quarantine_spctl_log" >/dev/null \
        || fail "cask helper did not Gatekeeper-assess the exact declared app"
    remaining_quarantine=$(
        /usr/bin/xattr -pr com.apple.quarantine "$quarantine_app" 2>/dev/null || true
    )
    [ -z "$remaining_quarantine" ] \
        || fail "scoped cask helper left quarantine on a declared app artifact"

    /usr/bin/xattr -w com.apple.quarantine '0081;funk-test' "$quarantine_app"
    set +e
    HOME="$quarantine_home" \
        PATH="$root/tests/fixtures:/usr/bin:/bin:/usr/sbin:/sbin" \
        FUNK_TEST_CASK_INFO="$quarantine_info" \
        FUNK_TEST_SPCTL_EXIT=42 \
        FUNK_SPCTL_BIN="$root/tests/fixtures/spctl" \
        "$root/libexec/release-cask-quarantine" rejected-test >/dev/null 2>&1
    gatekeeper_status=$?
    set -e
    [ "$gatekeeper_status" -ne 0 ] \
        || fail "cask helper ignored a failed Gatekeeper assessment"
    /usr/bin/xattr -p com.apple.quarantine "$quarantine_app" >/dev/null \
        || fail "cask helper removed quarantine after Gatekeeper rejection"

    outside_app="$update_test_dir/Outside.app"
    mkdir -p "$outside_app"
    /usr/bin/xattr -w com.apple.quarantine '0081;funk-test' "$outside_app"
    /usr/bin/jq -n --arg target "$outside_app" \
        '{casks:[{artifacts:[{app:["Outside.app"],target:$target}]}]}' \
        >"$quarantine_info"
    set +e
    HOME="$quarantine_home" \
        PATH="$root/tests/fixtures:/usr/bin:/bin:/usr/sbin:/sbin" \
        FUNK_TEST_CASK_INFO="$quarantine_info" \
        FUNK_SPCTL_BIN="$root/tests/fixtures/spctl" \
        "$root/libexec/release-cask-quarantine" hostile-test >/dev/null 2>&1
    outside_status=$?
    set -e
    [ "$outside_status" -ne 0 ] \
        || fail "cask quarantine helper accepted an app outside approved directories"
    /usr/bin/xattr -p com.apple.quarantine "$outside_app" >/dev/null \
        || fail "cask quarantine helper modified a rejected target"
else
    skip "cask Gatekeeper quarantine release (libexec/release-cask-quarantine)" \
        "needs macOS com.apple.quarantine xattrs"
fi


# The Homebrew cask helpers read ownership with BSD `stat -f`, and the --check
# entry points below probe macOS system state. Both are correct for what Funk
# is — a macOS machine — and neither has a portable form worth inventing, so
# this half runs where it means something. The greps asserting what these
# helpers may never do (broad sudo, deletion paths) are static and still run.
# Body left at column 0: it contains heredocs.
if [ "$(uname -s)" = Darwin ]; then
# An upgrade that aborts after Homebrew's backup step leaves a real directory in
# the Caskroom where a completed install leaves a symlink to the app. Homebrew
# then fails every later upgrade of that cask, so the repair helper must restore
# the symlink whenever the installed application is still in place.
repair_home="$update_test_dir/repair-home"
repair_prefix="$update_test_dir/repair-prefix"
repair_info="$update_test_dir/repair-info.json"
repair_target="$repair_home/Applications/Funk Repair.app"
repair_backup="$repair_prefix/Caskroom/funk-repair/1.0.0/Funk Repair.app"
mkdir -p "$repair_target/Contents" "$repair_backup/Contents"
touch "$repair_target/Contents/live" "$repair_backup/Contents/stale"
/usr/bin/jq -n --arg target "$repair_target" \
    '{casks:[{token:"funk-repair",installed:"1.0.0",
              artifacts:[{app:["Funk Repair.app"],target:$target}]}]}' \
    >"$repair_info"
HOME="$repair_home" \
    FUNK_BREW_BIN="$root/tests/fixtures/brew" \
    FUNK_TEST_BREW_PREFIX="$repair_prefix" \
    FUNK_TEST_CASK_INFO="$repair_info" \
    "$root/libexec/repair-cask-artifacts" funk-repair >/dev/null \
    || fail "cask repair helper failed on an aborted-upgrade backup"
[ -L "$repair_backup" ] \
    || fail "cask repair helper did not replace the stale backup with a symlink"
repair_target_canonical=$(cd -P -- "$(dirname -- "$repair_target")" && pwd)
repair_target_canonical="$repair_target_canonical/$(basename -- "$repair_target")"
[ "$(readlink "$repair_backup")" = "$repair_target_canonical" ] \
    || fail "cask repair helper linked the Caskroom at the wrong target"
[ -f "$repair_target/Contents/live" ] \
    || fail "cask repair helper modified the installed application"

# A healthy Caskroom is already a symlink and must be left exactly as it is.
HOME="$repair_home" \
    FUNK_BREW_BIN="$root/tests/fixtures/brew" \
    FUNK_TEST_BREW_PREFIX="$repair_prefix" \
    FUNK_TEST_CASK_INFO="$repair_info" \
    "$root/libexec/repair-cask-artifacts" funk-repair >/dev/null \
    || fail "cask repair helper was not idempotent"
[ -L "$repair_backup" ] && [ -f "$repair_target/Contents/live" ] \
    || fail "cask repair helper disturbed an already-linked cask"

# Without the installed application the Caskroom copy is the only one left, so
# the helper must leave it for Homebrew instead of deleting or relinking it.
rm -rf "$repair_target" "$repair_backup"
mkdir -p "$repair_backup/Contents"
touch "$repair_backup/Contents/only-copy"
HOME="$repair_home" \
    FUNK_BREW_BIN="$root/tests/fixtures/brew" \
    FUNK_TEST_BREW_PREFIX="$repair_prefix" \
    FUNK_TEST_CASK_INFO="$repair_info" \
    "$root/libexec/repair-cask-artifacts" funk-repair >/dev/null 2>&1 \
    || fail "cask repair helper failed when the installed application was absent"
[ -f "$repair_backup/Contents/only-copy" ] && [ ! -L "$repair_backup" ] \
    || fail "cask repair helper destroyed the only remaining copy of an app"

# The helper deletes directories, so an artifact target outside an approved
# Applications directory must be refused rather than followed.
repair_outside="$update_test_dir/Repair Outside.app"
repair_outside_backup="$repair_prefix/Caskroom/funk-repair/1.0.0/Repair Outside.app"
mkdir -p "$repair_outside" "$repair_outside_backup/Contents"
touch "$repair_outside_backup/Contents/stale"
/usr/bin/jq -n --arg target "$repair_outside" \
    '{casks:[{token:"funk-repair",installed:"1.0.0",
              artifacts:[{app:["Repair Outside.app"],target:$target}]}]}' \
    >"$repair_info"
set +e
HOME="$repair_home" \
    FUNK_BREW_BIN="$root/tests/fixtures/brew" \
    FUNK_TEST_BREW_PREFIX="$repair_prefix" \
    FUNK_TEST_CASK_INFO="$repair_info" \
    "$root/libexec/repair-cask-artifacts" funk-repair >/dev/null 2>&1
repair_outside_status=$?
set -e
[ "$repair_outside_status" -ne 0 ] \
    || fail "cask repair helper accepted an app outside approved directories"
[ -d "$repair_outside" ] && [ ! -L "$repair_outside" ] \
    || fail "cask repair helper modified a rejected target"
[ -f "$repair_outside_backup/Contents/stale" ] \
    || fail "cask repair helper deleted a backup before rejecting its target"

# The scheduled LaunchAgent has no terminal, so a cask that installs a pkg or
# has a removal step Homebrew may elevate must be named for
# HOMEBREW_BUNDLE_CASK_SKIP instead of failing the whole scheduled path.
unattendable_info="$update_test_dir/unattendable-info.json"
unattendable_home="$update_test_dir/unattendable-home"
mkdir -p "$unattendable_home/Applications"
/usr/bin/jq -n '{casks:[
    {token:"funk-pkg",installed:"1.0.0",artifacts:[{pkg:["Funk.pkg"]}]},
    {token:"funk-sudo-script",installed:"1.0.0",
     artifacts:[{uninstall:[{early_script:{executable:"/x",sudo:true}}]}]},
    {token:"funk-zap-sudo",installed:"1.0.0",
     artifacts:[{zap:[{script:{executable:"/x",sudo:true}}]}]},
    {token:"funk-delete",installed:"1.0.0",
     artifacts:[{uninstall:[{delete:"/Library/Funk"}]}]},
    {token:"funk-pkgutil",installed:"1.0.0",
     artifacts:[{uninstall:[{pkgutil:"com.example.funk"}]}]},
    {token:"funk-kext",installed:"1.0.0",
     artifacts:[{uninstall:[{kext:"com.example.funk"}]}]},
    {token:"funk-launchctl",installed:"1.0.0",
     artifacts:[{uninstall:[{launchctl:"com.example.funk"}]}]},
    {token:"funk-rmdir",installed:"1.0.0",
     artifacts:[{uninstall:[{rmdir:"/Library/Funk"}]}]},
    {token:"funk-zap-removal",installed:"1.0.0",
     artifacts:[{zap:[{delete:"/Library/Funk",launchctl:"com.example.funk",
                       rmdir:"/Library/Funk"}]}]},
    {token:"funk-plain-script",installed:"1.0.0",
     artifacts:[{uninstall:[{script:{executable:"/x"}}]}]},
    {token:"funk-ordinary",installed:"1.0.0",
     artifacts:[{app:["Funk Ordinary.app"]}]}
]}' >"$unattendable_info"
unattendable=$(
    HOME="$unattendable_home" \
        FUNK_BREW_BIN="$root/tests/fixtures/brew" \
        FUNK_TEST_BREW_PREFIX="$repair_prefix" \
        FUNK_TEST_CASK_INFO="$unattendable_info" \
        "$root/libexec/list-unattendable-casks" funk-ordinary
)
expected_unattendable='funk-delete
funk-kext
funk-launchctl
funk-pkg
funk-pkgutil
funk-rmdir
funk-sudo-script
funk-zap-sudo'
[ "$unattendable" = "$expected_unattendable" ] \
    || fail "unattendable cask triage did not match the required set: $unattendable"

# A cask installed under a previous account records that account's user
# directories forever, so Homebrew hunts for the old version's artifacts in a
# home this account cannot read and fails the whole unattended run reporting
# only that a source file "is not there". The scheduled path skips those too,
# because repairing one is a reinstall and an unattended run is the wrong place
# to remove a working cask on the chance the reinstall succeeds.
user_dirs_home="$update_test_dir/user-dirs-home"
user_dirs_info="$update_test_dir/user-dirs-info.json"
mkdir -p "$user_dirs_home"
/usr/bin/jq -n '{casks:[
    {token:"funk-font-foreign",installed:"1.0.0",artifacts:[{font:["Funk.ttf"]}]},
    {token:"funk-font-mine",installed:"1.0.0",artifacts:[{font:["Mine.ttf"]}]},
    {token:"funk-app-foreign",installed:"1.0.0",artifacts:[{app:["Funk App.app"]}]}
]}' >"$user_dirs_info"
for user_dirs_token in funk-font-foreign funk-font-mine funk-app-foreign; do
    mkdir -p "$repair_prefix/Caskroom/$user_dirs_token/.metadata"
done
printf '{"default":{"fontdir":"/Users/someone-else/Library/Fonts"}}' \
    >"$repair_prefix/Caskroom/funk-font-foreign/.metadata/config.json"
printf '{"default":{"fontdir":"%s/Library/Fonts"}}' "$user_dirs_home" \
    >"$repair_prefix/Caskroom/funk-font-mine/.metadata/config.json"
printf '{"default":{"fontdir":"/Users/someone-else/Library/Fonts"}}' \
    >"$repair_prefix/Caskroom/funk-app-foreign/.metadata/config.json"
stale_user_dirs=$(
    HOME="$user_dirs_home" \
        FUNK_BREW_BIN="$root/tests/fixtures/brew" \
        FUNK_TEST_BREW_PREFIX="$repair_prefix" \
        FUNK_TEST_CASK_INFO="$user_dirs_info" \
        "$root/libexec/repair-cask-user-dirs" --list \
            funk-font-foreign funk-font-mine funk-app-foreign
)
# Only the font cask recording another home: a cask whose recorded directories
# this account owns converges normally, and an .app cask never installs into a
# user directory at all, so its recorded paths are inert.
[ "$stale_user_dirs" = 'funk-font-foreign' ] \
    || fail "cask user-dir triage did not match the required set: $stale_user_dirs"
# --list is what the scheduled path consumes, so it must report rather than
# exit nonzero the way --check does for an interactive caller.
HOME="$user_dirs_home" \
    FUNK_BREW_BIN="$root/tests/fixtures/brew" \
    FUNK_TEST_BREW_PREFIX="$repair_prefix" \
    FUNK_TEST_CASK_INFO="$user_dirs_info" \
    "$root/libexec/repair-cask-user-dirs" --list funk-font-foreign >/dev/null \
    || fail "cask user-dir triage exited nonzero when it found affected casks"

# Ownership reclamation must stay silent when every application already belongs
# to this account, so ./install never asks for a password it does not need.
ownership_home="$update_test_dir/ownership-home"
ownership_info="$update_test_dir/ownership-info.json"
ownership_app="$ownership_home/Applications/Funk Owned.app"
mkdir -p "$ownership_app/Contents"
/usr/bin/jq -n --arg target "$ownership_app" \
    '{casks:[{token:"funk-owned",installed:"1.0.0",
              artifacts:[{app:["Funk Owned.app"],target:$target}]}]}' \
    >"$ownership_info"
ownership_casks=$(
    HOME="$ownership_home" \
        FUNK_BREW_BIN="$root/tests/fixtures/brew" \
        FUNK_TEST_CASK_INFO="$ownership_info" \
        "$root/libexec/reclaim-app-ownership" --list-casks funk-owned
)
[ -z "$ownership_casks" ] \
    || fail "ownership helper flagged an application this account already owns"
HOME="$ownership_home" \
    FUNK_BREW_BIN="$root/tests/fixtures/brew" \
    FUNK_TEST_CASK_INFO="$ownership_info" \
    "$root/libexec/reclaim-app-ownership" --check funk-owned >/dev/null \
    || fail "ownership helper failed its no-op check"

rm -rf "$update_test_dir"

"$root/bin/funk" install-updater --check >/dev/null
"$root/bin/funk" install-tailscale-recovery --check >/dev/null
"$root/bin/funk" configure-macos --check
"$root/bin/funk" verify-notifications --check
else
    skip "Homebrew cask helpers and --check entry points (repair, unattendable, user-dirs, ownership)" \
        "needs macOS: BSD stat -f and live system probes"
fi

stow_home=$(mktemp -d "${TMPDIR:-/tmp}/funk-stow-test.XXXXXX")
trap 'rm -rf "$stow_home"' EXIT
HOME="$stow_home" "$root/bin/funk" stow
[ -L "$stow_home/.config/git/config" ] || fail "git package was not stowed"
[ -L "$stow_home/.ssh/config" ] || fail "ssh config was not stowed"
# The tailnet host files are generated onto the machine from live Tailscale
# state, so Stow must never create or own that directory. The ssh package is
# --no-folding exactly so ~/.ssh can be a real directory holding both the one
# file Funk tracks and a config.d it does not.
[ ! -e "$stow_home/.ssh/config.d" ] \
    || fail "the tailnet host directory was stowed; it is generated, not tracked"
[ -d "$stow_home/.ssh" ] && [ ! -L "$stow_home/.ssh" ] \
    || fail "ssh package did not use --no-folding"

# Identity is the operator's, not the repository's. A tracked name or address
# is published on sight, and worse, silently authors a fork's commits as this
# repository's owner. It lives in an untracked config.local that the tracked
# file includes — which only lands outside the checkout while the git package
# is --no-folding, because a relative include resolves against the directory of
# the link git opened. Folded, ~/.config/git IS the repository, so both halves
# are asserted here: no identity in the tracked file, and a real directory to
# hold the untracked one.
if grep -Eq '^[[:space:]]*(name|email)[[:space:]]*=' git/.config/git/config; then
    fail "the tracked git config carries an identity; funk git-identity owns that"
fi
grep -F 'path = ~/.config/git/config.local' git/.config/git/config >/dev/null \
    || fail "the tracked git config does not include the local identity file"
[ -d "$stow_home/.config/git" ] && [ ! -L "$stow_home/.config/git" ] \
    || fail "git package did not use --no-folding; config.local would land in the repository"
[ -L "$stow_home/.config/git/config" ] || fail "git config was not stowed"
[ -L "$stow_home/.config/ghostty/config" ] \
    || fail "Ghostty config was not stowed"
[ -L "$stow_home/.config/nvim" ] && [ -f "$stow_home/.config/nvim/init.lua" ] \
    || fail "Neovim config was not stowed"
[ -L "$stow_home/.local/bin/tmux-cycle-session" ] && [ ! -L "$stow_home/.local" ] \
    || fail "bin package did not use --no-folding"
[ -L "$stow_home/.local/bin/focus-address-bar" ] \
    || fail "browser address-bar helper was not stowed"
[ -d "$stow_home/.docker/cli-plugins" ] \
    && [ ! -L "$stow_home/.docker" ] \
    && [ -L "$stow_home/.docker/cli-plugins/docker-buildx" ] \
    && [ -x "$stow_home/.docker/cli-plugins/docker-buildx" ] \
    || fail "docker-buildx launcher was not stowed without folding ~/.docker"
[ ! -e docker/.docker/config.json ] \
    || fail "Docker's writable config.json must remain machine-local"
[ -x "$stow_home/.local/bin/ginit" ] \
    || fail "ginit was not stowed as an executable"
[ -x "$stow_home/.local/bin/ghinit" ] \
    || fail "ghinit was not stowed as an executable"
[ -x "$stow_home/.local/bin/adb-wireless-pair" ] \
    || fail "wireless ADB pairing helper was not stowed as an executable"
[ -x "$stow_home/.local/bin/tailscale-ensure-online" ] \
    || fail "Tailscale recovery helper was not stowed as an executable"
[ -L "$stow_home/.local/bin/raycast/localhost-8789-kiosk.sh" ] \
    || fail "Raycast kiosk command was not stowed"
for retired_android_command in \
    scrcpy.sh \
    scrcpy-no-audio.sh \
    scrcpy-flex.sh \
    scrcpy-no-audio-flex.sh; do
    [ ! -e "$stow_home/.local/bin/raycast/$retired_android_command" ] \
        || fail "retired Raycast Android command was stowed: $retired_android_command"
done
# Operator guidance and AI-tool configuration are AgentStart's, linked by its
# installer: the home AGENTS.md, extension prompts, AgentVoice doctrine, and
# llm model configuration. Funk stowing any of them again would be a second
# writer for the same paths.
[ ! -e "$stow_home/AGENTS.md" ] \
    || fail "the home guidance is AgentStart's; nothing in Funk may stow ~/AGENTS.md"
[ ! -e "$stow_home/.config/arthack" ] \
    || fail "the extension prompts are AgentStart's; nothing in Funk may stow ~/.config/arthack"
[ ! -e "$stow_home/.config/agentvoice" ] \
    || fail "the AgentVoice doctrine is AgentStart's; nothing in Funk may stow ~/.config/agentvoice"
[ ! -e "$stow_home/Library/Application Support/io.datasette.llm" ] \
    || fail "the llm configuration is AgentStart's; nothing in Funk may stow into io.datasette.llm"
[ -L "$stow_home/.config/herdr/agent-mem.sh" ] \
    || fail "Funk's machine-owned Herdr memory helper was not stowed"
[ ! -e "$stow_home/.config/herdr/config.toml" ] \
    || fail "Herdr config.toml is AgentStart's generated theme config, not Funk's"
HOME="$stow_home" "$root/bin/funk" stow --check >/dev/null 2>&1
# AgentStart owns balanced launch shims; Funk keeps only a convenience
# delegation and the shell PATH entry for the installed AgentLaunch directory.
# shellcheck disable=SC2016 # Match the literal delegation path in bin/funk.
grep -F 'agentstart_shims="$HOME/code/agentstart/scripts/install-agentlaunch-shims"' \
    bin/funk >/dev/null \
    || fail "funk install-agentlaunch-shims does not delegate to AgentStart"
grep -F '$HOME/.local/share/agentlaunch/shims' zsh/.zshrc >/dev/null \
    || fail "the shell does not prefer AgentLaunch's balanced harness shims"

mcd_path="$stow_home/mcd parent/mcd child"
cmkdir_path="$stow_home/cmkdir parent/cmkdir child"
HOME="$stow_home" MCD_TEST_PATH="$mcd_path" CMKDIR_TEST_PATH="$cmkdir_path" \
    /bin/zsh -c '
        source "$HOME/.zsh/aliases/core.zsh"
        mcd "$MCD_TEST_PATH"
        [[ "$PWD" -ef "$MCD_TEST_PATH" ]]
        eval "cmkdir \"\$CMKDIR_TEST_PATH\""
        [[ "$PWD" -ef "$CMKDIR_TEST_PATH" ]]
    ' || fail "mcd or cmkdir did not create and enter a directory"

helper_home="$stow_home/helper-home"
mkdir -p "$helper_home/code/ginit-project"
git config --file "$helper_home/gitconfig" init.defaultBranch main
git config --file "$helper_home/gitconfig" user.name 'Funk Validate'
git config --file "$helper_home/gitconfig" user.email 'funk-validate@example.invalid'
(
    cd "$helper_home/code/ginit-project"
    HOME="$helper_home" \
        GIT_CONFIG_GLOBAL="$helper_home/gitconfig" \
        GIT_CONFIG_NOSYSTEM=1 \
        "$root/bin/.local/bin/ginit" >/dev/null
    first_head=$(git rev-parse HEAD)
    HOME="$helper_home" "$root/bin/.local/bin/ginit"
    [ "$(git rev-parse HEAD)" = "$first_head" ] \
        || fail "ginit was not idempotent"
    [ "$(git log -1 --format=%s)" = 'New repo' ] \
        || fail "ginit did not create the expected initial commit"
)

gh_log="$helper_home/gh.log"
HOME="$helper_home" \
    PATH="$root/bin/.local/bin:$root/tests/fixtures:/usr/bin:/bin" \
    FUNK_TEST_GH_LOG="$gh_log" \
    GIT_CONFIG_GLOBAL="$helper_home/gitconfig" \
    GIT_CONFIG_NOSYSTEM=1 \
    "$root/bin/.local/bin/ghinit" gh-project --description 'Funk test' >/dev/null
gh_project_dir=$(cd -P -- "$helper_home/code/gh-project" && pwd)
expected_gh_log=$(printf '%s\n' \
    "cwd=$gh_project_dir" \
    'arg=--source=.' \
    'arg=--private' \
    'arg=--push' \
    'arg=--description' \
    'arg=Funk test')
[ "$(cat "$gh_log")" = "$expected_gh_log" ] \
    || fail "ghinit invoked gh repo create with unexpected arguments"

mkdir "$helper_home/code/gh-current"
(
    cd "$helper_home/code/gh-current"
    HOME="$helper_home" \
        PATH="$root/bin/.local/bin:$root/tests/fixtures:/usr/bin:/bin" \
        FUNK_TEST_GH_LOG="$gh_log" \
        GIT_CONFIG_GLOBAL="$helper_home/gitconfig" \
        GIT_CONFIG_NOSYSTEM=1 \
        "$root/bin/.local/bin/ghinit" >/dev/null
)
# With no project argument ghinit stays in the caller's directory, so gh sees
# the logical TMPDIR spelling (/var on macOS), not cd -P's canonical
# /private/var spelling. cd also normalizes TMPDIR's optional trailing slash.
gh_current_dir=$(cd -- "$helper_home/code/gh-current" && pwd -L)
expected_gh_log=$(printf '%s\n' \
    "cwd=$gh_current_dir" \
    'arg=--source=.' \
    'arg=--private' \
    'arg=--push')
[ "$(cat "$gh_log")" = "$expected_gh_log" ] \
    || fail "ghinit failed when run without arguments from a project directory"

HOME="$helper_home" \
    PATH="$root/bin/.local/bin:$root/tests/fixtures:/usr/bin:/bin" \
    FUNK_TEST_GH_LOG="$gh_log" \
    GIT_CONFIG_GLOBAL="$helper_home/gitconfig" \
    GIT_CONFIG_NOSYSTEM=1 \
    "$root/bin/.local/bin/ghinit" gh-public --description 'Public Funk test' --public \
    >/dev/null
gh_public_dir=$(cd -P -- "$helper_home/code/gh-public" && pwd)
expected_gh_log=$(printf '%s\n' \
    "cwd=$gh_public_dir" \
    'arg=--source=.' \
    'arg=--public' \
    'arg=--push' \
    'arg=--description' \
    'arg=Public Funk test')
[ "$(cat "$gh_log")" = "$expected_gh_log" ] \
    || fail "ghinit did not create a public repository when requested"

# A GitHub repository that already exists is not a failure: bind the checkout
# to it and let the rejected push be the operator's problem, not an abort.
existing_remote="$helper_home/existing-remote.git"
git init --quiet --bare --initial-branch=main "$existing_remote"
(
    export GIT_CONFIG_GLOBAL="$helper_home/gitconfig" GIT_CONFIG_NOSYSTEM=1
    mkdir "$helper_home/existing-seed"
    cd "$helper_home/existing-seed"
    git init --quiet --initial-branch=main
    git commit --quiet --allow-empty -m 'Upstream history'
    git push --quiet "$existing_remote" main
)
set +e
HOME="$helper_home" \
    PATH="$root/bin/.local/bin:$root/tests/fixtures:/usr/bin:/bin" \
    FUNK_TEST_GH_LOG="$gh_log" \
    FUNK_TEST_GH_CREATE_FAILS=1 \
    FUNK_TEST_GH_REPO_URL="$existing_remote" \
    GIT_CONFIG_GLOBAL="$helper_home/gitconfig" \
    GIT_CONFIG_NOSYSTEM=1 \
    "$root/bin/.local/bin/ghinit" gh-existing >/dev/null 2>&1
ghinit_existing_status=$?
set -e
[ "$ghinit_existing_status" -eq 0 ] \
    || fail "ghinit failed when the GitHub repository already existed"
[ "$(git -C "$helper_home/code/gh-existing" remote get-url origin)" = "$existing_remote" ] \
    || fail "ghinit did not bind the existing GitHub repository as origin"

visibility_file="$helper_home/gh-visibility"
visibility_log="$helper_home/gh-visibility.log"
printf '%s\n' private >"$visibility_file"
: >"$visibility_log"
run_existing_ghinit() {
    (
        cd "$helper_home/code/gh-existing"
        HOME="$helper_home" \
            PATH="$root/bin/.local/bin:$root/tests/fixtures:/usr/bin:/bin" \
            FUNK_TEST_GH_LOG="$gh_log" \
            FUNK_TEST_GH_VISIBILITY_FILE="$visibility_file" \
            FUNK_TEST_GH_VISIBILITY_LOG="$visibility_log" \
            GIT_CONFIG_GLOBAL="$helper_home/gitconfig" \
            GIT_CONFIG_NOSYSTEM=1 \
            "$root/bin/.local/bin/ghinit" "$@" >/dev/null 2>&1
    )
}
run_existing_ghinit --public
run_existing_ghinit --public
[ "$(cat "$visibility_file")" = public ] \
    || fail "ghinit --public did not make an existing repository public"
[ "$(cat "$visibility_log")" = public ] \
    || fail "ghinit --public was not idempotent"
run_existing_ghinit
[ "$(cat "$visibility_file")" = public ] \
    || fail "bare ghinit changed an existing repository's visibility"
run_existing_ghinit --no-public
run_existing_ghinit --no-public
[ "$(cat "$visibility_file")" = private ] \
    || fail "ghinit --no-public did not make an existing repository private"
expected_visibility_log=$(printf '%s\n' public private)
[ "$(cat "$visibility_log")" = "$expected_visibility_log" ] \
    || fail "ghinit --no-public was not idempotent"

set +e
HOME="$helper_home" "$root/bin/.local/bin/ghinit" ../outside >/dev/null 2>&1
ghinit_traversal_status=$?
set -e
[ "$ghinit_traversal_status" -ne 0 ] && [ ! -e "$helper_home/outside" ] \
    || fail "ghinit allowed a project name to escape ~/code"

grep -F "\"\$funk_command\" stow" install >/dev/null \
    || fail "default install does not stow user configuration"
# shellcheck disable=SC2016 # Match the literal shared Brewfile helper path.
grep -F '"$funk_root/libexec/converge-brewfile"' install >/dev/null \
    || fail "default install does not converge Brewfile upgrades before Node setup"
grep -F "\"\$funk_root/libexec/initialize-configs\"" install >/dev/null \
    || fail "default install does not initialize config dependencies"
# shellcheck disable=SC2016 # Match the literal cask converge in ./install.
grep -F '"$funk_root/libexec/converge-brew-casks" claude chatgpt' install >/dev/null \
    || fail "default install does not converge the AI desktop applications"
grep -F '"$funk_root/libexec/install-apple-container"' install >/dev/null \
    || fail "default install does not converge the Apple container package"
grep -F "package_id='com.apple.container-installer'" libexec/install-apple-container >/dev/null \
    || fail "Apple container helper lost its exact package identity"
grep -F "package_version='0.8.0'" libexec/install-apple-container >/dev/null \
    || fail "Apple container helper lost its acquisition version"
grep -F "package_sha256='6603d430d20f6f799215f729a4350bcf79cba371d96cb9d66fcefae46f05472f'" \
    libexec/install-apple-container >/dev/null \
    || fail "Apple container helper lost its pinned package checksum"
grep -F "team_id='UPBK2H6LZM'" libexec/install-apple-container >/dev/null \
    || fail "Apple container helper lost its expected Apple team identity"
if grep -F 'install-apple-container' libexec/funk-update >/dev/null; then
    fail "scheduled path attempts the privileged Apple container installation"
fi
if grep -Eq 'container system (start|restart)|container image pull|container (kernel|system) install' \
    libexec/install-apple-container tests/apple-container-install.sh; then
    fail "Apple container package convergence reaches runtime initialization"
fi
grep -F '"$funk_command" install-ghostty-terminfo' install >/dev/null \
    || fail "default install does not install Ghostty terminfo for SSH sessions"
grep -F '"$terminfo_installer" || status=$?' libexec/funk-update >/dev/null \
    || fail "scheduled updates do not refresh Ghostty terminfo after app upgrades"
# shellcheck disable=SC2016 # Match the literal AgentStart invocation in ./install.
grep -F '"$agentstart_root/scripts/install.sh" --install' install >/dev/null \
    || fail "default install does not run the AgentStart installer"
grep -F 'AgentStart owns the AI toolchain and is missing' install >/dev/null \
    || fail "default install does not stop loudly without the AgentStart checkout"
apple_container_line=$(grep -n '^"$funk_root/libexec/install-apple-container"$' install | cut -d: -f1)
agentstart_line=$(grep -n '^"$agentstart_root/scripts/install.sh" --install$' install | cut -d: -f1)
[ -n "$apple_container_line" ] && [ -n "$agentstart_line" ] \
    && [ "$apple_container_line" -lt "$agentstart_line" ] \
    || fail "Apple container package must converge before AgentStart"
grep -F "\"\$funk_command\" install-tailscale-recovery" install >/dev/null \
    || fail "default install does not load Tailscale recovery"
# Unattended health checks report through terminal-notifier, so an installation
# that never confirms delivery can leave every future alert silent.
grep -F "\"\$funk_command\" verify-notifications" install >/dev/null \
    || fail "default install does not verify notification delivery"
grep -F 'notifications_blocked=1' install >/dev/null \
    || fail "install treats blocked notifications as fatal instead of reporting"
# Reopening Karabiner on every install only raises a window the user did not ask
# for; it exists to request permissions that are already granted once its
# per-user services are up.
grep -F 'if karabiner_is_active; then' libexec/install-window-manager >/dev/null \
    || fail "window installer reopens Karabiner even when it is already running"
grep -F 'pgrep -x karabiner_console_user_server' libexec/install-window-manager >/dev/null \
    || fail "Karabiner activity check does not test its per-user session service"

grep -F 'with_windows=1' install >/dev/null \
    || fail "default install does not enable the window stack"
grep -F -- '--without-windows) with_windows=0' install >/dev/null \
    || fail "default window stack has no explicit opt-out"
grep -F 'tmux-fzf.git' libexec/initialize-configs >/dev/null \
    || fail "tmux-fzf is not initialized"
# There is no theme manager any more. Funk names the theme outright, in one
# tracked line, and every other layer follows the terminal that results; a
# generated palette and the machinery to render one stay gone.
if grep -R -Eqi \
    'tinty|tinted-theming|catppuccin|base16|base24|syntax-theme|color_theme|theme_background' \
    Brewfile README.md libexec ghostty nvim tmux zsh btop git; then
    fail "managed configuration reintroduced a theme"
fi
# Funk names the theme, so a fresh account converges to known colors. The
# picker writes its pick to the machine-local Application Support config,
# which Ghostty loads second and which therefore outranks this line until the
# operator promotes it here by hand -- the accepted cost of keeping the picker.
if ! grep -Eq '^theme = .+$' ghostty/.config/ghostty/config; then
    fail "Ghostty names no theme, so a fresh account converges to no known colors"
fi
[ ! -e ghostty/.config/ghostty/themes ] \
    || fail "Ghostty theme files must not live in Funk"
# The picker is upstream's and writes a theme into whatever GHOSTTY_CONFIG
# names. Funk's wrapper is the whole safety argument: it pins that at the macOS
# Application Support config, which Ghostty loads after the XDG one and Funk
# never tracks. Unpinned, the picker's mktemp + mv would replace the Stow link
# at ~/.config/ghostty/config with a real file holding a theme.
grep -F 'com.mitchellh.ghostty' bin/.local/bin/ghostty-themes >/dev/null \
    && grep -Eq '^GHOSTTY_CONFIG="\$support_dir/config"$' \
        bin/.local/bin/ghostty-themes \
    || fail "the theme picker is not pinned outside the managed Ghostty config"
if grep -v '^ *#' bin/.local/bin/ghostty-themes \
    | grep -Eq '\.config/ghostty'; then
    fail "the theme picker wrapper names the Stow-managed Ghostty config"
fi
grep -F 'ghostty-themes' install >/dev/null \
    || fail "the theme picker does not converge from ./install"
if grep -R -Eq \
    "%C\\(|%C[a-z]|%\\(color:|fg=(black|red|green|yellow|blue|magenta|cyan|white)|bg=(black|red|green|yellow|blue|magenta|cyan|white)|style = '(black|red|green|yellow|blue|magenta|cyan|white)'" \
    ghostty nvim tmux zsh btop git; then
    fail "managed configuration contains a theme-specific named color"
fi
# A hex literal is the other half of the same rule, and the one the named-color
# pattern never caught: it pins an absolute color the terminal theme cannot move.
if grep -R -Eq '#[0-9a-fA-F]{6}\b' \
    ghostty nvim tmux zsh btop git; then
    fail "managed configuration contains a hardcoded hex color"
fi
# tmux chrome is the deliberate exception, and it earns it by naming only ANSI
# palette indices: colour0-15 resolve against whatever theme Ghostty is running,
# so the status bar follows the terminal instead of overriding it. A sweep that
# removes a theme manager must leave this file alone.
[ -f tmux/.config/tmux/conf.d/theme.conf ] \
    || fail "tmux status chrome is missing"
if grep -Eq '(fg|bg)=colour(1[6-9]|[2-9][0-9]|[1-9][0-9][0-9])' \
    tmux/.config/tmux/conf.d/theme.conf; then
    fail "tmux chrome reaches past the ANSI palette the terminal theme controls"
fi
grep -F 'save_config_on_exit = false' btop/.config/btop/btop.conf >/dev/null \
    || fail "btop can rewrite theme defaults into its managed config"
# Signal Room is an APK asset, never desktop configuration. Pin both the exact
# portable Ghostty shape and the Lab-only command boundary here so broad theme
# cleanup cannot erase it and a future installer edit cannot reach stable.
signal_room='assets/chuchu/Signal Room'
[ -f "$signal_room" ] || fail "canonical Chuchu Signal Room theme is missing"
[ "$(grep -Ec '^palette = ([0-9]|1[0-5])=#[0-9a-f]{6}$' "$signal_room")" -eq 16 ] \
    || fail "Signal Room does not define exactly 16 ANSI palette colors"
[ "$(grep -Ec '^(background|foreground|cursor-color|cursor-text|selection-background|selection-foreground) = #[0-9a-f]{6}$' "$signal_room")" -eq 6 ] \
    || fail "Signal Room does not define the six portable Ghostty properties"
grep -F "lab_package='com.arthack.chuchu.lab'" libexec/install-chuchu-lab-theme \
    >/dev/null || fail "Chuchu theme installer lost its Lab package boundary"
"$root/tests/chuchu-theme.sh"
"$root/tests/ghostty-terminfo.sh"
# shellcheck disable=SC2016 # Match the literal shell variable in the script.
grep -F '"$funk_root/bin/funk" yabai maintain' libexec/install-window-manager >/dev/null \
    || fail "window installer does not reconcile the Yabai scripting addition"
# shellcheck disable=SC2016 # Match the literal shell variables in the script.
grep -F 'wait_for_numbered_spaces "$yabai_bin"' libexec/funk-yabai >/dev/null \
    || fail "Yabai maintenance does not wait for numbered Spaces"
# shellcheck disable=SC2016 # Match the literal shell variable in the script.
grep -F '"$yabai_bin" -m query --spaces --space 9' libexec/funk-yabai >/dev/null \
    || fail "Yabai maintenance does not verify Space 9"
grep -F 'trap cleanup EXIT' system/funk-yabai-maintain >/dev/null \
    || fail "Yabai root maintenance does not register stable temporary-file cleanup"
# shellcheck disable=SC2016 # Match the literal shell expression in the script.
grep -F 'cleanup_tmpdir=$(mktemp -d /private/tmp/funk-yabai-maintain.XXXXXX)' \
    system/funk-yabai-maintain >/dev/null \
    || fail "Yabai root maintenance cleanup does not retain its temporary directory"
# shellcheck disable=SC2016 # Match the literal function-local shell variable.
if grep -F 'trap '\''rm -rf "$tmpdir"'\'' EXIT' system/funk-yabai-maintain >/dev/null; then
    fail "Yabai root maintenance cleanup references a function-local variable at exit"
fi
if grep -F 'Run: funk yabai maintain' libexec/install-window-manager >/dev/null; then
    fail "window installer still delegates initial Yabai maintenance to the user"
fi

# The floating set is reviewed as a whole: every entry must name an application
# that Funk installs or that macOS ships, and the order is asserted because
# Yabai applies all matching rules in registration order, letting a later rule
# override an earlier value.
expected_float_rules='app="^Google Chrome$" title="^Picture in Picture$"
app="^System Settings$"
app="^Tailscale$"
app="^Karabiner-Elements$"
app="^Karabiner-EventViewer$"
app="^AltTab$"
app="^Activity Monitor$"
app="^Calculator$"
app="^Archive Utility$"
app="^Installer$"
app="^scrcpy$"'
actual_float_rules=$(
    sed -n 's/^yabai -m rule --add \(.*\) manage=off$/\1/p' \
        yabai/.config/yabai/yabairc
)
[ "$actual_float_rules" = "$expected_float_rules" ] \
    || fail "Yabai floating rules do not match the reviewed set"
if grep -E '^yabai -m rule --add ' yabai/.config/yabai/yabairc \
    | grep -qv 'app="\^'; then
    fail "a Yabai rule is not scoped to a named application"
fi
# AltTab's switcher windows should float instead of entering the tiling stack.
grep -Fx 'yabai -m rule --add app="^AltTab$" manage=off' \
    yabai/.config/yabai/yabairc >/dev/null \
    || fail "AltTab is missing its Yabai floating rule"
# browserctl-display belonged to the retired virtual-display viewer.
if grep -F 'app="^browserctl-display$"' \
    yabai/.config/yabai/yabairc >/dev/null; then
    fail "Yabai floats browserctl-display even though Funk does not install it"
fi

if grep -Eq '^cask "(chatgpt|claude)"$' Brewfile; then
    fail "AI desktop application leaked back into the bootstrap Brewfile"
fi

for required_setting in \
    'NSGlobalDomain AppleInterfaceStyle -string "Dark"' \
    'com.apple.dock autohide -bool true' \
    'com.apple.dock persistent-apps -array' \
    'com.apple.WindowManager HideDesktop -bool true' \
    'com.apple.finder FXICloudDriveDesktop -bool false' \
    'com.apple.finder FXICloudDriveDocuments -bool false' \
    'NSGlobalDomain com.apple.swipescrolldirection -bool false' \
    'com.apple.symbolichotkeys AppleSymbolicHotKeys -dict-add 64' \
    'com.raycast.macos raycastGlobalHotkey -string "Command-2"' \
    'com.raycast.macos onboardingCompleted -bool true' \
    'com.apple.ControlCenter AirplayRecieverEnabled -bool false' \
    'io.tailscale.ipn.macsys SUEnableAutomaticChecks -bool false' \
    'io.tailscale.ipn.macsys SUAutomaticallyUpdate -bool false'; do
    grep -F "$required_setting" libexec/configure-macos >/dev/null \
        || fail "required macOS setting is missing: $required_setting"
done
# Tailscale's own updater staged a system extension upgrade that wedged on the
# next app restart and left no daemon. Homebrew has to be the only updater that
# touches this cask, so the reason has to survive in the source rather than
# reading as an arbitrary preference someone later "cleans up".
grep -F 'Sparkle' libexec/configure-macos >/dev/null \
    || fail "disabling Tailscale's own updater is unexplained"
grep -F '/usr/bin/killall Raycast' libexec/configure-macos >/dev/null \
    || fail "Raycast is not stopped before its hotkey preference is written"
# Stopping Raycast discards what the user was doing and forces it to re-register
# its global hotkey, so it must happen only when a preference actually differs.
grep -F 'raycast_default_matches raycastGlobalHotkey "Command-2"' \
    libexec/configure-macos >/dev/null \
    || fail "Raycast is stopped without first reading its current preferences"
grep -F 'Raycast preferences already match; leaving it running.' \
    libexec/configure-macos >/dev/null \
    || fail "converged Raycast is not left running"
if grep -Eqi 'wallpaper|desktop-image|DesktopImageURL' libexec/configure-macos; then
    fail "user-level macOS preferences still enforce a wallpaper"
fi
if grep -Eq 'mdutil|nvram|launchctl disable|pmset' \
    libexec/configure-macos; then
    fail "machine-wide setting found in user-level macOS preferences"
fi

"$root/bin/funk" configure-system --check
# Literal dollar signs below verify that the root helper passes its validated
# runtime values instead of embedding an account name or boot-argument string.
# shellcheck disable=SC2016
for required_system_setting in \
    '/usr/bin/mdutil -i off -a' \
    '/usr/bin/pmset -c displaysleep 5' \
    '/bin/launchctl disable system/com.apple.smbd' \
    '/usr/sbin/sharing -r "$share_name"' \
    '/usr/sbin/nvram "boot-args=$desired_boot_args"'; do
    grep -F "$required_system_setting" system/apply-system-settings >/dev/null \
        || fail "required system setting is missing: $required_system_setting"
done
if grep -F '/Users/mike' system/apply-system-settings >/dev/null; then
    fail "old account leaked into system settings"
fi

[ "$(grep -Ec '^f(13|14|15|16|17|18|19) : yabai -m space --focus [1-7]$' skhd/.config/skhd/skhdrc)" -eq 7 ] \
    || fail "skhd numbered-Space 1-7 focus bindings are incomplete"
grep -Fx '0x5A : yabai -m space --focus 8' skhd/.config/skhd/skhdrc >/dev/null \
    || fail "skhd Space 8 focus binding is missing its F20 keycode"
grep -Fx 'f12 : yabai -m space --focus 9' skhd/.config/skhd/skhdrc >/dev/null \
    || fail "skhd Space 9 focus binding is missing"
[ "$(grep -Ec '^cmd \+ shift - [1-9] : yabai -m window --space [1-9]$' skhd/.config/skhd/skhdrc)" -eq 9 ] \
    || fail "skhd numbered-Space move bindings are incomplete"
grep -F 'cmd + shift - v : /usr/bin/open "raycast://extensions/raycast/clipboard-history/clipboard-history"' \
    skhd/.config/skhd/skhdrc >/dev/null \
    || fail "Raycast Clipboard History shortcut is missing"
grep -Fx 'ctrl + cmd - escape : ~/.local/bin/dismiss-terminal-notifier' skhd/.config/skhd/skhdrc >/dev/null \
    || fail "terminal-notifier dismissal shortcut is missing"
grep -F 'ctrl - l [' skhd/.config/skhd/skhdrc >/dev/null \
    || fail "browser address-bar shortcut is missing"
for browser_name in "Google Chrome" "Google Chrome Canary" Firefox "Brave Browser"; do
    grep -F "\"$browser_name\" : ~/.local/bin/focus-address-bar" \
        skhd/.config/skhd/skhdrc >/dev/null \
        || fail "browser address-bar shortcut is missing $browser_name"
done
if grep -Eq '^cmd - (return|b) :' skhd/.config/skhd/skhdrc; then
    fail "removed application launcher shortcut is present"
fi
grep -F 'menu item "Open Location…"' bin/.local/bin/focus-address-bar >/dev/null \
    || fail "browser address-bar helper does not use the browser menu"
grep -Fx 'brew "scrcpy"' Brewfile >/dev/null \
    || fail "scrcpy is missing from the Brewfile"
grep -Fx 'cask "android-platform-tools", greedy: true' Brewfile >/dev/null \
    || fail "Android Platform Tools are missing from the Brewfile"
"$root/tests/tailscale-online.sh"
"$root/tests/ssh-tailnet-config.sh"
"$root/tests/gog-authed.sh"
"$root/tests/funk-notify.sh"
"$root/tests/dismiss-terminal-notifier.sh"
# home-awake asserts a root helper's installability through BSD stat -f and
# drives pmset and caffeinate, so it only means anything on macOS.
if [ "$(uname -s)" = Darwin ]; then
    "$root/tests/home-awake.sh"
else
    skip "home-awake suite (root helper installability, idle-sleep hold-off)" \
        "needs macOS: BSD stat -f, pmset, caffeinate"
fi
# Wireless ADB locks with /usr/bin/shlock and checks state permissions with BSD
# stat -f, so the suite only means anything on macOS.
if [ "$(uname -s)" = Darwin ]; then
    "$root/tests/adb-wireless.sh"
    "$root/tests/android-launchers.sh"
else
    skip "adb-wireless suite" \
        "needs macOS: /usr/bin/shlock and BSD stat -f"
    skip "Android launcher application suite" \
        "needs macOS: AppKit, clang, codesign, and BSD stat -f"
fi
"$root/tests/kiosk-launcher.sh"
kiosk_launcher=bin/.local/bin/raycast/localhost-8789-kiosk.sh
if grep -R -F '@raycast.title Android' bin/.local/bin/raycast >/dev/null; then
    fail "retired Raycast Android command is tracked"
fi
grep -F '@raycast.title Localhost 8789 (kiosk)' "$kiosk_launcher" >/dev/null \
    || fail "localhost kiosk Raycast command is missing"
# Launching through `open` reuses a running Chrome and discards --kiosk, so the
# launcher must keep invoking the binary with its own profile directory.
grep -F -- '--user-data-dir=' "$kiosk_launcher" >/dev/null \
    || fail "kiosk launcher lost the dedicated Chrome profile"
if grep -Eq '(^|[^-])open ' "$kiosk_launcher"; then
    fail "kiosk launcher routes Chrome through open and would drop --kiosk"
fi
grep -Fx 'cask "google-chrome", greedy: true' Brewfile >/dev/null \
    || fail "Google Chrome is missing from the Brewfile"
# The mirror window keeps the device aspect ratio and refuses resize, so the
# stack layout must never hand it a tile. Matching on the application alone
# covers the plain and --new-display native application variants.
grep -Fx 'yabai -m rule --add app="^scrcpy$" manage=off' \
    yabai/.config/yabai/yabairc >/dev/null \
    || fail "scrcpy is missing its Yabai floating rule"

# shellcheck disable=SC2016 # Match literal Brewfile convergence variables.
grep -F '"$brew_bin" bundle install --upgrade --file="$brewfile"' \
    libexec/converge-brewfile >/dev/null \
    || fail "Brewfile convergence does not override Homebrew's no-upgrade setting"
# shellcheck disable=SC2016 # Match the literal scoped target variable.
grep -F '/usr/bin/xattr -dr com.apple.quarantine "$target"' \
    libexec/release-cask-quarantine >/dev/null \
    || fail "cask helper does not remove only the quarantine attribute"
# shellcheck disable=SC2016 # Match the literal scoped Gatekeeper target.
grep -F '"$spctl_bin" --assess --type execute "$target"' \
    libexec/release-cask-quarantine >/dev/null \
    || fail "cask helper does not Gatekeeper-assess an app before release"
if grep -Eq '/usr/bin/xattr -(c|d[^r])|xattr[^[:cntrl:]]+(where_from|provenance)' \
    libexec/release-cask-quarantine; then
    fail "cask helper weakens extended attributes beyond recursive quarantine removal"
fi
# The AgentStart skill sync joined the scheduled path when the updater started
# delegating to it, so it inherits the same prohibition even though it lives
# in the sibling checkout.
#
# Match code, not prose. A file that documents why it is safe names the very
# operations it forbids — AgentStart's sync says it "never uninstalls" — and
# scanning raw text turns each such comment into a failure, which teaches the
# next reader to weaken the pattern rather than the scan. Only a whole-line
# comment is dropped; a trailing comment stays attached to its code, so
# nothing executable can hide behind a `#`.
if sed 's/^[[:space:]]*#.*$//' \
    bin/funk libexec/funk-update libexec/install-update-agent \
    libexec/converge-brewfile libexec/converge-brew-casks \
    libexec/repair-cask-artifacts \
    "$update_agentstart_root/scripts/sync-skills" \
    launchd/com.arthack.funk.update.plist.in \
    | grep -Eqi 'bundle cleanup|uninstall|fetch-head|telegram|sudo'; then
    fail "scheduled updater contains a prohibited operation"
fi

# The triage helper reads Homebrew's removal metadata, so it names the privileged
# stanzas it looks for and cannot join the literal scan above. It still runs on
# the scheduled path, so assert directly that it can never elevate.
if grep -Eq '(^|[[:space:];&|(])(/usr/bin/)?sudo([[:space:]]|$)' \
    libexec/list-unattendable-casks; then
    fail "unattended cask triage can invoke sudo"
fi
if grep -Fq 'reclaim-app-ownership' libexec/list-unattendable-casks; then
    fail "unattended cask triage depends on the privileged ownership helper"
fi
grep -F 'HOMEBREW_BUNDLE_CASK_SKIP' libexec/funk-update >/dev/null \
    || fail "scheduled updater does not skip casks that need administrator authentication"
# shellcheck disable=SC2016 # Match the literal triage invocation in the script.
grep -F '"$cask_dir_lister" --list --brewfile "$brewfile"' \
    libexec/funk-update >/dev/null \
    || fail "scheduled updater does not skip casks installed under a previous account"

# Homebrew fails every later upgrade of a cask left in the aborted-upgrade state,
# so both convergence paths must repair it before asking Homebrew to move an app.
# shellcheck disable=SC2016 # Match the literal repair invocation in the script.
grep -F '"$repair_artifacts" --brewfile "$brewfile"' \
    libexec/converge-brewfile >/dev/null \
    || fail "Brewfile convergence does not repair aborted-upgrade Caskroom state"
# shellcheck disable=SC2016 # Match the literal repair invocation in the script.
grep -F '"$repair_artifacts" "$@"' libexec/converge-brew-casks >/dev/null \
    || fail "cask convergence does not repair aborted-upgrade Caskroom state"
grep -F 'libexec/reclaim-app-ownership' install >/dev/null \
    || fail "installer does not reclaim applications left by a previous account"
grep -F 'libexec/repair-cask-user-dirs' install >/dev/null \
    || fail "installer does not repair casks installed under a previous account"

# Root ownership means an installer owns the bundle only when the cask ships a
# pkg. Treating every root-owned bundle that way let the scheduled updater
# attempt an app-cask upgrade that could only ever fail on a sudo prompt it
# cannot answer, so both helpers must consult the artifact metadata.
for ownership_helper in libexec/reclaim-app-ownership libexec/list-unattendable-casks; do
    grep -F 'pkg_casks' "$ownership_helper" >/dev/null \
        || fail "$ownership_helper treats every root-owned bundle as a pkg install"
done

if grep -R -E '/Users/[A-Za-z0-9._-]+|telegram|agentnotify|TCC\.db|security import|yabai-cert' \
    Brewfile bin launchd libexec system yabai skhd karabiner >/dev/null; then
    fail "old-account or prohibited privileged machinery leaked into Funk"
fi

# home-awake identifies the home network deliberately, so the blanket ban on
# router detection no longer fits the whole tree. The ban it replaces is the one
# that actually mattered: the travel firewall must never decide it is somewhere
# safe and relax itself. Nothing on the PF path may learn where it is.
if grep -R -E 'home.router|router_mac|arp |ipconfig getoption|ProfileID' \
    system/funk-harden system/install-hardening-root libexec/install-hardening \
    libexec/funk-harden-client >/dev/null; then
    fail "the travel firewall gained network-location detection"
fi
if grep -R -E 'funk-home-awake|home-awake' \
    system/funk-harden system/install-hardening-root >/dev/null; then
    fail "the travel firewall was coupled to home-awake"
fi

# Nothing counts as home until it is recorded on the machine itself. A shipped
# default would hand a fresh account somebody else's network.
if grep -R -E '^[^#]*(router_mac|default_router)=[0-9a-fA-F]{2}:' \
    bin/.local/bin/home-awake >/dev/null; then
    fail "home-awake ships a default home router"
fi

if grep -R -E 'NOPASSWD:[[:space:]]*(ALL|/[^[:space:]]+[[:space:]]+\*)' \
    system >/dev/null; then
    fail "broad passwordless sudo rule found"
fi

# The operator's tailnet left this repository and must not come back. A re-added
# host file or a pasted MagicDNS suffix is the regression these catch; the
# fixture's example-tailnet.ts.net is the only tailnet name allowed to appear.
if git ls-files ssh/.ssh/config.d | grep -q .; then
    fail "ssh/.ssh/config.d has tracked host files again; they are generated onto the machine"
fi
# A real MagicDNS suffix is lowercase, which is what separates one from the
# upper-case placeholders the README uses in command examples.
if git grep -I -n -E '[a-z0-9][a-z0-9-]*\.ts\.net' -- . \
    | grep -v 'example-tailnet\.ts\.net' | grep -q .; then
    fail "a real tailnet name is tracked in this repository"
fi
grep -F 'exec "$FUNK_ROOT/bin/.local/bin/ssh-tailnet-config"' bin/funk >/dev/null \
    || fail "funk does not dispatch ssh-tailnet-config"
grep -F '"$funk_command" ssh-tailnet-config' install >/dev/null \
    || fail "./install does not write the tailnet ssh host files"
# Writing ssh_config files needs nothing privileged, and a converged ./install
# must not prompt for a password.
if grep -q sudo bin/.local/bin/ssh-tailnet-config; then
    fail "the tailnet ssh generator reaches for sudo"
fi

# PF is a BSD packet filter; only pfctl can say whether the rendered ruleset
# actually parses, so this is the other check that stays macOS-only.
if [ "$(uname -s)" = Darwin ] && [ -x /sbin/pfctl ]; then
    "$root/system/funk-harden" render | /sbin/pfctl -nf - >/dev/null 2>&1
else
    skip "travel firewall ruleset parse (system/funk-harden render | pfctl -nf -)" \
        "needs macOS pfctl"
fi

git diff --check
if [ -n "$skipped" ]; then
    # A green run that quietly skipped something is the failure mode this suite
    # exists to prevent, so the summary always says what did not run.
    printf 'validate: all non-destructive checks passed, except these skipped here:\n'
    printf '%s' "$skipped"
else
    printf 'validate: all non-destructive checks passed\n'
fi
