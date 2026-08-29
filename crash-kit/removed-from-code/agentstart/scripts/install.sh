#!/bin/bash

set -euo pipefail

check_only=0
content_only=0
script_dir=$(cd -P -- "$(dirname -- "$0")" && pwd)
repo_root=$(cd -P -- "$script_dir/.." && pwd)

# The fleet root. AGENTSTART_CODE_ROOT relocates it as a unit — the tests point
# it at a fixture tree — but it deliberately does not resolve relative to this
# script: the installer converges the machine, not the checkout it was invoked
# from, and a worktree run must still find the real fleet rather than silently
# skipping every tool.
code_root="${AGENTSTART_CODE_ROOT:-$HOME/code}"
# Fx maintenance advances this only after fxnk's exact-SHA local gate and ship
# gate approve the published Integration commit. Ordinary convergence reuses
# that reviewed consumer pin; it never treats the current remote tip as an
# implicit approval.
fx_integration_sha=d5e5da7aad0bbfa9b0792a02f72e802e8606b20c
resources_root="${AGENTSTART_RESOURCES_ROOT:-$HOME/.local/share/agentstart/resources}"
resources_skills_state_root="$resources_root/skills-state"
retired_capabilities_root="$HOME/.local/share/agentstart/capabilities"
legacy_core_marketplace_root="${AGENTSTART_CORE_MARKETPLACE_ROOT:-$HOME/.local/share/agentstart/core-marketplace}"
legacy_core_plugin_root="$legacy_core_marketplace_root/plugins/agentstart-core"

usage() {
    cat <<'EOF'
Usage: scripts/install.sh [--install|--check|--content]

Install the AI command-line tools, harness configuration, and agent skills
owned by AgentStart. The machine's installer invokes this after converging
Homebrew and the AI desktop applications; it is also safe to run standalone.

Options:
  --install  Install or upgrade everything
  --check    Print the installation plan without changing the system
  --content  Converge only what this repository owns as content — skills,
             prompts, guidance, the statusline, and fixed fleet resources —
             installing and upgrading nothing. Cheap and safe to rerun on a
             machine a full install has already converged.
EOF
}

die() {
    printf 'AgentStart installer: %s\n' "$*" >&2
    exit 1
}

find_brew() {
    if command -v brew >/dev/null 2>&1; then
        command -v brew
        return
    fi
    for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
        if [ -x "$candidate" ]; then
            printf '%s\n' "$candidate"
            return
        fi
    done
    return 1
}

install_official() {
    local name="$1"
    local url="$2"
    local interpreter="$3"
    shift 3

    printf 'Installing %s with its official installer.\n' "$name"
    /usr/bin/curl -fsSL "$url" | "$interpreter" "$@"
}

install_private_skill_pack() {
    local source="$1"
    shift

    mkdir -p "$resources_root" "$resources_skills_state_root"
    CLAUDE_CONFIG_DIR="$resources_root" XDG_STATE_HOME="$resources_skills_state_root" \
        "$script_dir/run-skills-cli" npx --yes skills add "$source" \
        --agent claude-code \
        --skill "$@" \
        --global --copy --yes \
        || die "installing agent skills failed: $source ($*)"
}

remove_legacy_global_skills() {
    local names=(
        find-skills
        frontend-design
        web-design-guidelines
        vercel-react-best-practices
        ai-sdk
        ai-elements
        shadcn
        native-sdk
        terminal-control
        herdr
        livekit-simulations
        orca-cli
        orchestration
        computer-use
        supervisor
    )
    local project skill_dir skill_name previous_names pi_target pi_link

    for project in "$code_root"/agent*/; do
        [ -d "$project" ] || continue
        for skill_dir in "$project"/skills/*/; do
            [ -f "$skill_dir/SKILL.md" ] || continue
            skill_dir=${skill_dir%/}
            names+=("${skill_dir##*/}")
        done
    done

    for previous_names in \
        "$resources_root/managed-skills.txt" \
        "$retired_capabilities_root/managed-skills.txt" \
        "$legacy_core_marketplace_root/managed-skills.txt"; do
        if [ -f "$previous_names" ]; then
            while IFS= read -r skill_name; do
                [ -n "$skill_name" ] && names+=("$skill_name")
            done <"$previous_names"
        fi
    done

    # The fixed resources may already have been synchronized before the first
    # full migration run. Detach only its Pi links before asking the generic
    # skills CLI to remove legacy installs, so that tool can never mistake a
    # link into the private canonical tree for content it owns.
    for skill_name in "${names[@]}"; do
        pi_target="$HOME/.pi/agent/skills/$skill_name"
        [ -L "$pi_target" ] || continue
        pi_link=$(readlink "$pi_target")
        case "$pi_link" in
            "$resources_root"/skills/*|"$retired_capabilities_root"/packs/common/skills/*|"$legacy_core_plugin_root"/skills/*) unlink "$pi_target" ;;
        esac
    done

    "$script_dir/run-skills-cli" npx --yes skills remove --global --yes "${names[@]}" \
        || die "removing retired AgentStart-managed skills failed"
}

remove_retired_core_plugin() {
    local legacy_owned=0 legacy_plugin manifest

    # This migration is intentionally a full-install operation. The six-hour
    # sync only refreshes the Codex fleet plugin in place; it never
    # uninstalls plugins or ambient resources that a live session may use.
    claude plugin uninstall agentstart-core@agentstart-managed --scope user >/dev/null 2>&1 || true
    claude plugin uninstall agent@agentstart-managed --scope user >/dev/null 2>&1 || true
    claude plugin marketplace remove agentstart-managed >/dev/null 2>&1 || true

    codex plugin remove agentstart-core@agentstart-managed >/dev/null 2>&1 || true
    codex plugin remove agent@agentstart-managed >/dev/null 2>&1 || true
    codex plugin marketplace remove agentstart-managed >/dev/null 2>&1 || true

    # The old marketplace was wholly AgentStart-owned, but prove that identity
    # before removing a recursive tree. Preserve and name an unexpected occupant.
    if [ -d "$legacy_core_marketplace_root" ]; then
        legacy_plugin="$legacy_core_plugin_root"
        for manifest in \
            "$legacy_plugin/.claude-plugin/plugin.json" \
            "$legacy_plugin/.codex-plugin/plugin.json"; do
            [ -f "$manifest" ] || continue
            if /usr/bin/jq -e '.name == "agentstart-core"' "$manifest" >/dev/null 2>&1; then
                legacy_owned=1
                break
            fi
        done
        if [ "$legacy_owned" -eq 1 ]; then
            rm -rf -- "$legacy_core_marketplace_root"
            printf 'Removed retired AgentStart core marketplace: %s.\n' \
                "$legacy_core_marketplace_root"
        else
            printf 'Leaving unrecognized legacy marketplace untouched: %s.\n' \
                "$legacy_core_marketplace_root" >&2
        fi
    fi
}

remove_packed_pi_ambient_resources() {
    local source="$HOME/.pi/agent/extensions/herdr-agent-state.ts"

    [ -e "$source" ] || [ -L "$source" ] || return 0
    [ -f "$source" ] \
        || die "refusing non-file Pi Herdr integration: $source"
    grep -F '// managed by herdr;' "$source" >/dev/null \
        || die "refusing independent Pi extension at Herdr's managed path: $source"
    grep -F '// HERDR_INTEGRATION_ID=pi' "$source" >/dev/null \
        || die "Pi Herdr integration has the wrong identity: $source"
    rm -- "$source"
    printf 'Removed the ambient Pi Herdr integration after packing it: %s.\n' "$source"
}

remove_retired_capability_resources() {
    local manifest="$retired_capabilities_root/packs/common/capability.json"

    [ -e "$retired_capabilities_root" ] || [ -L "$retired_capabilities_root" ] || return 0
    [ -d "$retired_capabilities_root" ] \
        || die "refusing non-directory retired capability root: $retired_capabilities_root"
    [ -f "$manifest" ] \
        || die "refusing unrecognized retired capability root without $manifest"
    /usr/bin/jq -e '.schema_version == 1 and .id == "common" and .default == true' \
        "$manifest" >/dev/null \
        || die "refusing unrecognized retired capability root: $retired_capabilities_root"
    rm -rf -- "$retired_capabilities_root"
    printf 'Removed the retired capability-pack tree: %s.\n' "$retired_capabilities_root"
}

# Pi's installer reads its prompts from /dev/tty instead of stdin, so redirecting
# input does not make it unattended: run from a terminal it stops on its
# install/reinstall menu and offers to append a PATH line to the shell profile
# that the machine's zsh package owns. Running it in its own session leaves it with no
# controlling terminal, which is exactly the condition its documented
# "No terminal detected; continuing without confirmation" path tests for.
run_without_controlling_terminal() {
    /usr/bin/perl -e '
        use POSIX ();
        my $pid = fork();
        die "fork failed: $!\n" unless defined $pid;
        if ($pid == 0) {
            POSIX::setsid();
            exec { $ARGV[0] } @ARGV or exit 127;
        }
        waitpid($pid, 0);
        exit($? >> 8);
    ' -- "$@"
}

configure_shadcn_mcp() {
    printf 'Configuring the shadcn registry MCP server for Codex.\n'
    codex mcp remove shadcn >/dev/null 2>&1 || true
    codex mcp add shadcn -- npx shadcn@latest mcp

    printf 'Configuring the shadcn registry MCP server for Claude Code.\n'
    claude mcp remove --scope user shadcn >/dev/null 2>&1 || true
    claude mcp add --scope user shadcn -- npx shadcn@latest mcp
}

# AgentStart owns one guidance slot for each harness. Link all three to the
# fixed resource set's canonical AGENTS.md, which stays deliberately empty — global
# advice belongs
# in the extension prompts below, rendered into the collab and build skills,
# not in a file loaded into every session. Claude Code reads only CLAUDE.md,
# Codex skips empty guidance files, and pi's designated global slot is
# ~/.pi/agent/AGENTS.md. An independent non-symlink file with content at any
# target is preserved and reported — the same conflict rule the guidance file
# itself prescribes for repositories.
link_agent_guidance() {
    local source="$resources_root/guidance/AGENTS.md"
    local target

    [ -f "$source" ] \
        || die "agent guidance source is missing: $source"

    for target in "$HOME/.claude/CLAUDE.md" "$HOME/.codex/AGENTS.md" "$HOME/.pi/agent/AGENTS.md"; do
        if [ ! -L "$target" ] && [ -s "$target" ]; then
            die "refusing to replace independent guidance: $target"
        fi
        mkdir -p "$(dirname "$target")"
        ln -sfn "$source" "$target"
        cmp -s "$source" "$target" \
            || die "linked guidance does not resolve to $source: $target"
    done
}

# Remove only the exact home guidance symlinks this checkout previously
# created. With the three harness slots linked directly, ~/AGENTS.md is a
# project guidance location again; an independent occupant belongs to its
# owner and is left alone.
remove_retired_home_guidance() {
    local retired_source="$repo_root/prompts/AGENTS.md"
    local current_source="$resources_root/guidance/AGENTS.md"
    local target="$HOME/AGENTS.md"

    if [ -L "$target" ] && { [ "$(readlink "$target")" = "$retired_source" ] || [ "$(readlink "$target")" = "$current_source" ]; }; then
        rm -- "$target"
        printf 'Removed retired AgentStart-owned home guidance symlink: %s.\n' "$target"
    elif [ -e "$target" ] || [ -L "$target" ]; then
        printf 'Leaving independent home guidance untouched: %s.\n' "$target"
    fi
}

# A renamed skill leaves its previous directory behind in the fixed resources: the
# scan discovers the new name and the copy never removes the old one, so both
# spellings would render into every session. Name each rename's previous
# spelling here once. A name that any fleet checkout exports again is in
# service and is left alone. Like every removal here, this belongs to the
# explicit full installer; the six-hour sync stays additive.
renamed_pack_skill_names=(
    supervisor
)

remove_renamed_pack_skills() {
    local name project target pi_target in_service

    for name in "${renamed_pack_skill_names[@]}"; do
        in_service=0
        for project in "$code_root"/agent*/; do
            [ -f "$project/skills/$name/SKILL.md" ] || continue
            in_service=1
            break
        done
        if [ "$in_service" -eq 1 ]; then
            printf 'Leaving the %s skill in place; a fleet checkout exports it again.\n' "$name"
            continue
        fi

        target="$resources_root/skills/$name"
        if [ -d "$target" ]; then
            rm -rf -- "$target"
            printf 'Removed the renamed skill left in the fixed resources: %s.\n' "$target"
        fi

        pi_target="$HOME/.pi/agent/skills/$name"
        if [ -L "$pi_target" ]; then
            case "$(readlink "$pi_target")" in
                "$resources_root"/skills/*) unlink "$pi_target" ;;
            esac
        fi
    done
}

# The extra model records are retired. Remove only the exact symlink this
# checkout previously created; an independent file or differently-targeted
# symlink belongs to its owner and is left alone.
remove_retired_llm_config() {
    local retired_source="$repo_root/config/llm/extra-openai-models.yaml"
    local target="$HOME/Library/Application Support/io.datasette.llm/extra-openai-models.yaml"

    if [ -L "$target" ] && [ "$(readlink "$target")" = "$retired_source" ]; then
        rm -- "$target"
        printf 'Removed retired AgentStart-owned llm model configuration: %s.\n' "$target"
    elif [ -e "$target" ] || [ -L "$target" ]; then
        printf 'Leaving independent llm model configuration untouched: %s.\n' "$target"
    fi
}


# The voice server configuration is fleet wiring, so AgentStart owns it:
# prompts/agentvoice/server.json is the source of truth. The orchestrator
# doctrine is general agent doctrine: agentguidance renders it into
# ~/.agents/prompts/agentvoice/ — shared orchestrator fragments spliced by
# its post-sync hook — and this installer decides only that AgentVoice
# discovers the result, which is why link_agentvoice_config runs after
# sync-skills has rendered.
# The filenames — ORCHESTRATOR.md, ORCHESTRATOR_SESSION_START.md,
# server.json — are AgentVoice's discovery contract
# (~/code/agentvoice/docs/field-guide.md documents every lever); a file it
# does not recognize primes nothing. The AgentVoice server reads them once
# at boot, so changes apply on its next start — the six-hourly sync may
# re-render doctrine content unattended, and no restart is needed. Per-file
# links, never the directory: the target also holds files this checkout
# does not own.
link_agentvoice_config() {
    local config_dir="$HOME/.config/agentvoice"
    local rendered_dir="$HOME/.agents/prompts/agentvoice"
    local name
    local source
    local target

    for name in ORCHESTRATOR.md ORCHESTRATOR_SESSION_START.md server.json; do
        case "$name" in
        server.json) source="$repo_root/prompts/agentvoice/$name" ;;
        *) source="$rendered_dir/$name" ;;
        esac
        target="$config_dir/$name"
        [ -s "$source" ] \
            || die "AgentVoice doctrine source is missing or empty: $source"
        if [ ! -L "$target" ] && [ -s "$target" ]; then
            die "refusing to replace independent AgentVoice configuration: $target"
        fi
        mkdir -p "$config_dir"
        ln -sfn "$source" "$target"
        cmp -s "$source" "$target" \
            || die "linked AgentVoice configuration does not resolve to $source: $target"
    done
}

# The operator extension prompts are cross-project guidance, so AgentStart
# owns them: prompts/agentguidance/ here is the source of truth, and
# ~/.config/agentguidance is links into this checkout. Agentguidance's
# renderer reads that directory when composing the collab and build skills,
# so these links must exist before its post-sync hook fires in sync-skills.
# The recognized names — SYSTEM.md, GUIDELINES.md, TOOLS.md — are
# agentguidance's contract; an unrecognized file renders to nothing. An
# independent non-symlink file with content is preserved and reported, the
# same conflict rule as the guidance links above.
link_extension_prompts() {
    local config_dir="$HOME/.config/agentguidance"
    local name
    local source
    local target

    for name in SYSTEM.md GUIDELINES.md TOOLS.md; do
        source="$repo_root/prompts/agentguidance/$name"
        target="$config_dir/$name"
        [ -f "$source" ] \
            || die "extension prompt source is missing: $source"
        [ -s "$source" ] \
            || die "extension prompt source is empty: $source"
        if [ ! -L "$target" ] && [ -s "$target" ]; then
            die "refusing to replace independent extension prompt: $target"
        fi
        mkdir -p "$config_dir"
        ln -sfn "$source" "$target"
        cmp -s "$source" "$target" \
            || die "linked extension prompt does not resolve to $source: $target"
    done
}

# Everything this repository owns as content, in the one order that works.
#
# The full install runs this as its last act, and `--content` runs it alone.
# That is the whole difference between the two: a full install converges the
# machine — Homebrew formulas, the harness CLIs, built binaries, services —
# and then converges content on top of it, while `--content` trusts that the
# machine is already there and rebuilds only what a `git pull` in this
# checkout can change.
#
# It is not a second installer and not a second synchronization path. Every
# step below is a step the full install already ran, called from one place so
# the two can never disagree about what content convergence means.
#
# What it deliberately leaves out is anything that installs, upgrades, or
# downloads: the pinned third-party skill packs, the Pi subagents package, and
# the retired-harness-integration cleanup that touches live harness state.
# Those persist from the last full install, and the renderer below carries
# whatever they left behind. A machine that has never had a full install is
# not a machine this mode can converge.
converge_repo_content() {
    printf 'Removing the retired home guidance hub if AgentStart owns it.\n'
    remove_retired_home_guidance

    printf 'Linking the operator extension prompts into ~/.config/agentguidance.\n'
    link_extension_prompts

    printf 'Removing the retired llm model configuration if AgentStart owns it.\n'
    remove_retired_llm_config

    # This cleanup belongs only to the explicit full installer. sync-skills is
    # the six-hour unattended path and remains additive: it never uninstalls a
    # skill that may be in use by a live session. The exact managed set is the
    # external packs, every discovered fleet skill, and the previous install
    # receipt; independent compatibility-root occupants are preserved.
    printf 'Removing AgentStart-managed skills from Fx-visible compatibility roots.\n'
    remove_legacy_global_skills

    printf 'Retiring AgentStart-owned legacy plugin registrations and marketplace.\n'
    remove_retired_core_plugin

    # The fleet statusline is harness configuration in each CLI's own idiom, so
    # it converges here rather than from a launcher. It reads config the harness
    # installers create, which is why content convergence assumes a machine a
    # full install has already been through.
    "$script_dir/install-statusline" --install

    # A renamed skill leaves its previous directory behind in the fixed resources,
    # and the additive sync below would render both spellings into every
    # session. Remove before the sync, never after.
    printf 'Removing renamed skills left behind in the fixed resources.\n'
    remove_renamed_pack_skills

    # Every agent tool publishes its skills by convention — skills/<name>/
    # inside a checkout named agent* — so they are discovered rather than
    # listed here, and a tool that adds or renames a skill needs no edit in
    # this file. That includes this checkout's own skills and agentguidance's,
    # whose post-sync hook re-renders the templates the scan ships against the
    # operator extension prompts linked above.
    "$script_dir/sync-skills"

    # Both managed consumers are installed earlier in the full convergence and
    # now read the fixed resources. The old projections and pack receipts are
    # not a compatibility surface; remove only the ownership-proven tree.
    printf 'Retiring the ownership-proven capability-pack tree.\n'
    remove_retired_capability_resources

    # The renderer above copied Herdr's generated Pi extension into the private resources.
    # Only the explicit full installer retires the ambient source; the
    # six-hour sync must remain additive and leave live-session resources in
    # place.
    printf 'Retiring AgentStart-owned ambient Pi resources after private rendering.\n'
    remove_packed_pi_ambient_resources

    # The sync above renders the canonical guidance source. Link
    # the three harness discovery slots only after that source is guaranteed
    # to exist.
    printf 'Linking the fleet harness guidance for Claude Code, Codex, and pi.\n'
    link_agent_guidance

    # The sync above is where agentguidance renders the orchestrator doctrine,
    # so only now can it be linked where the server discovers it.
    printf 'Linking the AgentVoice doctrine into ~/.config/agentvoice.\n'
    link_agentvoice_config
}

case "${1:-}" in
    --install)
        ;;
    --check)
        check_only=1
        ;;
    --content)
        content_only=1
        ;;
    -h|--help)
        usage
        exit 0
        ;;
    *)
        usage >&2
        exit 64
        ;;
esac
[ "$#" -eq 1 ] || {
    usage >&2
    exit 64
}

# Content convergence is the tail of a full install run on its own. It refuses
# to guess at a machine it has never seen: without the fixed resources there has
# been no full install, and rendering content into a machine whose harnesses
# and binaries are absent would report success over a half-built system.
if [ "$content_only" -eq 1 ]; then
    [ "$(uname -s)" = Darwin ] || die "macOS is required"
    [ "$(id -u)" -ne 0 ] || die "run as the target user, not root"
    command -v npx >/dev/null 2>&1 || die "npx is required to install agent skills"
    [ -d "$resources_root" ] \
        || die "no fixed fleet resources at $resources_root; run scripts/install.sh --install first"
    printf 'Converging AgentStart repository content only; installing nothing.\n'
    converge_repo_content
    printf 'AgentStart content convergence complete.\n'
    exit 0
fi

if [ "$check_only" -eq 1 ]; then
    cat <<'EOF'
Command-line tools:
  curl -fsSL https://claude.ai/install.sh | XDG_CACHE_HOME=~/Library/Caches bash  # keep vendor staging off a machine-managed ~/.cache symlink
  curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh
  curl -fsSL https://pi.dev/install.sh | sh  # in its own session, no controlling terminal
  brew install or upgrade zig  # AgentVoice's native duplex audio path builds against it
  ~/code/fxnk/scripts/install.sh --install --sha d5e5da7aad0bbfa9b0792a02f72e802e8606b20c  # exact ship-gate-approved Fx Integration consumer pin
  brew install or upgrade llm  # an AI CLI, so AgentStart's outright — moved out of the machine's Brewfile
  brew install or upgrade hunk  # review-first diff TUI whose bundled agent skill follows the installed build
  brew install or upgrade rustup  # Terminal Control builds from crates.io with the current stable Rust toolchain
  brew install or upgrade zig@0.15  # Terminal Control's libghostty-vt build requires the keg-only 0.15 line
  "$(brew --prefix rustup)/bin/rustup" toolchain install stable --profile minimal
  PATH="$(brew --prefix)/opt/zig@0.15/bin:$PATH" "$(brew --prefix rustup)/bin/rustup" run stable cargo install --locked --root "$HOME/.local" terminal-control
  install AgentStart's detached-start shim at ~/.local/bin/termctrl while retaining the upstream executable under ~/.local/libexec/agentstart/terminal-control
  brew install or upgrade herdr only while every default/named server socket is proved inactive  # after cutover, upgrades additionally require explicit inactive-maintenance authorization
  initially select Homebrew Herdr only with explicit inactive-cutover authorization, protocol 21+, and no live or uncertain server sockets, then remove the receipt-proved legacy source build  # ordinary convergence recognizes completed cutover; ambiguous evidence preserves legacy
  herdr integration install claude, codex, and pi  # Claude and Codex are pinned to canonical ~/.claude and ~/.codex, and stale swap-session hooks are pruned
  herdr plugin link ~/code/agentsurface/plugin  # the fleet popup panes + tab-naming plugin; a link registers the checkout path, so relinking is a safe converge
  ~/code/fmx/scripts/install.sh --install  # canonical consumer path: editable fmx plus exact source-built fmx-fx and fmx-zmx pins; reuses AgentStart's already-gated Fx build
  scripts/fmx-config install  # link the Herdr-compatible fmx key subset with the operator's Ctrl-Space prefix
  scripts/herdr-config install  # render, validate, and activate the generated Herdr config, then reload it
  npm install --global @native-sdk/cli@0.7  # the line the native-sdk skill documents
  npm install --global agent-browser@0.33.2  # Agentbrowse provider + Agentscrape stable-session driver share this exact build
  ln -sfn "$(command -v agent-browser)" ~/.local/bin/agent-browser  # the candidate Agentscrape resolves before PATH
  scripts/agentbrowse-config install  # link the locked Artbird-first, already-enabled-Apple-second deployment configuration
  scripts/agent-browser-config install  # select agentbrowse's short-lived ordered provider; no provider server or static URL
  remove AgentStart's retired ~/.local/bin/fmx-release-local helper  # preserve an independent occupant

Agent documentation:
  codex mcp add shadcn -- npx shadcn@latest mcp
  claude mcp add --scope user shadcn -- npx shadcn@latest mcp
  native skills list

Agent guidance:
  ln -sfn ~/.local/share/agentstart/resources/guidance/AGENTS.md ~/.claude/CLAUDE.md  # Claude Code reads CLAUDE.md, not AGENTS.md
  ln -sfn ~/.local/share/agentstart/resources/guidance/AGENTS.md ~/.codex/AGENTS.md  # Codex skips empty guidance files
  ln -sfn ~/.local/share/agentstart/resources/guidance/AGENTS.md ~/.pi/agent/AGENTS.md  # pi's global slot
  remove AgentStart-owned ~/AGENTS.md symlink  # retired hub; independent occupants are preserved
  ln -sfn prompts/agentguidance/{SYSTEM,GUIDELINES,TOOLS}.md into ~/.config/agentguidance  # the extension prompts agentguidance renders against
  ln -sfn prompts/agentvoice/server.json into ~/.config/agentvoice  # the voice server configuration, read at server boot
  ln -sfn ~/.agents/prompts/agentvoice/{ORCHESTRATOR.md,ORCHESTRATOR_SESSION_START.md} into ~/.config/agentvoice  # the voice orchestrator's doctrine; agentguidance renders it, so this links after sync-skills
  remove AgentStart-owned ~/Library/Application Support/io.datasette.llm/extra-openai-models.yaml symlink  # its extra model records are obsolete
  remove ownership-verified AgentSurface, AgentBus, and Orca harness integrations
  remove AgentStart-managed skills from Fx-visible compatibility roots, including retired livekit-simulations  # full install only; independent occupants are preserved

Fixed private fleet resources:
  install external skill packs with --copy into ~/.local/share/agentstart/resources/skills
  https://github.com/vercel-labs/skills: find-skills
  https://github.com/anthropics/skills: frontend-design
  https://github.com/vercel-labs/agent-skills: web-design-guidelines, vercel-react-best-practices
  https://github.com/vercel/ai: ai-sdk
  https://github.com/vercel/ai-elements: ai-elements
  https://github.com/shadcn/ui: shadcn
  https://github.com/vercel-labs/native: native-sdk
  anomalyco/terminal-control@v<installed termctrl version>: terminal-control
  hunk skill path hunk-review  # the review skill ships inside the binary and stays version-matched to it
  install hunk-review with --copy into the fixed resources
  herdr --skill, rendered to ~/.local/share/agentstart/herdr-skill/skills/herdr/SKILL.md  # the surface skill ships inside the binary, so it converges with the installed build, never a stale copy
  install herdr with --copy into the fixed resources
  remove renamed skills left in the fixed resources: supervisor  # full install only; the renamed /supervise skill replaces it

Content convergence (everything below is also scripts/install.sh --content,
which runs it alone and installs nothing):
EOF
    "$script_dir/install-statusline" --check
    "$script_dir/install-pi-subagents" --check
    "$script_dir/install-launchagents" --check
    "$script_dir/remove-retired-agentweb" --check
    printf '  scripts/configure-agentsource-webhooks --check  # silent when Funnel, inspectable GitHub hook state, reconciliation provenance, and the live receiver agree; otherwise an agent-ready handoff\n'
    "$script_dir/sync-skills" --check
    if [ -f "$code_root/agentchats/scripts/install.sh" ]; then
        "$code_root/agentchats/scripts/install.sh" --check
    fi
    if [ -f "$code_root/agentdesk/scripts/install.sh" ]; then
        "$code_root/agentdesk/scripts/install.sh" --check
    fi
    exit 0
fi

[ "$(uname -s)" = Darwin ] || die "macOS is required"
[ "$(id -u)" -ne 0 ] || die "run as the target user, not root"

brew_bin=$(find_brew) || die "Homebrew is not installed"
brew_prefix=$("$brew_bin" --prefix)
brew_owner=$(stat -f '%Su' "$brew_prefix")
[ "$brew_owner" = "$(id -un)" ] \
    || die "Homebrew prefix $brew_prefix is owned by $brew_owner, not $(id -un)"

# The machine already owns these PATH entries in its Stow-managed zsh config.
# Supplying them here prevents vendor installers from appending equivalent lines
# to shell startup files during this run.
original_path=$PATH
export PATH="$HOME/.local/bin:$brew_prefix/bin:/usr/bin:/bin:/usr/sbin:/sbin:$original_path"

install_or_upgrade_formula() {
    local formula="$1"

    if "$brew_bin" list --formula --versions "$formula" >/dev/null 2>&1; then
        "$brew_bin" upgrade --formula --yes "$formula"
    else
        "$brew_bin" install --formula --yes "$formula"
    fi
    "$brew_bin" list --formula --versions "$formula" >/dev/null \
        || die "Homebrew formula verification failed: $formula"
}

export HOMEBREW_NO_ASK=1

# Keep Claude's vendor staging under macOS's stable cache root. This machine's
# ~/.cache may be a machine-managed link to removable scratch storage, while
# the native installer needs its cache path available during every converge.
XDG_CACHE_HOME="$HOME/Library/Caches" install_official "Claude Code" \
    https://claude.ai/install.sh \
    /bin/bash

printf 'Installing Codex CLI with its official installer.\n'
/usr/bin/curl -fsSL https://chatgpt.com/codex/install.sh \
    | CODEX_NON_INTERACTIVE=1 /bin/sh

# Pi requires Node.js 22.19 or newer. The machine initializes the pinned NVM
# default before its Brewfile converges; load that default into this subprocess so
# Pi's official installer can use it.
nvm_script="$brew_prefix/opt/nvm/nvm.sh"
if [ -s "$nvm_script" ]; then
    export NVM_DIR="$HOME/.nvm"
    # shellcheck disable=SC1090
    source "$nvm_script" --no-use
    if nvm version default >/dev/null 2>&1; then
        nvm use --silent default
    fi
fi

printf 'Installing Pi with its official installer.\n'
/usr/bin/curl -fsSL https://pi.dev/install.sh \
    | run_without_controlling_terminal /bin/sh

# Zig builds Native SDK applications and AgentVoice's opt-in native duplex
# audio device, and the machine's Brewfile alone cannot guarantee it is
# present in a session that only runs this script (intentional duplicate of
# that Brewfile).
printf 'Installing or upgrading Zig for Native SDK packaging (intentional duplicate of the machine'\''s Brewfile).\n'
install_or_upgrade_formula zig

# fxnk owns Fx fork maintenance and the hardened integration installer.
# AgentStart decides that the harness is present and invokes that public
# contract without reaching into its checkout or duplicating its branch logic.
fxnk_installer="$code_root/fxnk/scripts/install.sh"
[ -x "$fxnk_installer" ] || die "fxnk installer is unavailable: $fxnk_installer"
printf 'Installing Fx through the fxnk integration contract.\n'
"$fxnk_installer" --install --sha "$fx_integration_sha"

# llm is an AI CLI, so it is AgentStart's outright — moved out of the
# machine's Brewfile rather than duplicated from it.
printf 'Installing or upgrading the llm CLI.\n'
install_or_upgrade_formula llm

# Hunk is a review-first diff TUI for agent-authored changesets. Homebrew owns
# its binary and update path; the version-matched hunk-review skill is copied
# from the installed formula later, after npx is available.
printf 'Installing or upgrading Hunk.\n'
install_or_upgrade_formula hunk

# Terminal Control has no Homebrew formula or release binaries: its supported
# CLI install builds the crates.io release. Rustup gives that build a current
# stable compiler without changing the operator's default toolchain, and its
# libghostty-vt dependency requires the exact Zig 0.15 line below. Cargo's
# install root remains ~/.local so its release bookkeeping and
# upgrades stay native. AgentStart temporarily restores the upstream binary to
# Cargo's expected path before an upgrade, then retains it under libexec and
# puts the detached-start shim back at the public path.
printf 'Installing or upgrading Rustup for the Terminal Control build.\n'
install_or_upgrade_formula rustup
rustup_bin="$brew_prefix/opt/rustup/bin/rustup"
[ -x "$rustup_bin" ] \
    || die "Homebrew's keg-only Rustup executable is missing: $rustup_bin"

# Terminal Control's libghostty-vt dependency pins the Zig 0.15 line, while
# the tracked `zig` formula above has moved past it. Keep the keg-only line
# beside current Zig for that source build.
printf 'Installing or upgrading Zig 0.15 for the Terminal Control build (keg-only, beside the tracked zig).\n'
install_or_upgrade_formula zig@0.15

printf 'Installing the stable Rust toolchain for Terminal Control.\n'
"$rustup_bin" toolchain install stable --profile minimal

termctrl_bin="$HOME/.local/bin/termctrl"
termctrl_real_dir="$HOME/.local/libexec/agentstart/terminal-control"
termctrl_real="$termctrl_real_dir/termctrl"
termctrl_shim="$repo_root/config/terminal-control/termctrl"

# Cargo records the public bin path in its install metadata. Restore the real
# executable before asking Cargo to converge the crate so a same-version run
# remains cheap and an available upgrade can replace the binary normally.
if [ -f "$termctrl_bin" ] &&
    grep -F -m 1 '# AgentStart-managed Terminal Control shim.' \
        "$termctrl_bin" >/dev/null 2>&1; then
    [ -x "$termctrl_real" ] \
        || die "Terminal Control shim is installed but its upstream executable is missing: $termctrl_real"
    install -m 0755 "$termctrl_real" "$termctrl_bin"
fi

printf 'Building and installing Terminal Control from its locked crates.io release.\n'
PATH="$brew_prefix/opt/zig@0.15/bin:$PATH" \
    "$rustup_bin" run stable cargo install --locked --root "$HOME/.local" terminal-control
[ -x "$termctrl_bin" ] \
    || die "Terminal Control did not install an executable at $termctrl_bin"
terminal_control_version_output=$("$termctrl_bin" --version)
terminal_control_version=$terminal_control_version_output
terminal_control_version=${terminal_control_version##* }
[[ "$terminal_control_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]] \
    || die "could not resolve the installed Terminal Control version"

printf 'Installing AgentStart detached-start shim for Terminal Control.\n'
mkdir -p "$termctrl_real_dir"
install -m 0755 "$termctrl_bin" "$termctrl_real"
install -m 0755 "$termctrl_shim" "$termctrl_bin"
[ "$("$termctrl_bin" --version)" = "$terminal_control_version_output" ] \
    || die "Terminal Control shim does not reach the installed upstream release"

# Herdr is the terminal multiplexer agent sessions run inside — an AI tool by
# the boundary rubric, so AgentStart's, not the machine's. Homebrew's stable
# formula owns its binary and normal update path; AgentStart still converges
# the fleet integrations, plugin, behavior config, and bundled skill below.
# Package-manager replacement cannot use Herdr's live handoff. Inspect every
# default/named socket before Homebrew can change the installed client bytes;
# a later inactive convergence performs the deferred install or upgrade.
herdr_socket_state=$("$script_dir/select-herdr-runtime" --socket-state) \
    || die "inspecting Herdr server sockets before Homebrew convergence failed"
herdr_legacy_state=$("$script_dir/select-herdr-runtime" --legacy-state) \
    || die "inspecting legacy Herdr state before Homebrew convergence failed"
herdr_cutover_allowed="${AGENTSTART_HERDR_ALLOW_CUTOVER:-0}"
case "$herdr_cutover_allowed" in
    0|1) ;;
    *) die "AGENTSTART_HERDR_ALLOW_CUTOVER must be 0 or 1" ;;
esac
herdr_formula_installed=0
if "$brew_bin" list --formula --versions herdr >/dev/null 2>&1; then
    herdr_formula_installed=1
fi
case "$herdr_socket_state" in
    inactive)
        if [ "$herdr_legacy_state" = present ] ||
            [ "$herdr_formula_installed" -eq 0 ] ||
            [ "$herdr_cutover_allowed" -eq 1 ]; then
            printf 'Installing or upgrading Herdr from the official stable formula.\n'
            install_or_upgrade_formula herdr
        else
            printf 'Deferring post-cutover Homebrew Herdr upgrade without explicit inactive-maintenance authorization.\n'
        fi
        ;;
    present)
        printf 'Deferring Homebrew Herdr installation or upgrade while a server socket is present.\n'
        ;;
    uncertain)
        printf 'Deferring Homebrew Herdr installation or upgrade because server socket state is uncertain.\n'
        ;;
    *) die "unexpected Herdr socket state: $herdr_socket_state" ;;
esac

# Keep using the source-built protocol-21 client while stable is older or any
# default/named server socket exists. Only a fully compatible, inactive
# cutover removes the old binary, and only with exact ownership evidence.
# Once that evidence is gone, ordinary convergence recognizes Homebrew as the
# already-selected runtime without requiring the one-time cutover flag again.
herdr_bin=$("$script_dir/select-herdr-runtime" "$brew_prefix/bin/herdr") \
    || die "selecting the safe Herdr runtime failed"
if [ "$herdr_bin" = "$brew_prefix/bin/herdr" ]; then
    hash -r
    [ "$(command -v herdr)" = "$herdr_bin" ] \
        || die "Homebrew Herdr does not win PATH after legacy cleanup: $(command -v herdr || printf missing)"
fi

# The harness integrations wire each agent into herdr — pi's is a lifecycle
# authority, while claude's and codex's report session identity (for native
# restore) and deliberately leave lifecycle to herdr's screen detection.
# They install after the three harness CLIs above, because each one
# writes inside a harness's own configuration directory that those installers
# create. Reinstalled unconditionally on every run: a herdr upgrade can leave
# an integration stale — the reason `herdr integration status --outdated-only`
# exists — and reinstalling is how it converges. Unlike the harness
# configuration this installer writes itself, these files belong to herdr, so
# ownership and conflict rules are its installer's to enforce, exactly as they
# are for a fleet checkout's own installer. The harnesses are the three the
# fleet runs; herdr supports more, and adding one here is a deliberate edit.
prune_shadow_codex_herdr_hooks() {
    local hooks_path="$HOME/.codex/hooks.json"

    [ -f "$hooks_path" ] || return 0

    /usr/bin/python3 - "$hooks_path" <<'PYTHON' \
        || die "failed to prune stale herdr hooks from $hooks_path"
import json
import os
import re
import stat
import sys
import tempfile

hooks_path = sys.argv[1]
with open(hooks_path, encoding="utf-8") as source:
    document = json.load(source)

session_start = document.get("hooks", {}).get("SessionStart")
if not isinstance(session_start, list):
    raise SystemExit(0)

shadow_command = re.compile(
    r"^bash '.*?/multi-auth/runtime-shadow-homes/"
    r"codex-multi-auth-runtime-home-[^/']+/herdr-agent-state\.sh' session$"
)
removed = 0
groups = []

for group in session_start:
    if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
        groups.append(group)
        continue

    handlers = []
    for handler in group["hooks"]:
        generated_shadow_hook = (
            isinstance(handler, dict)
            and handler.get("type") == "command"
            and isinstance(handler.get("command"), str)
            and shadow_command.fullmatch(handler["command"]) is not None
        )
        if generated_shadow_hook:
            removed += 1
        else:
            handlers.append(handler)

    if handlers:
        group["hooks"] = handlers
        groups.append(group)

if removed == 0:
    raise SystemExit(0)

document["hooks"]["SessionStart"] = groups
write_path = os.path.realpath(hooks_path)
mode = stat.S_IMODE(os.stat(write_path).st_mode)
temporary = tempfile.NamedTemporaryFile(
    mode="w",
    encoding="utf-8",
    dir=os.path.dirname(write_path),
    prefix=f".{os.path.basename(write_path)}.",
    suffix=".tmp",
    delete=False,
)
try:
    with temporary:
        json.dump(document, temporary, indent=2)
        temporary.write("\n")
        temporary.flush()
        os.fsync(temporary.fileno())
    os.chmod(temporary.name, mode)
    os.replace(temporary.name, write_path)
except BaseException:
    try:
        os.unlink(temporary.name)
    except FileNotFoundError:
        pass
    raise

print(f"Removed {removed} stale Codex multi-auth Herdr hook(s) from {hooks_path}.")
PYTHON
}

prune_swap_claude_herdr_hooks() {
    local settings_path="$HOME/.claude/settings.json"

    [ -f "$settings_path" ] || return 0

    /usr/bin/python3 - "$settings_path" <<'PYTHON' \
        || die "failed to prune stale herdr hooks from $settings_path"
import json
import os
import re
import stat
import sys
import tempfile

settings_path = sys.argv[1]
with open(settings_path, encoding="utf-8") as source:
    document = json.load(source)

session_start = document.get("hooks", {}).get("SessionStart")
if not isinstance(session_start, list):
    raise SystemExit(0)

swap_command = re.compile(
    r"^bash '.*?/\.claude-swap-backup/sessions/"
    r"[^/']+/hooks/herdr-agent-state\.sh' session$"
)
removed = 0
groups = []

for group in session_start:
    if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
        groups.append(group)
        continue

    handlers = []
    for handler in group["hooks"]:
        generated_swap_hook = (
            isinstance(handler, dict)
            and handler.get("type") == "command"
            and isinstance(handler.get("command"), str)
            and swap_command.fullmatch(handler["command"]) is not None
        )
        if generated_swap_hook:
            removed += 1
        else:
            handlers.append(handler)

    if handlers:
        group["hooks"] = handlers
        groups.append(group)

if removed == 0:
    raise SystemExit(0)

document["hooks"]["SessionStart"] = groups
write_path = os.path.realpath(settings_path)
mode = stat.S_IMODE(os.stat(write_path).st_mode)
temporary = tempfile.NamedTemporaryFile(
    mode="w",
    encoding="utf-8",
    dir=os.path.dirname(write_path),
    prefix=f".{os.path.basename(write_path)}.",
    suffix=".tmp",
    delete=False,
)
try:
    with temporary:
        json.dump(document, temporary, indent=2)
        temporary.write("\n")
        temporary.flush()
        os.fsync(temporary.fileno())
    os.chmod(temporary.name, mode)
    os.replace(temporary.name, write_path)
except BaseException:
    try:
        os.unlink(temporary.name)
    except FileNotFoundError:
        pass
    raise

print(f"Removed {removed} stale Claude swap-session Herdr hook(s) from {settings_path}.")
PYTHON
}

install_herdr_integrations() {
    local harness

    for harness in claude codex pi; do
        printf 'Installing the herdr %s integration.\n' "$harness"
        if [ "$harness" = claude ]; then
            # A claude-swap launch runs with CLAUDE_CONFIG_DIR pointed at a
            # per-account session directory whose settings.json is a symlink to
            # the canonical one. Left unpinned, every swapped run appends a
            # second hook — same script, session-local path — to the one shared
            # file. Pin the canonical home and prune any that already landed.
            prune_swap_claude_herdr_hooks
            CLAUDE_CONFIG_DIR="$HOME/.claude" "$herdr_bin" integration install "$harness" \
                || die "herdr integration install failed: $harness"
        elif [ "$harness" = codex ]; then
            # A Codex-swap launch runs with a disposable CODEX_HOME. Never let
            # that session-local path enter the canonical hook definition:
            # Codex trusts the definition hash, so every new path asks again.
            prune_shadow_codex_herdr_hooks
            CODEX_HOME="$HOME/.codex" "$herdr_bin" integration install "$harness" \
                || die "herdr integration install failed: $harness"
        else
            "$herdr_bin" integration install "$harness" \
                || die "herdr integration install failed: $harness"
        fi
    done
}

install_herdr_integrations

# AgentSurface's herdr plugin (the titled fleet TUI popups plus tab naming from
# a conversation's first prompt) registers by link, not copy: herdr records the
# checkout path, so a changed checkout needs no relink and relinking the same
# path is a safe converge. During the one-time move from a newer source build
# to stable, the resident server may speak a newer protocol than the installed
# client. Preserve its existing link and defer the idempotent relink until the
# operator's natural server restart rather than stopping panes to force it.
# The registered plugin belongs to herdr; the plugin directory belongs to the
# agentsurface checkout, whose absence is a skip exactly as in
# install-agent-clis.
install_herdr_plugins() {
    local plugin_root="$code_root/agentsurface/plugin"
    local link_output=''

    if [ ! -f "$plugin_root/herdr-plugin.toml" ]; then
        printf 'AgentStart installer: no agentsurface plugin at %s; skipping.\n' "$plugin_root"
        return 0
    fi
    printf 'Linking the agentsurface herdr plugin.\n'
    if ! link_output=$("$herdr_bin" plugin link "$plugin_root" 2>&1); then
        case "$link_output" in
            *'"code":"protocol_mismatch"'*)
                printf 'AgentStart installer: preserving the existing agentsurface plugin link; relink deferred until the natural Herdr server restart: %s\n' \
                    "$link_output" >&2
                return 0
                ;;
        esac
        printf '%s\n' "$link_output" >&2
        die "herdr plugin link failed: $plugin_root"
    fi
    [ -z "$link_output" ] || printf '%s\n' "$link_output"
}

install_herdr_plugins

# fmx owns its consumer and operator source installation. AgentStart delegates
# the editable link and both exact native pins to that entrypoint, passing the
# Fx binary fxnk just built only after proving fmx names the same Integration
# commit. A machine without the checkout skips; a present checkout that fails
# to install is a real error.
fmx_root="$code_root/fmx"
if [ -f "$fmx_root/package.json" ]; then
    [ -f "$fmx_root/fx.json" ] \
        || die "fmx checkout has no fx.json; update $fmx_root"
    fmx_fx_sha=$(jq -r '.commit' "$fmx_root/fx.json") \
        || die "fmx's fx.json is not valid JSON"
    [ "$fmx_fx_sha" = "$fx_integration_sha" ] \
        || die "fmx pins Fx $fmx_fx_sha, but AgentStart pins $fx_integration_sha"
    development_fx="$HOME/.local/bin/fx"
    [ -x "$development_fx" ] \
        || die "fxnk did not install an executable $development_fx"
    [ -x "$fmx_root/scripts/install.sh" ] \
        || die "fmx checkout has no executable scripts/install.sh; update $fmx_root"
    printf 'Installing fmx through its canonical source installer.\n'
    FMX_FX_BINARY="$development_fx" \
    FMX_FX_COMMIT="$fx_integration_sha" \
    FMX_FX_CHECKOUT="$HOME/src/fx" \
    FMX_COMPANION_CHECKOUT="$HOME/src/zmx" \
    FMX_INSTALL_BIN_DIR="$HOME/.local/bin" \
        "$fmx_root/scripts/install.sh" --install \
        || die "fmx source installation failed"
else
    printf 'AgentStart installer: no fmx checkout at %s; skipping fmx.\n' \
        "$fmx_root"
fi

# fmx never writes its configuration, so its Herdr-compatible key subset can
# stay linked directly to AgentStart's tracked operator configuration.
printf "Linking AgentStart's fmx configuration.\n"
"$script_dir/fmx-config" install

# Herdr's live configuration is rendered rather than linked, because Herdr
# writes its own keys into it and neither checkout may become program-written
# state. The helper validates the candidate before an atomic replacement and
# reloads a running server. It carries no palette: Herdr's `terminal` theme
# follows the terminal, which runs its own default colors.
printf "Rendering AgentStart's Herdr configuration.\n"
AGENTSTART_HERDR_BIN="$herdr_bin" "$script_dir/herdr-config" install

command -v npm >/dev/null 2>&1 || die "npm is required to install the Native SDK CLI"

# The native-sdk skill documents the 0.7 line and its agent helpers are
# version-matched to it, so pin that line here instead of tracking latest.
native_sdk_version=0.7
printf 'Installing the Native SDK CLI %s and its version-matched agent helpers.\n' \
    "$native_sdk_version"
npm install --global "@native-sdk/cli@$native_sdk_version"

# agent-browser is the driver shared by Agentbrowse and Agentscrape. It is
# pinned rather than tracked: Agentbrowse implements this release's provider
# protocol, and Agentscrape resolves the stable candidate below before PATH.
# Raising this version means verifying both consumers against the new build.
agent_browser_version=0.33.2
printf 'Installing agent-browser %s for Agentbrowse and Agentscrape.\n' \
    "$agent_browser_version"
npm install --global "agent-browser@$agent_browser_version"

# Publish the stable candidate Agentscrape resolves before falling back to PATH.
# Both consumers run under launchd, whose minimal PATH never reaches a tool
# installed under a Node version manager, and the version-manager path itself
# changes with every Node upgrade. This link is the one address that does not.
link_agent_browser() {
    local source
    local target="$HOME/.local/bin/agent-browser"

    source=$(command -v agent-browser) \
        || die "agent-browser is not on PATH after installing it"
    if [ -e "$target" ] && [ ! -L "$target" ]; then
        die "refusing to replace independent file: $target"
    fi
    mkdir -p "$HOME/.local/bin"
    ln -sfn "$source" "$target"
    [ -x "$target" ] || die "linked agent-browser is not executable: $target"
}

printf 'Linking the stable agent-browser candidate into ~/.local/bin.\n'
link_agent_browser

command -v npx >/dev/null 2>&1 || die "npx is required to install agent skills"

# Remove only the helper shape AgentStart installed. The operator's general
# file-backed Vercel login is independent account state and is left untouched.
retired_fmx_release="$HOME/.local/bin/fmx-release-local"
if [ -f "$retired_fmx_release" ] \
    && grep -F 'repo=possibilities/fmx' "$retired_fmx_release" >/dev/null \
    && grep -F 'fmx-release-local build --run-id' "$retired_fmx_release" >/dev/null; then
    rm -f "$retired_fmx_release"
    printf 'Removed retired AgentStart Fmx release helper: %s.\n' "$retired_fmx_release"
elif [ -e "$retired_fmx_release" ]; then
    printf 'Preserving independent occupant at retired Fmx release path: %s.\n' "$retired_fmx_release"
fi

configure_shadcn_mcp

printf 'Removing retired AgentSurface, AgentBus, and Orca harness integrations.\n'
retired_integrations_status=0
"$script_dir/remove-retired-integrations" || retired_integrations_status=$?
if [ "$retired_integrations_status" -ne 0 ]; then
    printf 'AgentStart installer: retired integration cleanup failed (exit %s). Fix the reported problem, then rerun scripts/install.sh --install or scripts/remove-retired-integrations.\n' \
        "$retired_integrations_status" >&2
    exit "$retired_integrations_status"
fi

# Pi ships no subagents deliberately and points at third-party packages
# instead, so the fleet installs one and pins it. This must precede the skill
# sync below, because that is what renders the fixed private resources, and the
# renderer carries whatever this step has installed.
"$script_dir/install-pi-subagents" --install

printf 'Installing the common skill discovery helper.\n'
install_private_skill_pack https://github.com/vercel-labs/skills find-skills

printf 'Installing the privately managed design skills.\n'
install_private_skill_pack https://github.com/anthropics/skills frontend-design
install_private_skill_pack https://github.com/vercel-labs/agent-skills web-design-guidelines

printf 'Installing Vercel React engineering guidance.\n'
install_private_skill_pack https://github.com/vercel-labs/agent-skills vercel-react-best-practices

printf 'Installing the official Vercel AI SDK and AI Elements skills.\n'
install_private_skill_pack https://github.com/vercel/ai ai-sdk
install_private_skill_pack https://github.com/vercel/ai-elements ai-elements

printf 'Installing the official shadcn skill.\n'
install_private_skill_pack https://github.com/shadcn/ui shadcn

printf 'Installing the Native SDK discovery skill.\n'
install_private_skill_pack https://github.com/vercel-labs/native native-sdk

# Bind the runbook to the same release as the CLI. The skills CLI accepts a
# GitHub ref suffix, and Terminal Control publishes v<crate-version> tags, so a
# new crates.io release and its skill converge together instead of teaching a
# command surface from repository head against an older installed binary.
printf 'Installing the version-matched Terminal Control skill.\n'
install_private_skill_pack \
    "anomalyco/terminal-control@v$terminal_control_version" terminal-control

# Hunk ships its agent-facing review surface inside the installed binary. Use
# `hunk skill path` as the authority instead of copying the GitHub head: the
# skill describes the exact `hunk session` commands this build accepts. The
# resolved package root already has the skills/<name>/SKILL.md shape consumed
# by the common capability-pack renderer. Deliberately not advertised in
# TOOLS.md: its own trigger covers live Hunk sessions and interactive diff
# review without spending attention in unrelated conversations (see the
# tool-advertisement-policy wiki page).
install_hunk_skill() {
    local skill_file skill_dir pack_root

    skill_file=$(hunk skill path hunk-review) \
        || die "locating the bundled Hunk review skill failed"
    [ -f "$skill_file" ] \
        || die "the installed Hunk review skill is missing: $skill_file"

    skill_dir=$(cd -P -- "$(dirname -- "$skill_file")" && pwd) \
        || die "resolving the bundled Hunk review skill directory failed"
    skill_file="$skill_dir/${skill_file##*/}"
    [ "${skill_dir##*/}" = hunk-review ] \
        || die "the installed Hunk review skill has an unexpected path: $skill_file"
    pack_root=$(cd -P -- "$skill_dir/../.." && pwd) \
        || die "resolving the installed Hunk skill pack failed"
    [ "$pack_root/skills/hunk-review/SKILL.md" = "$skill_file" ] \
        || die "the installed Hunk review skill does not match its pack root: $skill_file"

    install_private_skill_pack "$pack_root" hunk-review
}

printf 'Installing the Hunk review skill from the installed binary.\n'
install_hunk_skill

# The surface skill — herdr is the orchestrator doctrine's reference launch
# surface — ships inside the herdr binary (`herdr --skill`), so the installed
# skill converges with the installed build on every run, exactly like the
# harness integrations above, and never tracks a different release than the
# stable formula. The rendered pack lives
# in a managed state root shaped like a checkout (skills/herdr/) so the same
# `skills add` mechanism ships it into the fixed private resources. Deliberately
# not advertised in TOOLS.md: a role skill is named by the orchestrator
# doctrine, not by the always-on advertisement surface (the
# tool-advertisement-policy wiki page).
install_herdr_skill() {
    local pack_root="$HOME/.local/share/agentstart/herdr-skill"
    local skill_dir="$pack_root/skills/herdr"

    mkdir -p "$skill_dir"
    "$herdr_bin" --skill >"$skill_dir/SKILL.md" \
        || die "rendering the herdr skill from the installed binary failed"
    [ -s "$skill_dir/SKILL.md" ] \
        || die "the installed herdr rendered an empty skill"
    install_private_skill_pack "$pack_root" herdr
}

printf 'Installing the herdr surface skill from the installed binary.\n'
install_herdr_skill

printf 'Verifying the installed Native SDK agent documentation helpers.\n'
native skills list >/dev/null

# The AgentVoice voice CLI is linked editable from its own checkout by its
# cli:install contract (dependencies, sox, a global bun link). AgentStart only
# invokes it; a machine without the checkout skips inside the script, so only
# a present-but-broken checkout fails here.
agentvoice_cli_status=0
"$script_dir/install-agentvoice-cli" || agentvoice_cli_status=$?
if [ "$agentvoice_cli_status" -ne 0 ]; then
    printf 'AgentStart installer: AgentVoice CLI install failed (exit %s). Fix the reported problem, then rerun scripts/install.sh --install or scripts/install-agentvoice-cli.\n' \
        "$agentvoice_cli_status" >&2
    exit "$agentvoice_cli_status"
fi

# The fleet CLIs install by their own hardened
# contract (frozen deps, ~/.local/bin symlink, deployed-SHA receipt). AgentStart
# only invokes it; a machine without a checkout skips inside the script, so
# only a present-but-broken checkout fails here.
agent_clis_status=0
"$script_dir/install-agent-clis" || agent_clis_status=$?
if [ "$agent_clis_status" -ne 0 ]; then
    printf 'AgentStart installer: agent CLIs install failed (exit %s). Fix the reported problem, then rerun scripts/install.sh --install or scripts/install-agent-clis.\n' \
        "$agent_clis_status" >&2
    exit "$agent_clis_status"
fi

# Agentbrowse and agent-browser do not write these configs during normal
# browsing, so the operator defaults can stay linked directly to AgentStart's
# tracked sources. Run both after the fleet CLI loop: a successful full
# converge must not select the provider before its command and manual recovery
# helper install successfully.
printf "Linking AgentStart's ordered agentbrowse deployment configuration.\n"
"$script_dir/agentbrowse-config" install
printf "Linking AgentStart's default agentbrowse provider configuration.\n"
"$script_dir/agent-browser-config" install

# cass — the coding-agent session search CLI — installs by the agentchats
# checkout's own contract: the upstream checksummed release plus the index
# over the local Claude Code, Codex, and Pi session stores. Its chats skill
# ships through the agent* checkout skill scan like every other tool's. A
# machine without the checkout skips, like the agent CLIs above; a present
# checkout that fails to install is a real error.
agentchats_root="$code_root/agentchats"
if [ -f "$agentchats_root/scripts/install.sh" ]; then
    agentchats_status=0
    "$agentchats_root/scripts/install.sh" --install || agentchats_status=$?
    if [ "$agentchats_status" -ne 0 ]; then
        printf 'AgentStart installer: cass install failed (exit %s). Fix the reported problem, then rerun scripts/install.sh --install or %s/scripts/install.sh --install.\n' \
            "$agentchats_status" "$agentchats_root" >&2
        exit "$agentchats_status"
    fi
else
    printf 'AgentStart installer: no agentchats checkout at %s; skipping cass.\n' \
        "$agentchats_root"
fi

# peekaboo — the macOS GUI capture and automation CLI — installs by the
# agentdesk checkout's own contract: the official tap formula, the TCC
# permission verification (grants stay the human's act), and a served-capture
# gate. Its desktop skill ships through the agent* checkout skill scan like
# every other tool's. A machine without the checkout skips; a present
# checkout that fails to install is a real error.
agentdesk_root="$code_root/agentdesk"
if [ -f "$agentdesk_root/scripts/install.sh" ]; then
    agentdesk_status=0
    "$agentdesk_root/scripts/install.sh" --install || agentdesk_status=$?
    if [ "$agentdesk_status" -ne 0 ]; then
        printf 'AgentStart installer: peekaboo install failed (exit %s). Fix the reported problem, then rerun scripts/install.sh --install or %s/scripts/install.sh --install.\n' \
            "$agentdesk_status" "$agentdesk_root" >&2
        exit "$agentdesk_status"
    fi
else
    printf 'AgentStart installer: no agentdesk checkout at %s; skipping peekaboo.\n' \
        "$agentdesk_root"
fi

# The fleet's long-running services. This runs after every CLI above, because
# a service is only installed once the binary it supervises exists — a tool
# that is absent is skipped, exactly like its checkout was. The fleet
# checkouts ship the code; this repository decides when it runs. The machine
# layer keeps its own services, which are the reverse-DNS labels.
printf 'Installing the fleet launch agents.\n'
"$script_dir/install-launchagents" --install

# Service retirement must complete before the old command wrapper disappears:
# otherwise launchd can restart a KeepAlive broker against a half-removed
# installation. install-launchagents proves ownership, boots out the loaded
# job, removes its plist, and rewrites Agentbrain without conduit variables;
# only after it returns may these marker-owned command artifacts be removed.
printf 'Removing retired Agentweb command artifacts.\n'
"$script_dir/remove-retired-agentweb" --install

# Authorization is never implicit in ordinary convergence. Diagnose the
# receiver and inspectable webhook path after its CLI and resident service
# exist; incomplete state prints an agent-ready handoff while a healthy machine
# remains quiet.
"$script_dir/configure-agentsource-webhooks" --check || true

# Everything this repository owns as content — skills, prompts, guidance, the
# statusline, and the rendered private resources — converges last, on top of the
# machine the steps above just built. `--content` runs exactly this and nothing
# else, which is why it lives in one function rather than inline here.
converge_repo_content
