#!/bin/bash

set -euo pipefail

root=$(cd -P -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

fail() {
    printf 'validate: %s\n' "$*" >&2
    exit 1
}

shell_files="
scripts/install.sh
scripts/sync-skills
scripts/run-skills-cli
scripts/render-capabilities
scripts/sync-codex-skill-policy
scripts/install-agent-clis
scripts/install-agentlaunch-shims
scripts/install-agentvoice-cli
scripts/remove-retired-integrations
scripts/remove-retired-agentweb
scripts/install-launchagents
scripts/configure-agentsource-webhooks
scripts/agentbrowse-config
scripts/agent-browser-config
scripts/fmx-config
scripts/herdr-config
scripts/select-herdr-runtime
tests/validate.sh
tests/agentbrowse-config.sh
tests/agent-browser-config.sh
tests/fmx-config.sh
tests/herdr-config.sh
tests/herdr-homebrew-cutover.sh
tests/agentsource-webhooks.sh
tests/install-launchagents.sh
tests/remove-retired-agentweb.sh
tests/fixtures/npx
tests/fixtures/herdr-protocol
"

for file in $shell_files; do
    /bin/bash -n "$file"
done

if command -v shellcheck >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    shellcheck --shell=bash $shell_files
fi

for script in scripts/install.sh scripts/sync-skills scripts/install-agent-clis \
    scripts/run-skills-cli \
    scripts/install-agentlaunch-shims scripts/render-capabilities scripts/install-launchagents \
    scripts/configure-agentsource-webhooks \
    scripts/sync-codex-skill-policy \
    scripts/render-skill-invocation-policy \
    scripts/install-agentvoice-cli scripts/remove-retired-integrations \
    scripts/remove-retired-agentweb \
    scripts/agentbrowse-config scripts/agent-browser-config scripts/fmx-config scripts/herdr-config \
    scripts/select-herdr-runtime; do
    [ -x "$script" ] || fail "installer script is not executable: $script"
done
[ -x tests/agentbrowse-config.sh ] \
    || fail "agentbrowse config test is not executable: tests/agentbrowse-config.sh"
[ -x tests/agent-browser-config.sh ] \
    || fail "agent-browser config test is not executable: tests/agent-browser-config.sh"
[ -x tests/fmx-config.sh ] \
    || fail "fmx config test is not executable: tests/fmx-config.sh"
[ -x tests/herdr-config.sh ] \
    || fail "Herdr config test is not executable: tests/herdr-config.sh"
[ -x tests/herdr-homebrew-cutover.sh ] \
    || fail "Herdr Homebrew cutover test is not executable: tests/herdr-homebrew-cutover.sh"
[ -x tests/agentsource-webhooks.sh ] \
    || fail "Agentsource webhook test is not executable: tests/agentsource-webhooks.sh"
[ -x tests/install-launchagents.sh ] \
    || fail "launch agent installer test is not executable: tests/install-launchagents.sh"
[ -x tests/remove-retired-agentweb.sh ] \
    || fail "retired Agentweb cleanup test is not executable: tests/remove-retired-agentweb.sh"
[ -x config/terminal-control/termctrl ] \
    || fail "Terminal Control shim is missing or not executable"
/usr/bin/python3 -c \
    'import pathlib; compile(pathlib.Path("config/terminal-control/termctrl").read_text(), "config/terminal-control/termctrl", "exec")'

[ -s config/agentbrowse/config.json ] \
    || fail "default agentbrowse config is missing or empty"
/usr/bin/jq -e '
    .version == 2 and
    (.backends | map(.id)) == ["artbird", "apple-container-local"] and
    .backends[1].maxTargets == 1 and
    .backends[1].cpus == 2 and
    .backends[1].memory == "6G" and
    .images.defaultImage == "docker.io/onkernel/chromium-headful@sha256:da9ee68cb9d2de0b3c26885ff3bdcf04c944254a36eb127219028ac017ff56f3"
' config/agentbrowse/config.json >/dev/null \
    || fail "default agentbrowse config does not declare the locked ordered fallback"
tests/agentbrowse-config.sh

[ -s config/agent-browser/config.json ] \
    || fail "default agent-browser config is missing or empty"
/usr/bin/jq -e '
    .provider == "agentbrowse" and
    (.plugins == [{
        "name": "agentbrowse",
        "command": "/bin/sh",
        "args": ["-c", "exec \"$HOME/.local/bin/agentbrowse\" provider"],
        "capabilities": ["browser.provider"]
    }])
' config/agent-browser/config.json >/dev/null \
    || fail "default agent-browser config does not select the agentbrowse provider"
tests/agent-browser-config.sh
tests/agentsource-webhooks.sh
tests/install-launchagents.sh
tests/remove-retired-agentweb.sh
[ -x scripts/remove-retired-json-hooks.ts ] \
    || fail "retired JSON hook cleanup helper is not executable"
for supervise_script in \
    skills/supervise/scripts/watch.ts \
    skills/supervise/scripts/integrate.ts \
    skills/supervise/scripts/reap.ts \
    skills/supervise/scripts/status.ts; do
    [ -x "$supervise_script" ] \
        || fail "supervise helper is not executable: $supervise_script"
done

# The obsolete llm model records stay gone, and the retired Orca overlay must
# not return as a second harness-configuration path.
[ ! -e config/llm/extra-openai-models.yaml ] \
    || fail "obsolete llm model records returned"
[ ! -e config/orca ] \
    || fail "retired Orca overlay returned"
[ ! -e scripts/configure-orca ] \
    || fail "retired Orca overlay installer returned"
[ ! -e scripts/install-agentbus-adapters ] \
    || fail "retired AgentBus adapter installer returned"
[ ! -e scripts/install-agentsurface-shims ] \
    || fail "retired AgentSurface shim installer returned"

for manifest in config/resources/*.json; do
    /usr/bin/jq -e . "$manifest" >/dev/null \
        || fail "resource manifest is not valid JSON: $manifest"
done
/usr/bin/jq -e '.name == "agent"' config/resources/claude-plugin.json >/dev/null \
    || fail "Claude fleet plugin has the wrong name"
/usr/bin/jq -e '.name == "agent" and .skills == "./skills/" and .interface.capabilities == ["Skills"]' \
    config/resources/codex-plugin.json >/dev/null \
    || fail "Codex fleet plugin is not strictly skills-only"
if grep -Ei '"(hooks|mcpServers|apps)"[[:space:]]*:' config/resources/codex-plugin.json >/dev/null; then
    fail "Codex fleet plugin declares a globally active non-skill surface"
fi
[ -z "$(find config/capabilities -type f -print 2>/dev/null)" ] \
    || fail "retired capability-pack templates returned"
if grep -RFq 'AGENTSTART_CAPABILITIES_ROOT' scripts config README.md docs 2>/dev/null; then
    fail "retired AGENTSTART_CAPABILITIES_ROOT remains in active repository surfaces"
fi
[ ! -e scripts/install-core-plugin ] \
    || fail "retired core-plugin installer returned"
[ ! -e config/core-plugin ] \
    || fail "retired core-plugin manifests returned"

# The installer links these into ~/.config/agentguidance and agentguidance
# renders every skill against them, so an empty or missing prompt ships
# broken skills to a fresh account.
for prompt in SYSTEM.md GUIDELINES.md TOOLS.md; do
    [ -s "prompts/agentguidance/$prompt" ] \
        || fail "extension prompt is missing or empty: prompts/agentguidance/$prompt"
done
# Persistent guidance is file-backed rather than delegated to harness memory,
# and fleet-specific personal guidance stays in AgentStart's extension layer.
grep -F 'Do not use harness-provided agent memory' prompts/agentguidance/GUIDELINES.md >/dev/null \
    || fail "GUIDELINES.md does not reject harness-provided agent memory"
grep -F 'Place global personal guidance tied to the' prompts/agentguidance/GUIDELINES.md >/dev/null \
    || fail "GUIDELINES.md does not keep fleet-specific personal guidance in AgentStart"
# Gist publication is a GitHub CLI operation over the durable wiki file. Pin
# both the create-and-open route and the existing-Gist route so agents do not
# fall back to a browser app or create a duplicate merely to open it.
grep -F 'gh gist create FILE --desc "…" --web' prompts/agentguidance/GUIDELINES.md >/dev/null \
    || fail "GUIDELINES.md does not create and open a requested Gist with gh"
grep -F 'gh gist view GIST_ID --web' prompts/agentguidance/GUIDELINES.md >/dev/null \
    || fail "GUIDELINES.md does not open an existing Gist with gh"
grep -F 'public indexing was explicitly' prompts/agentguidance/GUIDELINES.md >/dev/null \
    || fail "GUIDELINES.md does not preserve secret/unlisted Gists by default"

# The voice server configuration is linked into ~/.config/agentvoice and
# read once at server boot; a missing or empty file primes nothing, silently.
# The orchestrator doctrine no longer lives here: agentguidance renders it
# to ~/.agents/prompts/agentvoice, and the installer links that — after
# sync-skills, so the rendered source exists before the link is checked.
[ -s prompts/agentvoice/server.json ] \
    || fail "AgentVoice server configuration is missing or empty: prompts/agentvoice/server.json"
/usr/bin/jq -e . prompts/agentvoice/server.json >/dev/null \
    || fail "AgentVoice server.json is not valid JSON"
for doctrine in ORCHESTRATOR.md ORCHESTRATOR_SESSION_START.md; do
    [ ! -e "prompts/agentvoice/$doctrine" ] \
        || fail "AgentVoice orchestrator doctrine belongs to agentguidance now: prompts/agentvoice/$doctrine"
done
# shellcheck disable=SC2016 # Match the literal rendered-doctrine path in the script.
grep -F 'rendered_dir="$HOME/.agents/prompts/agentvoice"' scripts/install.sh >/dev/null \
    || fail "install.sh does not link the rendered AgentVoice doctrine"
# Both calls now live inside converge_repo_content, so they are indented; the
# ordering they encode is what matters and is still asserted by line number.
voice_link_line=$(grep -n '^ *link_agentvoice_config$' scripts/install.sh | cut -d: -f1)
# shellcheck disable=SC2016 # Match the literal sync-skills call, $-sign and all.
sync_skills_line=$(grep -n '^ *"$script_dir/sync-skills"$' scripts/install.sh | cut -d: -f1)
[ -n "$voice_link_line" ] && [ -n "$sync_skills_line" ] \
    && [ "$voice_link_line" -gt "$sync_skills_line" ] \
    || fail "link_agentvoice_config must run after sync-skills renders the doctrine"

# Content convergence is one function with one call site, because two lists of
# what "content" means would drift apart on the first step somebody adds to
# only one of them. --content runs it alone; the full install ends with it.
grep -q '^converge_repo_content() {$' scripts/install.sh \
    || fail "install.sh does not define converge_repo_content"
[ "$(grep -c '^converge_repo_content$' scripts/install.sh)" -eq 1 ] \
    || fail "converge_repo_content must have exactly one call site in the full install"
grep -q -- '--content)' scripts/install.sh \
    || fail "install.sh does not accept --content"
for content_step in remove_retired_home_guidance link_extension_prompts \
    remove_retired_llm_config remove_legacy_global_skills \
    remove_retired_core_plugin remove_renamed_pack_skills \
    remove_packed_pi_ambient_resources link_agent_guidance link_agentvoice_config; do
    [ "$(grep -c "^ *$content_step\$" scripts/install.sh)" -eq 1 ] \
        || fail "content step is called from more than one place: $content_step"
done
# The cheap path installs nothing: no formula, no fetch, no third-party pack.
content_body=$(sed -n '/^converge_repo_content() {$/,/^}$/p' scripts/install.sh)
printf '%s' "$content_body" | grep -Eq 'install_or_upgrade_formula|install_private_skill_pack|install-pi-subagents|curl|npm install' \
    && fail "converge_repo_content installs or downloads something; it must only converge repository content"
printf '%s' "$content_body" | grep -q 'sync-skills' \
    || fail "converge_repo_content does not run the skill sync"

# Global advice belongs in the operator extension prompts, so the harness
# guidance source stays deliberately empty; the tripwire keeps advice from accreting
# back into every session.
[ -f prompts/AGENTS.md ] \
    || fail "the harness guidance source is missing: prompts/AGENTS.md"
[ ! -s prompts/AGENTS.md ] \
    || fail "prompts/AGENTS.md should stay empty — global advice belongs in the operator extension prompts"

# This checkout participates in its own agent* scan: the fleet skill is how a
# session reads the dependency map, and the map is the skill's payload. The
# fleet convention ships agents/openai.yaml beside every SKILL.md and the
# skill directory must be self-contained — the skills tool ships it whole.
[ -f skills/fleet/SKILL.md ] \
    || fail "the fleet skill is missing: skills/fleet/SKILL.md"
grep -q '^name: fleet$' skills/fleet/SKILL.md \
    || fail "the fleet skill frontmatter does not name itself"
[ -f skills/fleet/agents/openai.yaml ] \
    || fail "the fleet skill is missing its agents/openai.yaml manifest"
[ -s skills/fleet/MAP.md ] \
    || fail "the fleet dependency map is missing: skills/fleet/MAP.md"
grep -q '```mermaid' skills/fleet/MAP.md \
    || fail "the fleet dependency map has no mermaid diagram"
if grep -F '../' skills/fleet/SKILL.md >/dev/null; then
    fail "the fleet skill reaches outside its own directory and would ship broken"
fi

# The supervise skill is portable with executable mechanics: its watcher
# carries the Herdr reconnect/reconcile contract and its integrator guards the
# exact commit that may move main, while its reaper preserves branch identity.
# Exercise them against disposable repositories and a fake socket rather than
# accepting prose-only coverage.
[ -f skills/supervise/SKILL.md ] \
    || fail "the supervise skill is missing: skills/supervise/SKILL.md"
grep -q '^name: supervise$' skills/supervise/SKILL.md \
    || fail "the supervise skill frontmatter does not name /supervise"
[ -f skills/supervise/agents/openai.yaml ] \
    || fail "the supervise skill is missing its agents/openai.yaml manifest"
grep -q '^disable-model-invocation: true$' skills/supervise/SKILL.md \
    || fail "the supervise skill is not restricted to explicit invocation"
# Model invocability is one portable fact in SKILL.md. The common-pack render
# derives Codex's inverse product field; source manifests must not become a
# second, independently maintained policy.
if grep -H '^  allow_implicit_invocation:' skills/*/agents/openai.yaml; then
    fail "source OpenAI manifests contain rendered invocation policy"
fi
explicit_model_skills=$(
    for skill_file in skills/*/SKILL.md; do
        grep -q '^disable-model-invocation: true$' "$skill_file" || continue
        skill_dir=${skill_file%/SKILL.md}
        printf '%s\n' "${skill_dir##*/}"
    done | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//'
)
[ "$explicit_model_skills" = "supervise" ] \
    || fail "explicit-only skill policy drifted: $explicit_model_skills"
command -v bun >/dev/null 2>&1 \
    || fail "bun is required to test the supervise skill's TypeScript helpers"
bun test tests/supervise.test.ts

# Cross-project guidance lives in the wiki, not in this repository; a
# guidance/ directory reappearing here means the decision reversed silently.
[ ! -e guidance ] \
    || fail "cross-project guidance moved to the wiki (tool-advertisement-policy); do not grow guidance/ back"

# Public-repo hygiene: everything resolves from $HOME, so an absolute path into
# a home directory is an account-name assumption leaking back in.
# The sweep covers tests/ as well, so both patterns are assembled rather than
# written out: a guard that spells what it hunts for matches its own source and
# can only pass by exempting itself.
hygiene_paths="scripts prompts config skills tests README.md AGENTS.md CONTEXT.md"
home_literal="/$(printf 'Users')/"
# shellcheck disable=SC2086 # $hygiene_paths is a deliberate list of targets.
if grep -rn "$home_literal" $hygiene_paths 2>/dev/null; then
    fail "a literal home-directory path assumes an account name; resolve from \$HOME instead"
fi
# The same rule for the operator's account name, which is knowable at runtime
# and therefore never needs to be written down.
operator_account=$(id -un)
# shellcheck disable=SC2086 # $hygiene_paths is a deliberate list of targets.
if grep -rn "$operator_account" $hygiene_paths 2>/dev/null; then
    fail "the operator's account name is spelled in the repository; resolve it at runtime"
fi
[ -s LICENSE ] || fail "public repository is missing its LICENSE"

# The post-sync hook is how agentguidance's templates survive the scan:
# sync-skills must run a participant's executable scripts/post-sync right
# after its skills land, and a failing hook must name the project.
# shellcheck disable=SC2016 # Match the literal hook invocation.
grep -F '"$project/scripts/post-sync"' scripts/sync-skills >/dev/null \
    || fail "sync-skills does not run a participant's post-sync hook"
grep -F 'post-sync hook failed' scripts/sync-skills >/dev/null \
    || fail "sync-skills does not propagate a failing post-sync hook"

# A machine that has not cloned AgentVoice is a skip, not a failure: the CLI is
# one of several optional checkout-backed tools and an install must not stop
# for a machine that simply does not have it.
skip_test_dir=$(mktemp -d "${TMPDIR:-/tmp}/agentstart-validate.XXXXXX")
trap 'rm -rf "$skip_test_dir"' EXIT
agentvoice_missing_home="$skip_test_dir/agentvoice-missing-home"
mkdir -p "$agentvoice_missing_home"
set +e
agentvoice_missing_output=$(
    HOME="$agentvoice_missing_home" \
        PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
        "$root/scripts/install-agentvoice-cli" 2>&1
)
agentvoice_missing_status=$?
set -e
[ "$agentvoice_missing_status" -eq 0 ] \
    || fail "AgentVoice CLI installer did not skip a machine without a checkout"
printf '%s\n' "$agentvoice_missing_output" \
    | grep -F \
        "no checkout at $agentvoice_missing_home/code/agentvoice or $agentvoice_missing_home/code/agentvoice2; skipping." \
        >/dev/null \
    || fail "AgentVoice CLI installer did not report the skipped checkout clearly"

# This machine's archive-bound checkout retains its public AgentVoice identity
# while living at agentvoice2. The installer must converge that explicit
# transitional spelling, and must refuse rather than choose if both spellings
# are present.
agentvoice2_code_root="$skip_test_dir/agentvoice2-code"
agentvoice2_stub_bin="$skip_test_dir/agentvoice2-bun"
agentvoice2_stub_log="$skip_test_dir/agentvoice2-bun.log"
mkdir -p "$agentvoice2_code_root/agentvoice2"
printf '{}\n' >"$agentvoice2_code_root/agentvoice2/package.json"
cat >"$agentvoice2_stub_bin" <<'EOF'
#!/bin/bash
printf '<%s>' "$@" >"$AGENTVOICE2_STUB_LOG"
printf '\n' >>"$AGENTVOICE2_STUB_LOG"
EOF
chmod +x "$agentvoice2_stub_bin"
AGENTSTART_CODE_ROOT="$agentvoice2_code_root" \
    AGENTSTART_BUN_BIN="$agentvoice2_stub_bin" \
    AGENTVOICE2_STUB_LOG="$agentvoice2_stub_log" \
    "$root/scripts/install-agentvoice-cli" >/dev/null
grep -Fx \
    "<run><--cwd><$agentvoice2_code_root/agentvoice2><cli:install>" \
    "$agentvoice2_stub_log" >/dev/null \
    || fail "AgentVoice CLI installer did not invoke the agentvoice2 checkout contract"

mkdir -p "$agentvoice2_code_root/agentvoice"
printf '{}\n' >"$agentvoice2_code_root/agentvoice/package.json"
set +e
agentvoice_ambiguous_output=$( \
    AGENTSTART_CODE_ROOT="$agentvoice2_code_root" \
        AGENTSTART_BUN_BIN="$agentvoice2_stub_bin" \
        "$root/scripts/install-agentvoice-cli" 2>&1 \
)
agentvoice_ambiguous_status=$?
set -e
[ "$agentvoice_ambiguous_status" -ne 0 ] \
    || fail "AgentVoice CLI installer accepted two competing checkouts"
printf '%s\n' "$agentvoice_ambiguous_output" \
    | grep -F 'refusing an ambiguous AgentVoice checkout' >/dev/null \
    || fail "AgentVoice CLI installer did not explain its ambiguous-checkout refusal"

# Bare harness shims route through AgentLaunch, and the recursion sentinel
# keeps AgentLaunch-managed child processes from entering the shim again.
shim_home="$skip_test_dir/shim-home"
shim_bin="$skip_test_dir/shim-bin"
shim_real_bin="$skip_test_dir/shim-real-bin"
mkdir -p "$shim_home" "$shim_bin" "$shim_real_bin"
cat >"$shim_bin/agentlaunch" <<'EOF'
#!/bin/bash
printf 'agentlaunch'
printf ' <%s>' "$@"
printf '\n'
EOF
chmod +x "$shim_bin/agentlaunch"
for shim_harness in claude codex pi; do
    cat >"$shim_real_bin/$shim_harness" <<'EOF'
#!/bin/bash
printf 'real %s' "$(basename "$0")"
printf ' <%s>' "$@"
printf '\n'
EOF
    chmod +x "$shim_real_bin/$shim_harness"
done
HOME="$shim_home" \
    PATH="$shim_bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    "$root/scripts/install-agentlaunch-shims" >/dev/null
for shim_harness in claude codex pi; do
    shim="$shim_home/.local/share/agentlaunch/shims/$shim_harness"
    [ -x "$shim" ] || fail "AgentLaunch shim is missing or not executable: $shim"
    grep -F "AgentStart-managed AgentLaunch shim" "$shim" >/dev/null \
        || fail "AgentLaunch shim is missing its ownership marker: $shim"
    grep -F "exec agentlaunch --x-harness $shim_harness" "$shim" >/dev/null \
        || fail "AgentLaunch shim does not route $shim_harness through agentlaunch"
done
shim_output=$(
    AGENTLAUNCH_LAUNCH='' AGENTLAUNCH_SHIM_BYPASS='' \
        PATH="$shim_home/.local/share/agentlaunch/shims:$shim_bin:/usr/bin:/bin:/usr/sbin:/sbin" \
        "$shim_home/.local/share/agentlaunch/shims/claude" --version
)
[ "$shim_output" = 'agentlaunch <--x-harness> <claude> <--version>' ] \
    || fail "AgentLaunch shim did not route a bare harness launch: $shim_output"
shim_bypass_output=$(
    AGENTLAUNCH_LAUNCH=1 \
        PATH="$shim_home/.local/share/agentlaunch/shims:$shim_real_bin:$shim_bin:/usr/bin:/bin:/usr/sbin:/sbin" \
        "$shim_home/.local/share/agentlaunch/shims/claude" --version
)
[ "$shim_bypass_output" = 'real claude <--version>' ] \
    || fail "AgentLaunch shim did not bypass itself under the recursion sentinel: $shim_bypass_output"

# Terminal Control's named-session daemon must leave the invoking harness's
# process group, while every other command remains a direct pass-through. The
# fake payload reports its process identity and arguments so this test proves
# both properties without starting a persistent daemon.
termctrl_shim_home="$skip_test_dir/termctrl-shim-home"
termctrl_fake="$termctrl_shim_home/.local/libexec/agentstart/terminal-control/termctrl"
mkdir -p "$(dirname "$termctrl_fake")"
cat >"$termctrl_fake" <<'PYTHON'
#!/usr/bin/python3
import json
import os
import sys

print(json.dumps({
    "pid": os.getpid(),
    "pgid": os.getpgrp(),
    "sid": os.getsid(0),
    "args": sys.argv[1:],
}))
raise SystemExit(int(os.environ.get("TERMCTRL_FAKE_EXIT", "0")))
PYTHON
chmod 0755 "$termctrl_fake"
termctrl_direct=$(
    HOME="$termctrl_shim_home" \
        "$root/config/terminal-control/termctrl" --version
)
printf '%s\n' "$termctrl_direct" | /usr/bin/jq -e \
    '.args == ["--version"]' >/dev/null \
    || fail "Terminal Control shim changed pass-through arguments"
termctrl_detached=$(
    HOME="$termctrl_shim_home" \
        "$root/config/terminal-control/termctrl" start proof -- /bin/true
)
printf '%s\n' "$termctrl_detached" | /usr/bin/jq -e \
    '.pid == .pgid and .pid == .sid and
     .args == ["start", "proof", "--", "/bin/true"]' >/dev/null \
    || fail "Terminal Control start did not execute in a detached session"
set +e
HOME="$termctrl_shim_home" TERMCTRL_FAKE_EXIT=23 \
    "$root/config/terminal-control/termctrl" start exit-proof >/dev/null
termctrl_exit_status=$?
set -e
[ "$termctrl_exit_status" -eq 23 ] \
    || fail "Terminal Control shim did not preserve the launcher exit status"

# Retired integrations are removed only when they carry exact AgentStart or
# predecessor-owned markers. Independent files that merely live at old paths
# must survive.
cleanup_home="$skip_test_dir/cleanup-home"
cleanup_code_root="$skip_test_dir/cleanup-code"
mkdir -p \
    "$cleanup_home/.local/bin" \
    "$cleanup_home/.local/share/agentsurface/shims" \
    "$cleanup_home/.pi/agent/extensions" \
    "$cleanup_home/.omp/agent/extensions" \
    "$cleanup_home/.claude/skills" \
    "$cleanup_home/.claude" \
    "$cleanup_home/.codex" \
    "$cleanup_home/.config/amp/plugins" \
    "$cleanup_home/.config/devin" \
    "$cleanup_home/.factory" \
    "$cleanup_home/.gemini/config" \
    "$cleanup_home/.cursor" \
    "$cleanup_home/.commandcode" \
    "$cleanup_home/.grok/hooks" \
    "$cleanup_home/.copilot/hooks" \
    "$cleanup_home/.openclaude" \
    "$cleanup_home/.kimi-code" \
    "$cleanup_home/.hermes/plugins/orca-status" \
    "$cleanup_code_root/agentbus/src" \
    "$cleanup_code_root/agentbus/extensions/pi" \
    "$cleanup_code_root/agentbus/plugins/claude" \
    "$cleanup_code_root/agentsurface/src"
touch \
    "$cleanup_code_root/agentbus/src/main.ts" \
    "$cleanup_code_root/agentbus/extensions/pi/agentbus.ts" \
    "$cleanup_code_root/agentbus/plugins/claude/.keep" \
    "$cleanup_code_root/agentsurface/src/main.ts"
ln -s "$cleanup_code_root/agentbus/src/main.ts" "$cleanup_home/.local/bin/agentbus"
ln -s "$cleanup_code_root/agentsurface/src/main.ts" "$cleanup_home/.local/bin/agentsurface"
ln -s "$cleanup_code_root/agentbus/extensions/pi/agentbus.ts" "$cleanup_home/.pi/agent/extensions/agentbus.ts"
ln -s "$cleanup_code_root/agentbus/plugins/claude" "$cleanup_home/.claude/skills/agentbus"
printf '# AgentStart-managed agentsurface shim: old\n' \
    >"$cleanup_home/.local/share/agentsurface/shims/claude"
printf '# independent shim\n' \
    >"$cleanup_home/.local/share/agentsurface/shims/codex"
printf '// @orca-managed-pi-extension\n' \
    >"$cleanup_home/.pi/agent/extensions/orca-agent-status.ts"
printf '// independent extension\n' \
    >"$cleanup_home/.pi/agent/extensions/orca-prefill.ts"
printf '// @orca-managed-pi-extension\n' \
    >"$cleanup_home/.omp/agent/extensions/orca-agent-status.ts"
printf '// independent extension\n' \
    >"$cleanup_home/.omp/agent/extensions/orca-prefill.ts"
printf '// Managed by Orca. Do not edit\n' \
    >"$cleanup_home/.config/amp/plugins/orca-agent-status.ts"
cat >"$cleanup_home/.claude/settings.json" <<EOF
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "$cleanup_home/.orca/agent-hooks/claude-hook.sh"
          },
          {
            "type": "command",
            "command": "keep-claude"
          }
        ]
      },
      {
        "matcher": "remove-empty",
        "hooks": [
          {
            "type": "command",
            "command": "$cleanup_home/.orca/agent-hooks/claude-hook.sh"
          }
        ]
      }
    ]
  }
}
EOF
cat >"$cleanup_home/.codex/hooks.json" <<EOF
{
  "hooks": {
    "pre-command": [
      {
        "hooks": [
          {
            "command": "$cleanup_home/.orca/agent-hooks/codex-hook.sh"
          },
          {
            "command": "keep-codex"
          }
        ]
      }
    ]
  }
}
EOF
for hook_fixture in \
    ".config/devin/config.json:devin-hook.sh" \
    ".factory/settings.json:droid-hook.sh" \
    ".gemini/settings.json:gemini-hook.sh" \
    ".commandcode/settings.json:command-code-hook.sh" \
    ".openclaude/settings.json:openclaude-hook.sh"; do
    hook_file="$cleanup_home/${hook_fixture%%:*}"
    hook_name=${hook_fixture#*:}
    cat >"$hook_file" <<EOF
{
  "hooks": {
    "Stop": [
      {"hooks": [
        {"command": "$cleanup_home/.orca/agent-hooks/$hook_name"},
        {"command": "keep-nested-hook"}
      ]}
    ],
    "Direct": [
      {"command": "$cleanup_home/.orca/agent-hooks/$hook_name"},
      {"command": "keep-direct-hook"}
    ]
  }
}
EOF
done
cat >"$cleanup_home/.gemini/settings.json" <<'EOF'
{
  // Gemini accepts JSONC; Orca also installed PowerShell hooks on Windows.
  "hooks": {
    "Stop": [
      {"powershell": "powershell.exe -File C:\\Users\\fixture\\.orca\\agent-hooks\\gemini-hook.ps1"},
      {"command": "keep-gemini"},
    ],
  },
}
EOF
cat >"$cleanup_home/.cursor/hooks.json" <<EOF
{"version":1,"hooks":{"stop":[
  {"command":"$cleanup_home/.orca/agent-hooks/cursor-hook.sh"},
  {"command":"keep-cursor"}
]}}
EOF
cat >"$cleanup_home/.grok/hooks/orca-status.json" <<EOF
{"hooks":{"Stop":[{"hooks":[{"command":"$cleanup_home/.orca/agent-hooks/grok-hook.sh"}]}]}}
EOF
cat >"$cleanup_home/.copilot/hooks/orca.json" <<EOF
{"version":1,"hooks":{"Stop":[
  {"bash":"$cleanup_home/.orca/agent-hooks/copilot-hook.sh"},
  {"bash":"keep-copilot"}
]}}
EOF
cat >"$cleanup_home/.gemini/config/hooks.json" <<EOF
{"orca-status":{"Stop":[
  {"command":"$cleanup_home/.orca/agent-hooks/antigravity-hook.sh"},
  {"command":"keep-antigravity"}
]},"keep":{"value":true}}
EOF
cat >"$cleanup_home/.kimi-code/config.toml" <<EOF
keep = true

# >>> orca-managed-kimi-hooks (managed by Orca; do not edit) >>>
[[hooks]]
event = "Stop"
command = "$cleanup_home/.orca/agent-hooks/kimi-hook.sh"
# <<< orca-managed-kimi-hooks <<<
EOF
cat >"$cleanup_home/.hermes/config.yaml" <<'EOF'
plugins:
  enabled:
    - keep-hermes
    - orca-status
other: true
EOF
printf '# Managed by Orca. Do not edit; changes may be overwritten.\n' \
    >"$cleanup_home/.hermes/plugins/orca-status/plugin.yaml"
printf '# Managed by Orca. Do not edit; changes may be overwritten.\n' \
    >"$cleanup_home/.hermes/plugins/orca-status/__init__.py"
cat >"$cleanup_home/.codex/config.toml" <<'EOF'
model = "gpt"

# agentbus: bus sends from inside the sandbox need the daemon socket
[sandbox_workspace_write]
network_access = true

[profiles.default]
model = "gpt"
EOF
HOME="$cleanup_home" AGENTSTART_CODE_ROOT="$cleanup_code_root" \
    "$root/scripts/remove-retired-integrations" >/dev/null
[ ! -e "$cleanup_home/.local/bin/agentbus" ] \
    || fail "retired AgentBus CLI symlink was not removed"
[ -L "$cleanup_home/.local/bin/agentsurface" ] \
    || fail "live AgentSurface CLI symlink was removed by retired cleanup"
[ ! -e "$cleanup_home/.pi/agent/extensions/agentbus.ts" ] \
    || fail "retired AgentBus Pi extension was not removed"
[ ! -e "$cleanup_home/.claude/skills/agentbus" ] \
    || fail "retired AgentBus Claude plugin was not removed"
[ ! -e "$cleanup_home/.local/share/agentsurface/shims/claude" ] \
    || fail "retired AgentSurface shim was not removed"
[ -e "$cleanup_home/.local/share/agentsurface/shims/codex" ] \
    || fail "independent shim at old AgentSurface path was removed"
[ ! -e "$cleanup_home/.pi/agent/extensions/orca-agent-status.ts" ] \
    || fail "retired Orca Pi extension was not removed"
[ -e "$cleanup_home/.pi/agent/extensions/orca-prefill.ts" ] \
    || fail "independent Pi extension was removed"
[ ! -e "$cleanup_home/.omp/agent/extensions/orca-agent-status.ts" ] \
    || fail "retired Orca OMP extension was not removed"
[ -e "$cleanup_home/.omp/agent/extensions/orca-prefill.ts" ] \
    || fail "independent OMP extension was removed"
[ ! -e "$cleanup_home/.config/amp/plugins/orca-agent-status.ts" ] \
    || fail "retired Orca Amp plugin was not removed"
grep -F "$cleanup_home/.orca/agent-hooks/claude-hook.sh" "$cleanup_home/.claude/settings.json" >/dev/null \
    && fail "retired Orca Claude hook was not removed"
grep -F "$cleanup_home/.orca/agent-hooks/codex-hook.sh" "$cleanup_home/.codex/hooks.json" >/dev/null \
    && fail "retired Orca Codex hook was not removed"
grep -F 'keep-claude' "$cleanup_home/.claude/settings.json" >/dev/null \
    || fail "retired cleanup removed unrelated Claude hook"
grep -F 'keep-codex' "$cleanup_home/.codex/hooks.json" >/dev/null \
    || fail "retired cleanup removed unrelated Codex hook"
for hook_file in \
    "$cleanup_home/.config/devin/config.json" \
    "$cleanup_home/.factory/settings.json" \
    "$cleanup_home/.gemini/settings.json" \
    "$cleanup_home/.cursor/hooks.json" \
    "$cleanup_home/.commandcode/settings.json" \
    "$cleanup_home/.copilot/hooks/orca.json" \
    "$cleanup_home/.openclaude/settings.json"; do
    grep -F '.orca/agent-hooks/' "$hook_file" >/dev/null \
        && fail "retired Orca hook remained in $hook_file"
done
for hook_file in \
    "$cleanup_home/.config/devin/config.json" \
    "$cleanup_home/.factory/settings.json" \
    "$cleanup_home/.commandcode/settings.json" \
    "$cleanup_home/.openclaude/settings.json"; do
    grep -F 'keep-nested-hook' "$hook_file" >/dev/null \
        || fail "retired cleanup removed an unrelated nested hook from $hook_file"
    grep -F 'keep-direct-hook' "$hook_file" >/dev/null \
        || fail "retired cleanup removed an unrelated direct hook from $hook_file"
done
grep -F 'keep-gemini' "$cleanup_home/.gemini/settings.json" >/dev/null \
    || fail "retired cleanup removed an unrelated Gemini hook"
grep -F 'gemini-hook.' "$cleanup_home/.gemini/settings.json" >/dev/null \
    && fail "retired Gemini PowerShell hook remained"
[ ! -e "$cleanup_home/.grok/hooks/orca-status.json" ] \
    || fail "empty Orca-owned Grok hook file was not removed"
grep -F 'keep-cursor' "$cleanup_home/.cursor/hooks.json" >/dev/null \
    || fail "retired cleanup removed an unrelated Cursor hook"
grep -F 'keep-copilot' "$cleanup_home/.copilot/hooks/orca.json" >/dev/null \
    || fail "retired cleanup removed an unrelated Copilot hook"
grep -F 'antigravity-hook.' "$cleanup_home/.gemini/config/hooks.json" >/dev/null \
    && fail "retired Antigravity hook remained"
grep -F 'keep-antigravity' "$cleanup_home/.gemini/config/hooks.json" >/dev/null \
    || fail "retired cleanup removed an unrelated Antigravity hook"
grep -F 'orca-managed-kimi-hooks' "$cleanup_home/.kimi-code/config.toml" >/dev/null \
    && fail "retired Kimi hook block remained"
grep -F 'keep = true' "$cleanup_home/.kimi-code/config.toml" >/dev/null \
    || fail "retired cleanup removed unrelated Kimi configuration"
[ ! -e "$cleanup_home/.hermes/plugins/orca-status" ] \
    || fail "retired Hermes plugin was not removed"
grep -F 'orca-status' "$cleanup_home/.hermes/config.yaml" >/dev/null \
    && fail "retired Hermes plugin remained enabled"
grep -F 'keep-hermes' "$cleanup_home/.hermes/config.yaml" >/dev/null \
    || fail "retired cleanup removed an unrelated Hermes plugin"
grep -F 'other: true' "$cleanup_home/.hermes/config.yaml" >/dev/null \
    || fail "retired cleanup damaged unrelated Hermes configuration"
grep -F 'agentbus: bus sends' "$cleanup_home/.codex/config.toml" >/dev/null \
    && fail "retired AgentBus Codex sandbox marker was not removed"
grep -F 'network_access = true' "$cleanup_home/.codex/config.toml" >/dev/null \
    && fail "retired AgentBus Codex sandbox override was not removed"
grep -F '[profiles.default]' "$cleanup_home/.codex/config.toml" >/dev/null \
    || fail "retired cleanup damaged unrelated Codex config"

independent_cleanup_home="$skip_test_dir/independent-cleanup-home"
mkdir -p "$independent_cleanup_home/.grok/hooks"
printf '{"version":1,"hooks":{}}\n' \
    >"$independent_cleanup_home/.grok/hooks/orca-status.json"
HOME="$independent_cleanup_home" AGENTSTART_CODE_ROOT="$cleanup_code_root" \
    "$root/scripts/remove-retired-integrations" >/dev/null
[ -e "$independent_cleanup_home/.grok/hooks/orca-status.json" ] \
    || fail "independent empty hook file was removed"

bad_cleanup_home="$skip_test_dir/bad-cleanup-home"
mkdir -p "$bad_cleanup_home/.codex"
cat >"$bad_cleanup_home/.codex/config.toml" <<'EOF'
# agentbus: bus sends from inside the sandbox need the daemon socket
[sandbox_workspace_write]
network_access = false
EOF
set +e
bad_cleanup_output=$(
    HOME="$bad_cleanup_home" AGENTSTART_CODE_ROOT="$cleanup_code_root" \
        "$root/scripts/remove-retired-integrations" 2>&1
)
bad_cleanup_status=$?
set -e
[ "$bad_cleanup_status" -ne 0 ] \
    || fail "retired cleanup removed a changed AgentBus sandbox block"
printf '%s\n' "$bad_cleanup_output" \
    | grep -F 'changed AgentBus sandbox block' >/dev/null \
    || fail "retired cleanup did not explain changed sandbox-block refusal"
grep -F 'network_access = false' "$bad_cleanup_home/.codex/config.toml" >/dev/null \
    || fail "retired cleanup changed a refused sandbox block"

# The agent* skill scan finds participants by convention instead of by list:
# an agent* checkout that exports skills/<name>/SKILL.md is a participant, and
# everything else under the root is not. The scan must batch one invocation
# per project naming every skill it found, and no participant is exempt.
code_skills_root="$skip_test_dir/code-root"
code_skills_home="$skip_test_dir/code-home"
code_skills_log="$skip_test_dir/npx.log"
mkdir -p \
    "$code_skills_home" \
    "$code_skills_home/.pi/agent/extensions" \
    "$code_skills_root/agentbus/skills/bus" \
    "$code_skills_root/agentdemo/skills/demo" \
    "$code_skills_root/agentdemo/skills/second" \
    "$code_skills_root/agentquiet/src" \
    "$code_skills_root/agentretired/skills/orchestration" \
    "$code_skills_root/agentvoice/skills/story" \
    "$code_skills_root/notagent/skills/x"
for code_skills_fixture in \
    agentbus/skills/bus \
    agentdemo/skills/demo \
    agentdemo/skills/second \
    agentretired/skills/orchestration \
    agentvoice/skills/story \
    notagent/skills/x; do
    code_skills_name=${code_skills_fixture##*/}
    printf -- '---\nname: %s\ndescription: fixture skill\n---\n' "$code_skills_name" \
        >"$code_skills_root/$code_skills_fixture/SKILL.md"
done
# The portable frontmatter is the invocation-policy source of truth. This
# skill deliberately has no OpenAI manifest; the renderer must create one.
sed -i '' '/^description:/a\
disable-model-invocation: true
' "$code_skills_root/agentdemo/skills/second/SKILL.md"
cat >"$code_skills_home/.pi/agent/extensions/herdr-agent-state.ts" <<'EOF'
// installed by herdr
// managed by herdr; reinstalling or updating the integration overwrites this file.
// HERDR_INTEGRATION_ID=pi
export {};
EOF
# OpenAI manifests are portable source: their default prompt starts with the
# plain skill name. Compatibility packaging must qualify only its generated
# copy without changing the canonical fixed resources.
mkdir -p "$code_skills_root/agentdemo/skills/demo/agents"
cat >"$code_skills_root/agentdemo/skills/demo/agents/openai.yaml" <<'EOF'
interface:
  display_name: "Demo"
  short_description: "Exercise compatibility plugin prompt qualification"
  default_prompt: "Use $demo with this fixture."
policy:
  allow_implicit_invocation: false
EOF
# agentdemo carries a post-sync hook (the agentguidance pattern): it must
# appear in the plan, fire after the real sync, and fail the run when it
# fails.
mkdir -p "$code_skills_root/agentdemo/scripts"
cat >"$code_skills_root/agentdemo/scripts/post-sync" <<'EOF'
#!/bin/bash
set -euo pipefail
[ -z "${AGENTSTART_TEST_HOOK_EXIT:-}" ] || exit "$AGENTSTART_TEST_HOOK_EXIT"
marker="$(cd -P -- "$(dirname -- "$0")/.." && pwd)/post-sync-ran"
if [ ! -e "$marker" ]; then
    chmod 444 "$AGENTGUIDANCE_SKILLS_ROOT/demo/agents/openai.yaml"
fi
touch "$marker"
EOF
chmod +x "$code_skills_root/agentdemo/scripts/post-sync"

sync_plan=$(
    HOME="$code_skills_home" AGENTSTART_CODE_ROOT="$code_skills_root" \
        AGENTSTART_NPX_BIN="$root/tests/fixtures/npx" \
        AGENTSTART_TEST_NPX_LOG="$code_skills_log" \
        "$root/scripts/sync-skills" --check
)
[ ! -s "$code_skills_log" ] \
    || fail "skill sync plan invoked the skills tool instead of only printing"
printf '%s\n' "$sync_plan" \
    | grep -F "npx --yes skills add \"$code_skills_root/agentdemo\" --agent claude-code --skill demo second --global --copy --yes" \
        >/dev/null \
    || fail "skill sync plan omits the skills discovered in a participating checkout"
printf '%s\n' "$sync_plan" \
    | grep -F "npx --yes skills add \"$code_skills_root/agentvoice\" --agent claude-code --skill story --global --copy --yes" \
        >/dev/null \
    || fail "skill sync plan exempts AgentVoice instead of scanning it like any other participant"
if printf '%s\n' "$sync_plan" | grep -Eq 'agentquiet|notagent'; then
    fail "skill sync plan includes a checkout that is not a participant"
fi
printf '%s\n' "$sync_plan" \
    | grep -F "npx --yes skills add \"$code_skills_root/agentbus\" --agent claude-code --skill bus --global --copy --yes" \
        >/dev/null \
    || fail "skill sync plan skips the bus skill, back in service since 2026-08-17"
# A checkout whose every skill is retired drops out of the plan entirely, which
# is what keeps a full install's explicit removal from being undone six hours
# later by the unattended additive path.
if printf '%s\n' "$sync_plan" | grep -Eq 'agentretired|orchestration'; then
    fail "skill sync plan re-adds a retired skill"
fi
printf '%s\n' "$sync_plan" \
    | grep -F "\"$code_skills_root/agentdemo/scripts/post-sync\"" >/dev/null \
    || fail "skill sync plan omits a participant's post-sync hook"
[ ! -e "$code_skills_root/agentdemo/post-sync-ran" ] \
    || fail "skill sync plan ran a post-sync hook instead of only printing"

# The Pi subagent package the full installer pins. The renderer only carries an
# install that is already present, so the fixture stands in for one.
fixture_pi_subagents_root="$code_skills_home/pi-subagents-install"
mkdir -p \
    "$fixture_pi_subagents_root/pi-subagents/node_modules/yaml" \
    "$fixture_pi_subagents_root/pi-subagents/skills/pi-subagents" \
    "$fixture_pi_subagents_root/pi-subagents/prompts"
cat >"$fixture_pi_subagents_root/pi-subagents/package.json" <<'FIXTURE_JSON'
{
  "name": "pi-subagents",
  "version": "9.9.9",
  "pi": { "extensions": ["./index.ts"], "skills": ["./skills"], "prompts": ["./prompts"] }
}
FIXTURE_JSON
printf 'export default () => {}\n' \
    >"$fixture_pi_subagents_root/pi-subagents/index.ts"
printf '{"name":"yaml"}\n' \
    >"$fixture_pi_subagents_root/pi-subagents/node_modules/yaml/package.json"
printf -- '---\nname: pi-subagents\ndescription: fixture\n---\n' \
    >"$fixture_pi_subagents_root/pi-subagents/skills/pi-subagents/SKILL.md"
printf -- '---\ndescription: fixture workflow\n---\n' \
    >"$fixture_pi_subagents_root/pi-subagents/prompts/parallel-review.md"

mkdir -p "$code_skills_home/.codex"
cat >"$code_skills_home/.codex/config.toml" <<'EOF'
model = "fixture-model"

[[skills.config]]
name = "unrelated"
enabled = true

# BEGIN AgentStart managed fleet skills (do not edit)
[[skills.config]]
name = "agent:retired"
enabled = false

# END AgentStart managed fleet skills
EOF

sync_output=$(
    HOME="$code_skills_home" CODEX_HOME="$code_skills_home/.codex" \
        AGENTSTART_CODE_ROOT="$code_skills_root" \
        AGENTSTART_NPX_BIN="$root/tests/fixtures/npx" \
        AGENTSTART_TEST_NPX_LOG="$code_skills_log" \
        AGENTSTART_TEST_NPX_OUTPUT=skills-cli-success-noise \
        AGENTSTART_CLAUDE_BIN=/usr/bin/true \
        AGENTSTART_CODEX_BIN=/usr/bin/true \
        AGENTSTART_PI_SUBAGENTS_ROOT="$fixture_pi_subagents_root" \
        "$root/scripts/sync-skills"
)
if printf '%s\n' "$sync_output" | grep -F skills-cli-success-noise >/dev/null; then
    fail "successful skill sync leaked the skills CLI's animated output"
fi
grep -F "npx-stub <--yes> <skills> <add> <$code_skills_root/agentdemo> <--agent> <claude-code> <--skill> <demo> <second> <--global> <--copy> <--yes>" \
    "$code_skills_log" >/dev/null \
    || fail "skill sync did not ship both discovered skills in one invocation"
grep -F "npx-stub <--yes> <skills> <add> <$code_skills_root/agentvoice> <--agent> <claude-code> <--skill> <story> <--global> <--copy> <--yes>" \
    "$code_skills_log" >/dev/null \
    || fail "skill sync skipped AgentVoice instead of synchronizing it"
if grep -E 'agentquiet|notagent' "$code_skills_log" >/dev/null; then
    fail "skill sync synchronized a checkout that is not a participant"
fi
grep -F "npx-stub <--yes> <skills> <add> <$code_skills_root/agentbus> <--agent> <claude-code> <--skill> <bus> <--global> <--copy> <--yes>" \
    "$code_skills_log" >/dev/null \
    || fail "skill sync skipped the bus skill, back in service since 2026-08-17"
if grep -E 'agentretired|orchestration' "$code_skills_log" >/dev/null; then
    fail "skill sync re-added a retired skill"
fi
# One invocation each for agentbus, agentdemo, and agentvoice.
[ "$(grep -c 'skills> <add>' "$code_skills_log")" -eq 3 ] \
    || fail "skill sync did not invoke the skills tool exactly once per source"
[ -e "$code_skills_root/agentdemo/post-sync-ran" ] \
    || fail "skill sync did not run a participant's post-sync hook after its skills landed"
fixture_resources_root="$code_skills_home/.local/share/agentstart/resources"
fixture_claude_root="$fixture_resources_root/claude/agent"
fixture_codex_root="$fixture_resources_root/codex-marketplace/plugins/agent"
[ -f "$fixture_resources_root/skills/demo/SKILL.md" ] \
    || fail "skill sync did not copy a participant into the fixed resources"
[ -f "$fixture_claude_root/.claude-plugin/plugin.json" ] \
    || fail "skill sync did not render the Claude fleet plugin"
[ -f "$fixture_codex_root/.codex-plugin/plugin.json" ] \
    || fail "skill sync did not render the Codex fleet plugin"
# shellcheck disable=SC2016 # Match the literal Codex plugin-qualified skill reference.
grep -F 'default_prompt: "Use $agent:demo with this fixture."' \
    "$fixture_codex_root/skills/demo/agents/openai.yaml" >/dev/null \
    || fail "the Codex plugin did not qualify demo's default prompt"
# shellcheck disable=SC2016 # Match the literal portable source skill reference.
grep -F 'default_prompt: "Use $demo with this fixture."' \
    "$fixture_resources_root/skills/demo/agents/openai.yaml" >/dev/null \
    || fail "Codex prompt qualification changed the canonical resource manifest"
grep -F 'allow_implicit_invocation: true' \
    "$fixture_resources_root/skills/demo/agents/openai.yaml" >/dev/null \
    || fail "the renderer did not replace stale Codex policy from canonical frontmatter"
[ ! -w "$fixture_resources_root/skills/demo/agents/openai.yaml" ] \
    || fail "the invocation-policy renderer changed a read-only manifest's mode"
grep -F 'allow_implicit_invocation: false' \
    "$fixture_resources_root/skills/second/agents/openai.yaml" >/dev/null \
    || fail "the managed Codex resources did not restrict an explicit-only skill"
grep -F 'allow_implicit_invocation: false' \
    "$fixture_codex_root/skills/second/agents/openai.yaml" >/dev/null \
    || fail "the Codex plugin copy did not restrict an explicit-only skill"
grep -F 'disable-model-invocation: true' \
    "$fixture_resources_root/skills/second/SKILL.md" >/dev/null \
    || fail "the private resources lost explicit-only skill frontmatter"
grep -F 'disable-model-invocation: true' \
    "$fixture_claude_root/skills/second/SKILL.md" >/dev/null \
    || fail "the Claude plugin lost explicit-only skill frontmatter"
"$root/scripts/render-skill-invocation-policy" --check \
    "$fixture_resources_root/skills" >/dev/null \
    || fail "the rendered resources do not pass their invocation-policy audit"
# The audit is independently useful: prove it rejects drift instead of merely
# agreeing with the renderer that just ran.
sed -i '' 's/allow_implicit_invocation: true/allow_implicit_invocation: false/' \
    "$fixture_resources_root/skills/demo/agents/openai.yaml"
if "$root/scripts/render-skill-invocation-policy" --check \
    "$fixture_resources_root/skills" >/dev/null 2>&1; then
    fail "the invocation-policy audit accepted drift from canonical frontmatter"
fi
"$root/scripts/render-skill-invocation-policy" --install \
    "$fixture_resources_root/skills" >/dev/null
chmod 644 "$fixture_resources_root/skills/demo/agents/openai.yaml"
[ ! -e "$code_skills_home/.pi/agent/skills/demo" ] \
    || fail "skill sync leaked a common skill into Pi's ambient global root"
[ -f "$fixture_resources_root/pi/extensions/herdr-agent-state.ts" ] \
    || fail "skill sync did not collect Pi's generated Herdr extension privately"
[ -f "$code_skills_home/.pi/agent/extensions/herdr-agent-state.ts" ] \
    || fail "unattended skill sync removed Pi's ambient Herdr extension"
cmp -s \
    "$code_skills_home/.pi/agent/extensions/herdr-agent-state.ts" \
    "$fixture_resources_root/pi/extensions/herdr-agent-state.ts" \
    || fail "skill sync did not copy Pi's Herdr extension exactly into private resources"

# The subagent package rides the fixed resources as a directory, because
# AgentLaunch names a directory with --extension and Pi reads the manifest inside it to register
# the extension, its skills, and its workflow templates from that one path.
fixture_pi_subagents_packed="$fixture_resources_root/pi/extensions/pi-subagents"
[ -f "$fixture_pi_subagents_packed/package.json" ] \
    || fail "skill sync did not carry the Pi subagent package into the fixed resources"
grep -F '"pi":' "$fixture_pi_subagents_packed/package.json" >/dev/null \
    || fail "the packed Pi subagent package lost the manifest Pi resolves it by"
# Pi never installs dependencies for a local path, so the dependencies must
# ride inside the explicitly named package directory.
[ -f "$fixture_pi_subagents_packed/node_modules/yaml/package.json" ] \
    || fail "the packed Pi subagent package lost its runtime dependencies"
[ -f "$fixture_pi_subagents_packed/prompts/parallel-review.md" ] \
    || fail "the packed Pi subagent package lost its workflow prompt templates"
[ -f "$fixture_pi_subagents_packed/skills/pi-subagents/SKILL.md" ] \
    || fail "the packed Pi subagent package lost its own skills"

# The plugin is installed globally, so every managed name must be disabled in
# persistent Codex config before a managed session selectively enables it.
fixture_codex_config="$code_skills_home/.codex/config.toml"
grep -F 'model = "fixture-model"' "$fixture_codex_config" >/dev/null \
    || fail "Codex skill policy replaced unrelated configuration"
grep -F 'name = "unrelated"' "$fixture_codex_config" >/dev/null \
    || fail "Codex skill policy replaced an unrelated skill entry"
for fixture_skill in bus demo second story; do
    grep -F "name = \"agent:$fixture_skill\"" "$fixture_codex_config" >/dev/null \
        || fail "Codex skill policy omitted the managed $fixture_skill skill"
done
[ "$(grep -c '^enabled = false$' "$fixture_codex_config")" -eq 4 ] \
    || fail "Codex skill policy did not disable exactly the managed fixture skills"

# A plugin refresh can fail after persistent policy is written. Keep a retired
# name disabled until a later successful refresh proves the old plugin content
# is gone; pruning it first would make that stale installed skill ambient.
fixture_codex_config_next="$fixture_codex_config.next"
/usr/bin/awk '
    $0 == "# END AgentStart managed fleet skills" {
        print "[[skills.config]]"
        print "name = \"agent:retired\""
        print "enabled = false"
        print ""
    }
    { print }
' "$fixture_codex_config" >"$fixture_codex_config_next"
mv "$fixture_codex_config_next" "$fixture_codex_config"
if HOME="$code_skills_home" CODEX_HOME="$code_skills_home/.codex" \
    AGENTSTART_RESOURCES_ROOT="$fixture_resources_root" \
    AGENTSTART_PI_SUBAGENTS_ROOT="$fixture_pi_subagents_root" \
    AGENTSTART_CODEX_BIN=/usr/bin/false \
    "$root/scripts/render-capabilities" --install >/dev/null 2>&1; then
    fail "Codex resource rendering accepted a failed plugin refresh"
fi
grep -F 'name = "agent:retired"' "$fixture_codex_config" >/dev/null \
    || fail "failed Codex plugin refresh pruned a stale skill disable"
HOME="$code_skills_home" CODEX_HOME="$code_skills_home/.codex" \
    AGENTSTART_RESOURCES_ROOT="$fixture_resources_root" \
    AGENTSTART_PI_SUBAGENTS_ROOT="$fixture_pi_subagents_root" \
    AGENTSTART_CODEX_BIN=/usr/bin/true \
    "$root/scripts/render-capabilities" --install >/dev/null
if grep -F 'name = "agent:retired"' "$fixture_codex_config" >/dev/null; then
    fail "successful Codex plugin refresh did not prune a retired skill disable"
fi
[ "$(grep -c '^enabled = false$' "$fixture_codex_config")" -eq 4 ] \
    || fail "successful Codex plugin refresh changed the managed disable set"

fixture_policy_before=$(/usr/bin/shasum -a 256 "$fixture_codex_config" | awk '{print $1}')
HOME="$code_skills_home" CODEX_HOME="$code_skills_home/.codex" \
    "$root/scripts/sync-codex-skill-policy" \
    "$fixture_resources_root/managed-skills.txt"
fixture_policy_after=$(/usr/bin/shasum -a 256 "$fixture_codex_config" | awk '{print $1}')
[ "$fixture_policy_before" = "$fixture_policy_after" ] \
    || fail "Codex skill policy is not idempotent"

fixture_bad_codex_home="$code_skills_home/bad-codex-home"
mkdir -p "$fixture_bad_codex_home"
printf '%s\n' '# BEGIN AgentStart managed fleet skills (do not edit)' \
    >"$fixture_bad_codex_home/config.toml"
if CODEX_HOME="$fixture_bad_codex_home" "$root/scripts/sync-codex-skill-policy" \
    "$fixture_resources_root/managed-skills.txt" >/dev/null 2>&1; then
    fail "Codex skill policy accepted malformed ownership markers"
fi
[ ! -e "$code_skills_home/.pi/agent/extensions/pi-subagents" ] \
    || fail "skill sync installed the Pi subagent package into Pi's ambient root"

# A matching version is a no-op: this is the one pack resource large enough
# that re-copying it every six hours would be felt.
printf 'sentinel\n' >"$fixture_pi_subagents_packed/render-sentinel"
HOME="$code_skills_home" AGENTSTART_CODE_ROOT="$code_skills_root" \
    AGENTSTART_NPX_BIN="$root/tests/fixtures/npx" \
    AGENTSTART_TEST_NPX_LOG="$code_skills_log" \
    AGENTSTART_CLAUDE_BIN=/usr/bin/true \
    AGENTSTART_CODEX_BIN=/usr/bin/true \
    AGENTSTART_PI_SUBAGENTS_ROOT="$fixture_pi_subagents_root" \
    "$root/scripts/sync-skills" >/dev/null
[ -f "$fixture_pi_subagents_packed/render-sentinel" ] \
    || fail "the renderer re-copied an unchanged Pi subagent package"

# A newer pin replaces the packed copy wholesale.
/usr/bin/sed -i '' 's/"9.9.9"/"9.9.10"/' \
    "$fixture_pi_subagents_root/pi-subagents/package.json"
HOME="$code_skills_home" AGENTSTART_CODE_ROOT="$code_skills_root" \
    AGENTSTART_NPX_BIN="$root/tests/fixtures/npx" \
    AGENTSTART_TEST_NPX_LOG="$code_skills_log" \
    AGENTSTART_CLAUDE_BIN=/usr/bin/true \
    AGENTSTART_CODEX_BIN=/usr/bin/true \
    AGENTSTART_PI_SUBAGENTS_ROOT="$fixture_pi_subagents_root" \
    "$root/scripts/sync-skills" >/dev/null
[ ! -e "$fixture_pi_subagents_packed/render-sentinel" ] \
    || fail "the renderer kept a stale Pi subagent package across a version change"
grep -F '"9.9.10"' "$fixture_pi_subagents_packed/package.json" >/dev/null \
    || fail "the renderer did not carry the newer Pi subagent pin into fixed Pi resources"
[ ! -e "$code_skills_home/.agents/skills/demo" ] \
    || fail "skill sync leaked a managed skill into Fx's compatibility root"

# A failing hook is a failing sync, and the message names the project.
set +e
hook_failure=$(
    HOME="$code_skills_home" AGENTSTART_CODE_ROOT="$code_skills_root" \
        AGENTSTART_NPX_BIN="$root/tests/fixtures/npx" \
        AGENTSTART_TEST_HOOK_EXIT=9 \
        "$root/scripts/sync-skills" 2>&1
)
hook_failure_status=$?
set -e
[ "$hook_failure_status" -ne 0 ] \
    || fail "skill sync ignored a failing post-sync hook"
printf '%s\n' "$hook_failure" | grep -F 'agentdemo post-sync hook failed' >/dev/null \
    || fail "post-sync hook failure does not name the project to fix"

# A checkout without skills is silently not a participant, but a participant
# whose synchronization fails is a real error, and the message has to name the
# project: the operator is being asked to go fix that repository.
set +e
scan_failure=$(
    HOME="$code_skills_home" AGENTSTART_CODE_ROOT="$code_skills_root" \
        AGENTSTART_NPX_BIN="$root/tests/fixtures/npx" \
        AGENTSTART_TEST_NPX_OUTPUT=skills-cli-failure-detail \
        AGENTSTART_TEST_NPX_LOCAL_EXIT=9 \
        "$root/scripts/sync-skills" 2>&1
)
scan_failure_status=$?
set -e
[ "$scan_failure_status" -ne 0 ] \
    || fail "skill sync ignored a failing skills tool"
# The scan walks the root in order, so agentbus is the participant that fails.
printf '%s\n' "$scan_failure" | grep -F 'agentbus' >/dev/null \
    || fail "skill sync failure does not name the project to fix"
printf '%s\n' "$scan_failure" | grep -F 'skills-cli-failure-detail' >/dev/null \
    || fail "skill sync hid the skills CLI's captured failure output"

# shellcheck disable=SC2016 # Match the literal internal wrapper invocation.
grep -F '"$script_dir/run-skills-cli" npx --yes skills add' scripts/install.sh >/dev/null \
    || fail "the full installer does not quiet successful external skill installs"
# shellcheck disable=SC2016 # Match the literal internal wrapper invocation.
grep -F '"$script_dir/run-skills-cli" npx --yes skills remove' scripts/install.sh >/dev/null \
    || fail "the full installer does not quiet successful legacy skill removal"

# shellcheck disable=SC2016 # Match the exclusion guard the scan must not have.
if grep -F '[ "$project_name" != agentvoice ] || continue' scripts/sync-skills >/dev/null; then
    fail "the skill scan exempts AgentVoice by name"
fi

# The installation plan embeds the skill sync's own plan, pointed at the
# fixture tree so the asserted lines are the same on every machine.
install_plan=$(HOME="$code_skills_home" AGENTSTART_CODE_ROOT="$code_skills_root" "$root/scripts/install.sh" --check)
# shellcheck disable=SC2016,SC2088 # Plan lines are literal, including $ and ~.
for required_install in \
    'curl -fsSL https://claude.ai/install.sh | XDG_CACHE_HOME=~/Library/Caches bash  # keep vendor staging off a machine-managed ~/.cache symlink' \
    'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh' \
    'curl -fsSL https://pi.dev/install.sh | sh  # in its own session, no controlling terminal' \
    'brew install or upgrade zig  # AgentVoice'"'"'s native duplex audio path builds against it' \
    '~/code/fxnk/scripts/install.sh --install --sha d5e5da7aad0bbfa9b0792a02f72e802e8606b20c  # exact ship-gate-approved Fx Integration consumer pin' \
    'brew install or upgrade llm  # an AI CLI, so AgentStart'"'"'s outright — moved out of the machine'"'"'s Brewfile' \
    'brew install or upgrade hunk  # review-first diff TUI whose bundled agent skill follows the installed build' \
    'brew install or upgrade rustup  # Terminal Control builds from crates.io with the current stable Rust toolchain' \
    'brew install or upgrade zig@0.15  # Terminal Control'"'"'s libghostty-vt build requires the keg-only 0.15 line' \
    '"$(brew --prefix rustup)/bin/rustup" toolchain install stable --profile minimal' \
    'PATH="$(brew --prefix)/opt/zig@0.15/bin:$PATH" "$(brew --prefix rustup)/bin/rustup" run stable cargo install --locked --root "$HOME/.local" terminal-control' \
    'install AgentStart'"'"'s detached-start shim at ~/.local/bin/termctrl while retaining the upstream executable under ~/.local/libexec/agentstart/terminal-control' \
    'brew install or upgrade herdr only while every default/named server socket is proved inactive  # after cutover, upgrades additionally require explicit inactive-maintenance authorization' \
    'initially select Homebrew Herdr only with explicit inactive-cutover authorization, protocol 21+, and no live or uncertain server sockets, then remove the receipt-proved legacy source build  # ordinary convergence recognizes completed cutover; ambiguous evidence preserves legacy' \
    'herdr integration install claude, codex, and pi  # Claude and Codex are pinned to canonical ~/.claude and ~/.codex, and stale swap-session hooks are pruned' \
    '~/code/fmx/scripts/install.sh --install  # canonical consumer path: editable fmx plus exact source-built fmx-fx and fmx-zmx pins; reuses AgentStart'"'"'s already-gated Fx build' \
    'scripts/fmx-config install  # link the Herdr-compatible fmx key subset with the operator'"'"'s Ctrl-Space prefix' \
    'scripts/herdr-config install  # render, validate, and activate the generated Herdr config, then reload it' \
    'remove AgentStart-owned ~/Library/Application Support/io.datasette.llm/extra-openai-models.yaml symlink  # its extra model records are obsolete' \
    'remove ownership-verified AgentSurface, AgentBus, and Orca harness integrations' \
    'remove AgentStart-managed skills from Fx-visible compatibility roots, including retired livekit-simulations  # full install only; independent occupants are preserved' \
    'remove renamed skills left in the fixed resources: supervisor  # full install only; the renamed /supervise skill replaces it' \
    'npm install --global @native-sdk/cli@0.7  # the line the native-sdk skill documents' \
    'npm install --global agent-browser@0.33.2  # Agentbrowse provider + Agentscrape stable-session driver share this exact build' \
    'ln -sfn "$(command -v agent-browser)" ~/.local/bin/agent-browser  # the candidate Agentscrape resolves before PATH' \
    'scripts/agentbrowse-config install  # link the locked Artbird-first, already-enabled-Apple-second deployment configuration' \
    'scripts/agent-browser-config install  # select agentbrowse'"'"'s short-lived ordered provider; no provider server or static URL' \
    'remove AgentStart'"'"'s retired ~/.local/bin/fmx-release-local helper  # preserve an independent occupant' \
    'codex mcp add shadcn -- npx shadcn@latest mcp' \
    'claude mcp add --scope user shadcn -- npx shadcn@latest mcp' \
    'native skills list' \
    'ln -sfn ~/.local/share/agentstart/resources/guidance/AGENTS.md ~/.claude/CLAUDE.md  # Claude Code reads CLAUDE.md, not AGENTS.md' \
    'ln -sfn ~/.local/share/agentstart/resources/guidance/AGENTS.md ~/.codex/AGENTS.md  # Codex skips empty guidance files' \
    'ln -sfn ~/.local/share/agentstart/resources/guidance/AGENTS.md ~/.pi/agent/AGENTS.md  # pi'"'"'s global slot' \
    'remove AgentStart-owned ~/AGENTS.md symlink  # retired hub; independent occupants are preserved' \
    'ln -sfn prompts/agentvoice/server.json into ~/.config/agentvoice  # the voice server configuration, read at server boot' \
    'ln -sfn ~/.agents/prompts/agentvoice/{ORCHESTRATOR.md,ORCHESTRATOR_SESSION_START.md} into ~/.config/agentvoice  # the voice orchestrator'"'"'s doctrine; agentguidance renders it, so this links after sync-skills' \
    'ln -sfn prompts/agentguidance/{SYSTEM,GUIDELINES,TOOLS}.md into ~/.config/agentguidance  # the extension prompts agentguidance renders against' \
    'install external skill packs with --copy into ~/.local/share/agentstart/resources/skills' \
    'https://github.com/vercel-labs/skills: find-skills' \
    'https://github.com/anthropics/skills: frontend-design' \
    'https://github.com/vercel-labs/agent-skills: web-design-guidelines, vercel-react-best-practices' \
    'https://github.com/vercel/ai: ai-sdk' \
    'https://github.com/vercel/ai-elements: ai-elements' \
    'https://github.com/shadcn/ui: shadcn' \
    'https://github.com/vercel-labs/native: native-sdk' \
    'anomalyco/terminal-control@v<installed termctrl version>: terminal-control' \
    'hunk skill path hunk-review  # the review skill ships inside the binary and stays version-matched to it' \
    'install hunk-review with --copy into the fixed resources' \
    'herdr --skill, rendered to ~/.local/share/agentstart/herdr-skill/skills/herdr/SKILL.md  # the surface skill ships inside the binary, so it converges with the installed build, never a stale copy' \
    'install herdr with --copy into the fixed resources' \
    'render one session-only Claude plugin named agent (/agent:<skill>)' \
    'render and refresh the skills-only Codex plugin agent@agentstart-managed' \
    'persistently disable every agent:<skill> outside managed Codex sessions' \
    'leave retired-path and ambient-link cleanup to the explicit full installer' \
    "npx --yes skills add \"$code_skills_root/agentdemo\" --agent claude-code --skill demo second --global --copy --yes" \
    "\"$code_skills_root/agentdemo/scripts/post-sync\""; do
    printf '%s\n' "$install_plan" | grep -F "$required_install" >/dev/null \
        || fail "installation plan is missing: $required_install"
done

# shellcheck disable=SC2016 # Match the literal installer variables.
grep -F '"$fmx_root/scripts/install.sh" --install' scripts/install.sh >/dev/null \
    || fail "the full installer does not delegate to Fmx's source installer"
# shellcheck disable=SC2016 # Match the literal installer variables.
grep -F 'FMX_FX_COMMIT="$fx_integration_sha"' scripts/install.sh >/dev/null \
    || fail "the Fmx source install is not bound to AgentStart's Fx pin"
grep -F 'Preserving independent occupant at retired Fmx release path' scripts/install.sh >/dev/null \
    || fail "the installer does not preserve an independent retired-path occupant"

# shellcheck disable=SC2016 # Match the literal per-user cache root.
grep -F 'XDG_CACHE_HOME="$HOME/Library/Caches" install_official "Claude Code"' \
    scripts/install.sh >/dev/null \
    || fail "Claude's native installer does not use the stable macOS cache root"

# Fx remains a required harness, but fxnk owns its fork and installer. This
# repository invokes the public contract and carries no second implementation.
grep -Eq '^fx_integration_sha=[0-9a-f]{40}$' scripts/install.sh \
    || fail "installer does not carry one full lowercase Fx Integration consumer pin"
# shellcheck disable=SC2016 # Match the literal configurable code-root contract.
grep -F 'fxnk_installer="$code_root/fxnk/scripts/install.sh"' scripts/install.sh >/dev/null \
    || fail "installer does not resolve fxnk's Fx installation contract"
# shellcheck disable=SC2016 # Match the literal installer variable invocation.
grep -F '"$fxnk_installer" --install --sha "$fx_integration_sha"' scripts/install.sh >/dev/null \
    || fail "installer does not invoke fxnk's exact-SHA Fx installation contract"
[ ! -e scripts/install-fx ] \
    || fail "AgentStart retains a second Fx installer"
if grep -F 'https://fx.sh/setup.sh' scripts/install.sh >/dev/null; then
    fail "installer retains the official Fx bootstrap beside the integration build"
fi
if grep -F 'upgrade --channel dev' scripts/install.sh >/dev/null; then
    fail "installer retains the Fx dev channel beside the integration build"
fi
# shellcheck disable=SC2016 # Assert the literal environment pin in the installer.
grep -F 'CODEX_HOME="$HOME/.codex" "$herdr_bin" integration install "$harness"' \
    scripts/install.sh >/dev/null \
    || fail "Herdr's Codex integration can inherit a disposable multi-auth CODEX_HOME"
grep -F "codex-multi-auth-runtime-home-[^/']+/herdr-agent-state\\.sh" \
    scripts/install.sh >/dev/null \
    || fail "installer does not prune stale Codex multi-auth Herdr hook definitions"
# shellcheck disable=SC2016 # Assert the literal environment pin in the installer.
grep -F 'CLAUDE_CONFIG_DIR="$HOME/.claude" "$herdr_bin" integration install "$harness"' \
    scripts/install.sh >/dev/null \
    || fail "Herdr's Claude integration can inherit a claude-swap session CLAUDE_CONFIG_DIR"
grep -F "/\\.claude-swap-backup/sessions/" \
    scripts/install.sh >/dev/null \
    || fail "installer does not prune stale Claude swap-session Herdr hook definitions"
printf '%s\n' "$install_plan" | grep -F 'retired livekit-simulations' >/dev/null \
    || fail "installation plan no longer scrubs the retired LiveKit skill"
# A rename leaves the previous skill directory in the pack, and the additive
# scan never removes it, so both spellings would reach every session.
grep -F 'remove_renamed_pack_skills' scripts/install.sh >/dev/null \
    || fail "installer no longer prunes renamed skills left in the fixed resources"
# AgentVoice exports skills/ like the other agent tools and is scanned like
# them; nothing about it is special to this plan.
printf '%s\n' "$install_plan" \
    | grep -F "skills add \"$code_skills_root/agentvoice\"" >/dev/null \
    || fail "installation plan omits the skills AgentVoice exports by convention"
# The agentchats checkout ships its chats skill through the scan; an explicit
# line would be the second synchronization path its guidance forbids.
if printf '%s\n' "$install_plan" \
    | grep -F '/code/agentchats"' >/dev/null; then
    fail "installation plan still synchronizes chats explicitly beside the scan"
fi
# The agentdesk checkout ships its desktop skill through the same scan; the
# same rule holds.
if printf '%s\n' "$install_plan" \
    | grep -F '/code/agentdesk"' >/dev/null; then
    fail "installation plan still synchronizes desktop explicitly beside the scan"
fi
# The ownership boundary: desktop applications and the GitHub CLI belong to the
# machine layer, so a cask or gh line here means the seam is leaking back.
if printf '%s\n' "$install_plan" | grep -Eq -- '--cask|brew install or upgrade gh'; then
    fail "installation plan crossed the boundary: desktop casks and gh are the machine's"
fi

# shellcheck disable=SC2016 # Match the literal helper invocations in the script.
for sync_invocation in \
    '"$script_dir/sync-skills" --check' \
    '"$script_dir/sync-skills"'; do
    grep -F "$sync_invocation" scripts/install.sh >/dev/null \
        || fail "installer does not run the skill sync: $sync_invocation"
done
# Agentguidance ships through the scan like every participant; an explicit
# line for it here would be the second synchronization path its guidance
# forbids, and the render belongs to its post-sync hook, not to this
# installer.
if grep -En "$operator_account|agentguidance" scripts/install.sh \
    | grep -vF 'prompts/agentguidance' \
    | grep -vF '.config/agentguidance' \
    | grep -vF 'agentguidance renders' \
    | grep -vF "agentguidance's" >/dev/null; then
    fail "installer grew agentguidance handling beyond the extension prompts; the scan and post-sync hook own the rest"
fi
grep -F 'link_agent_guidance' scripts/install.sh >/dev/null \
    || fail "installer does not link the harness guidance"
# shellcheck disable=SC2016 # Match the literal target paths in the script.
grep -F '"$HOME/.claude/CLAUDE.md" "$HOME/.codex/AGENTS.md" "$HOME/.pi/agent/AGENTS.md"' scripts/install.sh >/dev/null \
    || fail "installer does not target all three harness guidance locations"
grep -F 'refusing to replace independent guidance' scripts/install.sh >/dev/null \
    || fail "installer would replace independent guidance files"
# shellcheck disable=SC2016 # Match the literal direct-link operation.
grep -F 'ln -sfn "$source" "$target"' scripts/install.sh >/dev/null \
    || fail "installer does not link each harness slot directly to the guidance source"
if grep -F 'home_guidance=' scripts/install.sh >/dev/null \
    || grep -F 'ln -sfn prompts/AGENTS.md ~/AGENTS.md' scripts/install.sh >/dev/null; then
    fail "installer still creates the retired home guidance hub"
fi
grep -q '^ *remove_retired_home_guidance$' scripts/install.sh \
    || fail "installer does not remove its retired home guidance symlink"
grep -F 'link_extension_prompts' scripts/install.sh >/dev/null \
    || fail "installer does not link the operator extension prompts"
grep -F 'refusing to replace independent extension prompt' scripts/install.sh >/dev/null \
    || fail "installer would replace an independent extension prompt"
for prompt_name in SYSTEM.md GUIDELINES.md TOOLS.md; do
    grep -F "$prompt_name" scripts/install.sh >/dev/null \
        || fail "installer does not link the $prompt_name extension prompt"
done
grep -F 'link_agentvoice_config' scripts/install.sh >/dev/null \
    || fail "installer does not link the AgentVoice doctrine"
grep -F 'refusing to replace independent AgentVoice configuration' scripts/install.sh >/dev/null \
    || fail "installer would replace independent AgentVoice configuration"
for doctrine_name in ORCHESTRATOR.md ORCHESTRATOR_SESSION_START.md server.json; do
    grep -F "$doctrine_name" scripts/install.sh >/dev/null \
        || fail "installer does not link the AgentVoice $doctrine_name"
done
# shellcheck disable=SC2016 # Match the literal home-guidance source path.
grep -F 'source="$repo_root/prompts/AGENTS.md"' scripts/install.sh >/dev/null \
    || fail "installer does not own the harness guidance source"
grep -F 'install_or_upgrade_formula llm' scripts/install.sh >/dev/null \
    || fail "installer does not converge the llm CLI"
grep -F 'remove_retired_llm_config' scripts/install.sh >/dev/null \
    || fail "installer does not retire its obsolete llm model configuration"
# shellcheck disable=SC2016 # Match the literal ownership check in the script.
grep -F 'readlink "$target"' scripts/install.sh >/dev/null \
    || fail "installer does not verify ownership before removing the retired llm configuration"
if grep -F 'link_llm_config' scripts/install.sh >/dev/null; then
    fail "installer still links the obsolete llm model configuration"
fi

# The native-sdk skill documents the 0.7 line and Zig builds both Native SDK
# applications and AgentVoice's opt-in native duplex audio device, so both
# stay pinned rather than tracking latest. agent-browser is pinned because
# Agentbrowse's provider protocol and Agentscrape's driver behavior are tested
# against that exact build.
grep -F 'native_sdk_version=0.7' scripts/install.sh >/dev/null \
    || fail "installer does not pin the Native SDK CLI to the compatible 0.7 line"
if grep -F '@native-sdk/cli@latest' scripts/install.sh >/dev/null; then
    fail "installer tracks the latest Native SDK CLI release"
fi
grep -F 'install_or_upgrade_formula zig' scripts/install.sh >/dev/null \
    || fail "installer does not converge the Zig toolchain"

# Terminal Control is built from its locked crates.io release with the exact
# Zig line libghostty-vt requires. Its upstream skill is selected from the
# installed binary's matching release tag and then shipped through the common
# fixed private resources to Claude Code, Codex, and Pi.
grep -F 'install_or_upgrade_formula rustup' scripts/install.sh >/dev/null \
    || fail "installer does not converge Rustup for Terminal Control"
# shellcheck disable=SC2016 # Match the literal formula-owned Rustup variable.
grep -F '"$rustup_bin" toolchain install stable --profile minimal' scripts/install.sh >/dev/null \
    || fail "installer does not converge a current Rust toolchain for Terminal Control"
# shellcheck disable=SC2016 # Match the literal cargo install root and Zig path.
grep -F 'PATH="$brew_prefix/opt/zig@0.15/bin:$PATH"' scripts/install.sh >/dev/null \
    || fail "Terminal Control is not built with the required Zig 0.15 line"
# shellcheck disable=SC2016 # Match the literal cargo install root.
grep -F 'cargo install --locked --root "$HOME/.local" terminal-control' scripts/install.sh >/dev/null \
    || fail "installer does not converge the locked Terminal Control crate"
grep -F '# AgentStart-managed Terminal Control shim.' \
    config/terminal-control/termctrl >/dev/null \
    || fail "Terminal Control shim is missing its ownership marker"
# shellcheck disable=SC2016 # Match the literal private upstream payload path.
grep -F 'termctrl_real_dir="$HOME/.local/libexec/agentstart/terminal-control"' \
    scripts/install.sh >/dev/null \
    || fail "installer does not retain the upstream Terminal Control executable under libexec"
grep -F "grep -F -m 1 '# AgentStart-managed Terminal Control shim.'" \
    scripts/install.sh >/dev/null \
    || fail "installer cannot recognize and restore its Terminal Control shim before Cargo runs"
# shellcheck disable=SC2016 # Match the literal shim and public binary variables.
grep -F 'install -m 0755 "$termctrl_shim" "$termctrl_bin"' \
    scripts/install.sh >/dev/null \
    || fail "installer does not put the Terminal Control shim at the public command path"
# shellcheck disable=SC2016 # Match the literal version variable in the skill source.
grep -F '"anomalyco/terminal-control@v$terminal_control_version" terminal-control' \
    scripts/install.sh >/dev/null \
    || fail "installer does not bind the Terminal Control skill to the installed CLI release"
# shellcheck disable=SC2016 # Backticks name the advertised skill literally.
grep -F '`terminal-control` — real terminal applications:' \
    prompts/agentguidance/TOOLS.md >/dev/null \
    || fail "TOOLS.md does not advertise the Terminal Control skill"
grep -F 'desktop, terminal-control' skills/fleet/MAP.md >/dev/null \
    || fail "the fleet skill route map omits the Terminal Control advertisement"
# shellcheck disable=SC2016 # Backticks name the advertised skill literally.
grep -F '`attention` — durable human handoff' \
    prompts/agentguidance/TOOLS.md >/dev/null \
    || fail "TOOLS.md does not advertise the Attention skill"

# Herdr stages the official stable Homebrew formula but must retain the
# compatible source-built client while the formula is below fleet protocol 21
# or any default/named server socket exists. The retired updater is absent,
# and inactive cutover removes its binary only when the 40-hex receipt,
# regular-file shape, owner, and write-time all agree.
grep -F 'install_or_upgrade_formula zig@0.15' scripts/install.sh >/dev/null \
    || fail "installer does not converge the Zig 0.15 line Terminal Control builds against"
grep -F 'install_or_upgrade_formula herdr' scripts/install.sh >/dev/null \
    || fail "installer does not converge the official stable Herdr formula"
# shellcheck disable=SC2016 # Match the literal selector invocation.
grep -F 'herdr_socket_state=$("$script_dir/select-herdr-runtime" --socket-state)' scripts/install.sh >/dev/null \
    || fail "installer does not inspect Herdr sockets before Homebrew convergence"
# shellcheck disable=SC2016 # Match the literal selector invocation.
grep -F 'herdr_legacy_state=$("$script_dir/select-herdr-runtime" --legacy-state)' scripts/install.sh >/dev/null \
    || fail "installer does not distinguish pre-cutover, post-cutover, and clean-install state"
grep -F 'Deferring Homebrew Herdr installation or upgrade while a server socket is present.' scripts/install.sh >/dev/null \
    || fail "installer does not preserve installed Herdr client bytes around a live server"
grep -F 'Deferring post-cutover Homebrew Herdr upgrade without explicit inactive-maintenance authorization.' scripts/install.sh >/dev/null \
    || fail "installer can race a post-cutover formula upgrade against a new server"
[ ! -e scripts/update-herdr ] \
    || fail "retired source updater still exists"
# shellcheck disable=SC2016 # Match the literal checkout path.
if grep -F '$HOME/src/herdr' scripts/install.sh >/dev/null; then
    fail "installer still binds the Herdr source checkout"
fi
# Anchored to an invocation: normal stable updates belong to Homebrew.
if grep -E '^[[:space:]]*herdr update' scripts/install.sh >/dev/null; then
    fail "installer grows a second Herdr update path beside Homebrew"
fi
if grep -F 'herdr.dev/install.sh' scripts/install.sh >/dev/null; then
    fail "installer uses Herdr's direct installer instead of Homebrew"
fi
# shellcheck disable=SC2016 # Match the exact selector invocation.
grep -F 'herdr_bin=$("$script_dir/select-herdr-runtime" "$brew_prefix/bin/herdr")' scripts/install.sh >/dev/null \
    || fail "installer does not select a safe Herdr runtime after staging Homebrew"
grep -F 'fleet_minimum_protocol=21' scripts/select-herdr-runtime >/dev/null \
    || fail "Herdr cutover does not enforce fleet protocol 21"
# shellcheck disable=SC2016 # Match the literal configurable protocol expression.
grep -F '[ "$minimum_protocol" -ge "$fleet_minimum_protocol" ]' scripts/select-herdr-runtime >/dev/null \
    || fail "Herdr cutover allows its protocol floor to be lowered"
# shellcheck disable=SC2016 # Match the literal socket-root variable.
grep -F 'server_socket_state "$herdr_config_root"' scripts/select-herdr-runtime >/dev/null \
    || fail "Herdr cutover does not conservatively inspect default and named server sockets"
# shellcheck disable=SC2016 # Match the literal completed-cutover predicate.
grep -F 'if [ "$legacy_evidence_present" -eq 0 ]; then' scripts/select-herdr-runtime >/dev/null \
    || fail "Herdr runtime selection does not recognize a completed cutover"
# shellcheck disable=SC2016 # Match the literal config-root uncertainty guard.
grep -F '[ ! -L "$herdr_config_root" ]' scripts/select-herdr-runtime >/dev/null \
    || fail "Herdr cutover follows an uncertain socket-root symlink"
grep -F 'AGENTSTART_HERDR_ALLOW_CUTOVER must be 0 or 1' scripts/select-herdr-runtime >/dev/null \
    || fail "Herdr cutover does not require explicit authorization"
# shellcheck disable=SC2016 # Match literal legacy cleanup variables and predicates.
grep -F 'legacy_herdr_receipt="$legacy_herdr_state/herdr-built-commit"' scripts/select-herdr-runtime >/dev/null \
    || fail "installer does not recognize the retired source-build receipt"
# shellcheck disable=SC2016 # Match the literal legacy receipt variable.
grep -F '[[ "$legacy_herdr_commit" =~ ^[0-9a-f]{40}$ ]]' scripts/select-herdr-runtime >/dev/null \
    || fail "legacy Herdr cleanup does not validate the receipt"
# shellcheck disable=SC2016 # Match the literal legacy binary variable.
grep -F '[ ! -L "$legacy_herdr_bin" ]' scripts/select-herdr-runtime >/dev/null \
    || fail "legacy Herdr cleanup could remove an independent symlink"
grep -F "stat -f '%Su' \"\$legacy_herdr_bin\"" scripts/select-herdr-runtime >/dev/null \
    || fail "legacy Herdr cleanup does not prove the binary owner"
grep -F "stat -f '%m' \"\$legacy_herdr_bin\"" scripts/select-herdr-runtime >/dev/null \
    || fail "legacy Herdr cleanup does not match the updater write time"
# shellcheck disable=SC2016 # Match the literal legacy binary variable.
grep -F 'rm -- "$legacy_herdr_bin"' scripts/select-herdr-runtime >/dev/null \
    || fail "installer does not remove its proved legacy Herdr binary"
# shellcheck disable=SC2016 # Match the literal legacy state variables.
grep -F 'rm -f -- "$legacy_herdr_receipt" "$legacy_herdr_build_log"' scripts/select-herdr-runtime >/dev/null \
    || fail "installer does not retire its Herdr build state"
# shellcheck disable=SC2016 # Match the literal Homebrew resolution assertion.
grep -F '[ "$(command -v herdr)" = "$herdr_bin" ]' scripts/install.sh >/dev/null \
    || fail "installer does not verify that Homebrew Herdr wins resolution"
grep -F 'install_herdr_integrations' scripts/install.sh >/dev/null \
    || fail "installer does not converge the herdr harness integrations"
grep -F 'for harness in claude codex pi' scripts/install.sh >/dev/null \
    || fail "herdr integrations do not cover the three harnesses the fleet runs"

# AgentStart owns Herdr's behavior config and renders it into the live file,
# because Herdr writes its own keys there. It carries no palette: Herdr's
# `terminal` theme follows the terminal, which runs its own default colors.
[ -s config/herdr/config.toml ] \
    || fail "AgentStart's Herdr base config is missing"
grep -F 'plugin pane open --plugin agentsurface --entrypoint launch' \
    config/herdr/config.toml >/dev/null \
    || fail "AgentSurface binding does not open its plugin launch pane"
grep -F 'plugin pane open --plugin agentsurface --entrypoint usage' \
    config/herdr/config.toml >/dev/null \
    || fail "agentusage binding does not open its AgentSurface plugin pane"
grep -F 'plugin pane open --plugin agentsurface --entrypoint voice' \
    config/herdr/config.toml >/dev/null \
    || fail "agentvoice binding does not open its AgentSurface plugin pane"
grep -F 'HERDR_ACTIVE_PANE_CWD' config/herdr/config.toml >/dev/null \
    || fail "AgentSurface plugin popup does not preserve the active pane cwd"
for action in pane tab workspace; do
    grep -Fqx "close_${action} = \"\"" config/herdr/config.toml \
        || fail "Herdr's immediate close_${action} action is still enabled"
done
for target in pane tab workspace; do
    grep -F "plugin pane open --plugin agentsurface --entrypoint confirm-close-${target}" \
        config/herdr/config.toml >/dev/null \
        || fail "Herdr ${target} close does not open its AgentSurface confirmation pane"
done
if grep -E 'confirm-close-(pane|tab|workspace).*--target-pane' \
    config/herdr/config.toml >/dev/null; then
    fail "Herdr popup close confirmations pass unsupported layout targets"
fi
grep -F 'command = "agentsurface launch"' config/herdr/config.toml >/dev/null \
    && fail "AgentSurface binding still opens an untitled generic popup"
grep -F 'command = "escape-to-quit agentusage"' config/herdr/config.toml >/dev/null \
    && fail "agentusage binding still opens an untitled generic popup"
if grep -E 'key = "prefix\+[\[\]]"' config/herdr/config.toml >/dev/null; then
    fail "Herdr config still contains theme-cycling bindings"
fi
sidebar_settings=$(grep -E '^sidebar_[[:alnum:]_]* = ' config/herdr/config.toml || true)
[ "$sidebar_settings" = 'sidebar_max_width = 106
sidebar_collapsed_mode = "hidden"' ] \
    || fail "Herdr sidebar does not keep its 50%-of-screen width allowance and hidden collapsed mode"
if grep -E '^status_indicators = ' config/herdr/config.toml >/dev/null; then
    fail "Herdr config still customizes the left sidebar beyond its width, sort, and agent rows"
fi
# Herdr overwrites the runtime agent sort from config on every reload, so an
# absent key does not mean "leave it alone" — it means the in-app toggle
# reverts to grouped whenever this file changes.
grep -F 'agent_panel_sort = "priority"' config/herdr/config.toml >/dev/null \
    || fail "Herdr agent panel does not hold the priority sort across config reloads"
# The Agents panel must name the project (root repository plus worktree branch)
# and the conversation slug AgentSurface publishes. Herdr's defaults draw the
# workspace label and the harness kind instead, which identify neither, and
# this has regressed twice — pin the rows, not just the section.
grep -F '[ui.sidebar.agents]' config/herdr/config.toml >/dev/null \
    || fail "Herdr agent sidebar rows are missing"
grep -F "[\"state_icon\", { token = \"\$project\", bold = true, dim = false }]," \
    config/herdr/config.toml >/dev/null \
    || fail "Herdr agent sidebar does not lead with AgentSurface's \$project token"
grep -F "[\"\$conversation\"]," config/herdr/config.toml >/dev/null \
    || fail "Herdr agent sidebar does not show AgentSurface's \$conversation slug"
grep -F 'delivery = "off"' config/herdr/config.toml >/dev/null \
    || fail "Herdr native notifications are not disabled"
grep -Fqx 'version_check = true' config/herdr/config.toml \
    || fail "Herdr stable version checking is not enabled"
for sound in "done" request; do
    [ -s "assets/herdr-sounds/${sound}.mp3" ] \
        || fail "Herdr ${sound} sound is missing from AgentStart"
    grep -Fqx "${sound}_path = \"../../code/agentstart/assets/herdr-sounds/${sound}.mp3\"" \
        config/herdr/config.toml \
        || fail "Herdr ${sound} sound does not resolve to AgentStart's owned asset"
done
if grep -F 'code/funk/assets/herdr-sounds' config/herdr/config.toml >/dev/null; then
    fail "Herdr sound config still crosses into Funk"
fi
grep -Fqx 'name = "terminal"' config/herdr/config.toml \
    || fail "Herdr does not follow the terminal's own palette"
if grep -Eq '^\[theme\.custom\]' config/herdr/config.toml; then
    fail "Herdr config carries a custom palette instead of following the terminal"
fi
# The theme manager was removed outright: Tinty, its templates, its generated
# palettes, and the Ghostty theme it rendered. This scan covers everything that
# could reintroduce one — config, scripts, prompts, and the two documents that
# describe the shape. It excludes tests/, where these names are the thing being
# banned, and the fleet map, which records the removal in its history.
theme_manager_refs=$(grep -R -Eih 'tinty|tinted-theming|base16|base24|chalk' \
    config scripts prompts README.md CONTEXT.md || true)
# The sole survivor is the marker herdr-config recognizes so a machine still
# carrying the retired render gets migrated rather than refused. It can go once
# every machine has converged past it.
[ "$theme_manager_refs" = 'legacy_marker="# Generated by AgentStart'"'"'s herdr-tinty. Do not edit."' ] \
    || fail "a theme manager reference returned to AgentStart"
[ ! -e config/tinty ] \
    || fail "the retired Tinty configuration is still in the checkout"
[ ! -e scripts/herdr-tinty ] \
    || fail "the retired herdr-tinty helper is still in the checkout"
# Fmx owns the editable link, both native pins, and doctor verification in its
# canonical source installer. AgentStart proves the pin and passes fxnk's exact
# source build instead of reproducing those steps.
# shellcheck disable=SC2016 # Match literal installer variables.
grep -F '[ "$fmx_fx_sha" = "$fx_integration_sha" ]' scripts/install.sh >/dev/null \
    || fail "installer does not bind editable fmx to its exact Fx pin"
# shellcheck disable=SC2016 # Match literal installer variables.
grep -F 'FMX_FX_BINARY="$development_fx"' scripts/install.sh >/dev/null \
    || fail "installer does not reuse fxnk's source-built Fx for fmx-fx"
# shellcheck disable=SC2016 # Match literal installer variables.
grep -F '"$fmx_root/scripts/install.sh" --install' scripts/install.sh >/dev/null \
    || fail "installer does not invoke fmx's canonical source installer"
if grep -F 'Dcompanion' scripts/install.sh >/dev/null; then
    fail "installer builds the Companion by hand instead of through fmx's script"
fi
# fmx's config is linked because fmx does not mutate it; both the tracked source
# and the installer stay pinned to the same Ctrl-Space prefix used by Herdr.
grep -Fqx 'prefix = "ctrl+space"' config/fmx/config.toml \
    || fail "fmx config does not use the operator's Ctrl-Space prefix"
# shellcheck disable=SC2016 # Match the literal installer variable.
grep -F '"$script_dir/fmx-config" install' scripts/install.sh >/dev/null \
    || fail "installer does not link the fmx config"
tests/fmx-config.sh

# shellcheck disable=SC2016 # Match the literal installer variables.
grep -F 'AGENTSTART_HERDR_BIN="$herdr_bin" "$script_dir/herdr-config" install' scripts/install.sh >/dev/null \
    || fail "installer does not render the Herdr config"
tests/herdr-homebrew-cutover.sh
tests/herdr-config.sh

# The AgentSurface popup-pane and tab-naming plugin registers by checkout path;
# linking every run is the converge, and a missing agentsurface checkout is a
# skip, not a failure.
grep -F 'install_herdr_plugins' scripts/install.sh >/dev/null \
    || fail "installer does not link the agentsurface herdr plugin"
# shellcheck disable=SC2016 # Match the literal link invocation, $-sign and all.
grep -F '"$herdr_bin" plugin link "$plugin_root"' scripts/install.sh >/dev/null \
    || fail "the agentsurface plugin is not registered by checkout path"
grep -F 'protocol_mismatch' scripts/install.sh >/dev/null \
    || fail "plugin convergence cannot preserve a newer resident server"
grep -F 'relink deferred until the natural Herdr server restart' scripts/install.sh >/dev/null \
    || fail "deferred plugin convergence does not report the client/server skew"
# The surface skill ships inside the binary (`herdr --skill`) and converges
# with the installed build; a GitHub-sourced copy would track a different
# head than the installed herdr and grow a second update path.
grep -F 'install_herdr_skill' scripts/install.sh >/dev/null \
    || fail "installer does not converge the herdr surface skill"
# shellcheck disable=SC2016 # Match the literal selected runtime variable.
grep -F '"$herdr_bin" --skill' scripts/install.sh >/dev/null \
    || fail "the herdr skill is not rendered from the installed binary"
if grep -E 'skills add https://github.com/[^ ]*herdr' scripts/install.sh >/dev/null; then
    fail "the herdr skill tracks the GitHub head instead of the installed binary"
fi
# Hunk's bundled skill is generated from the same command surface as the
# installed binary. A GitHub-sourced copy could move ahead of Homebrew and
# teach agents flags their local Hunk does not accept.
grep -F 'install_or_upgrade_formula hunk' scripts/install.sh >/dev/null \
    || fail "installer does not install Hunk through its Homebrew update path"
grep -F 'install_hunk_skill' scripts/install.sh >/dev/null \
    || fail "installer does not converge the bundled Hunk review skill"
grep -F 'hunk skill path hunk-review' scripts/install.sh >/dev/null \
    || fail "installer does not resolve the review skill from the installed Hunk binary"
# shellcheck disable=SC2016 # Match the literal pack-root variable in the installer.
grep -F 'install_private_skill_pack "$pack_root" hunk-review' scripts/install.sh >/dev/null \
    || fail "installer does not copy Hunk's bundled review skill into the fixed resources"
if grep -E 'skills add https://github.com/[^ ]*modem-dev/hunk' scripts/install.sh >/dev/null; then
    fail "the Hunk review skill tracks GitHub head instead of the installed binary"
fi
grep -F 'agent_browser_version=0.33.2' scripts/install.sh >/dev/null \
    || fail "installer does not pin the Agentbrowse- and Agentscrape-bound agent-browser build"
grep -F 'refusing to replace independent file' scripts/install.sh >/dev/null \
    || fail "installer would replace an independent ~/.local/bin/agent-browser"

# Pi reads its prompts from /dev/tty, so only removing the controlling
# terminal keeps the run unattended and stops it editing the Stow-managed
# shell profile.
grep -F 'run_without_controlling_terminal /bin/sh' scripts/install.sh >/dev/null \
    || fail "Pi installer is not detached from the controlling terminal"
grep -F 'POSIX::setsid()' scripts/install.sh >/dev/null \
    || fail "Pi installer detachment does not start a new session"

# The fleet statusline is one bar in three harness idioms: a render command
# for claude, a footer extension for pi, and an ordered pick from codex's
# fixed item set — codex has no custom renderer to install.
# shellcheck disable=SC2016 # Match the literal helper invocation in the script.
grep -F '"$script_dir/install-statusline" --install' scripts/install.sh >/dev/null \
    || fail "installer does not converge the fleet statusline"
# shellcheck disable=SC2016 # Match the literal helper invocation in the script.
grep -F '"$script_dir/install-statusline" --check' scripts/install.sh >/dev/null \
    || fail "installation plan omits the fleet statusline"
[ -x scripts/install-statusline ] \
    || fail "the statusline installer is not executable"
for renderer in config/statusline/claude-statusline.sh config/statusline/pi-statusline.ts; do
    [ -s "$renderer" ] \
        || fail "statusline renderer is missing or empty: $renderer"
done
# Claude refuses an independent statusline; Pi's ambient slot is retired and
# an independent occupant is explicitly left untouched.
grep -F 'refusing to replace an independent claude renderer' scripts/install-statusline >/dev/null \
    || fail "the statusline installer would replace an independent Claude file"
grep -F 'Leaving independent pi extension untouched' scripts/install-statusline >/dev/null \
    || fail "the statusline installer would replace an independent Pi extension"
if grep -F 'agent-hooks/claude-statusline.sh' config/statusline/claude-statusline.sh >/dev/null; then
    fail "the claude renderer still forwards statusline payloads to the retired Orca sink"
fi
# shellcheck disable=SC2016 # Match the literal helper invocation in the script.
grep -F '"$script_dir/install-agentvoice-cli"' scripts/install.sh >/dev/null \
    || fail "installer does not install the AgentVoice voice CLI"
# shellcheck disable=SC2016 # Match the literal status variable in the script.
grep -F 'exit "$agentvoice_cli_status"' scripts/install.sh >/dev/null \
    || fail "installer does not propagate an AgentVoice CLI installation failure"
# shellcheck disable=SC2016 # Match the literal helper invocation in the script.
grep -F '"$script_dir/install-agent-clis"' scripts/install.sh >/dev/null \
    || fail "installer does not install the agent CLIs"
# shellcheck disable=SC2016 # Match the literal status variable in the script.
grep -F 'exit "$agent_clis_status"' scripts/install.sh >/dev/null \
    || fail "installer does not propagate an agent CLI installation failure"
# The provider default must land only after the checkout-owned installer has
# succeeded, so a full converge cannot select a command it failed to install.
# shellcheck disable=SC2016 # Match the literal helper invocations in install.sh.
agent_clis_line=$(grep -n '^"$script_dir/install-agent-clis"' scripts/install.sh | cut -d: -f1)
# shellcheck disable=SC2016 # Match the literal helper invocations in install.sh.
agentbrowse_config_line=$(grep -n '^"$script_dir/agentbrowse-config" install$' scripts/install.sh | cut -d: -f1)
# shellcheck disable=SC2016 # Match the literal helper invocations in install.sh.
agent_browser_config_line=$(grep -n '^"$script_dir/agent-browser-config" install$' scripts/install.sh | cut -d: -f1)
[ -n "$agent_clis_line" ] && [ -n "$agentbrowse_config_line" ] && [ -n "$agent_browser_config_line" ] \
    && [ "$agentbrowse_config_line" -gt "$agent_clis_line" ] \
    && [ "$agent_browser_config_line" -gt "$agentbrowse_config_line" ] \
    || fail "agentbrowse and agent-browser configs must be linked in order after the CLIs install"

# Agentweb retirement has a load-bearing activation order: the migrated
# Agentscrape command deploys in the CLI phase; service convergence then boots
# out and removes the owned broker while rewriting Agentbrain; only after that
# call returns may the command wrappers and receipt disappear.
# shellcheck disable=SC2016 # Match the literal helper invocation in install.sh.
launchagents_line=$(grep -n '^"$script_dir/install-launchagents" --install$' scripts/install.sh | cut -d: -f1)
# shellcheck disable=SC2016 # Match the literal helper invocation in install.sh.
retired_agentweb_line=$(grep -n '^"$script_dir/remove-retired-agentweb" --install$' scripts/install.sh | cut -d: -f1)
[ -n "$launchagents_line" ] && [ -n "$retired_agentweb_line" ] \
    && [ "$launchagents_line" -gt "$agent_clis_line" ] \
    && [ "$retired_agentweb_line" -gt "$launchagents_line" ] \
    || fail "Agentweb retirement does not preserve CLI, service, then command-cleanup order"
# shellcheck disable=SC2016 # Match the literal helper invocation in check mode.
launchagents_check_line=$(grep -n '^    "$script_dir/install-launchagents" --check$' scripts/install.sh | cut -d: -f1)
# shellcheck disable=SC2016 # Match the literal helper invocation in check mode.
retired_agentweb_check_line=$(grep -n '^    "$script_dir/remove-retired-agentweb" --check$' scripts/install.sh | cut -d: -f1)
[ -n "$launchagents_check_line" ] && [ -n "$retired_agentweb_check_line" ] \
    && [ "$retired_agentweb_check_line" -gt "$launchagents_check_line" ] \
    || fail "check mode does not report Agentweb service retirement before command cleanup"
if grep -F 'remove-retired-agentweb' scripts/remove-retired-integrations >/dev/null; then
    fail "Agentweb command cleanup runs in the early retired-integrations phase"
fi
# shellcheck disable=SC2016 # Match the literal helper invocation in the script.
grep -F '"$script_dir/remove-retired-integrations"' scripts/install.sh >/dev/null \
    || fail "installer does not run retired integration cleanup"
# shellcheck disable=SC2016 # Match the literal status variable in the script.
grep -F 'exit "$retired_integrations_status"' scripts/install.sh >/dev/null \
    || fail "installer does not propagate retired integration cleanup failures"
grep -F 'skills remove --global --yes' scripts/install.sh >/dev/null \
    || fail "full installer does not remove retired global skills"
if grep -F 'skills remove' scripts/sync-skills >/dev/null; then
    fail "sync-skills removes skills on the unattended path"
fi
grep -F 'remove_retired_core_plugin' scripts/install.sh >/dev/null \
    || fail "full installer does not retire the old core plugin"
if grep -Eq 'plugin (uninstall|remove)|plugin marketplace remove' scripts/render-capabilities; then
    fail "render-capabilities uninstalls plugins on the unattended path"
fi
if grep -Eq 'rm -- .*herdr-agent-state|unlink .*herdr-agent-state' scripts/render-capabilities; then
    fail "render-capabilities removes Pi resources on the unattended path"
fi
# shellcheck disable=SC2016 # Match literal generated-manifest variables.
grep -F 'mv -f -- "$manifest.next" "$manifest"' scripts/render-capabilities >/dev/null \
    || fail "render-capabilities may prompt before replacing an immutable generated manifest"
grep -F 'remove_packed_pi_ambient_resources' scripts/install.sh >/dev/null \
    || fail "full installer does not retire Pi resources after packing them"
# The list spans two lines, so the order is checked on the joined text rather
# than by matching one literal line. agentusage must precede agentlaunch (the
# launcher shells its balance contract), and codex-swap must precede agentusage
# so balance observes the command owner codex-swap itself installed.
agent_cli_order=$(tr '\n' ' ' <scripts/install-agent-clis | tr -s ' ')
case "$agent_cli_order" in
    *"for tool in agentwiki agentboard agentbrowse-infra agentbrowse agentattention agenteditor agentsearch agentkeys agentsource agentscrape \\ agentbrain codex-swap agentusage agentlaunch agentsurface"*) ;;
    *) fail "agent CLI installer changed its tool list or ordering" ;;
esac
# Every checkout with an installer is in the loop; a name missing from it is a
# tool nothing installs.
for expected_tool in agentwiki agentboard agentbrowse-infra agentbrowse agentattention agenteditor agentsearch agentkeys agentsource \
    agentscrape agentbrain codex-swap agentusage agentlaunch agentsurface; do
    case "$agent_cli_order" in
        *" $expected_tool "*) ;;
        *) fail "agent CLI loop no longer installs $expected_tool" ;;
    esac
done
case "$agent_cli_order" in
    *" agentbus "*) fail "agent CLI loop still installs retired agentbus" ;;
    *" agentweb "*) fail "agent CLI loop still installs retired agentweb" ;;
esac
# shellcheck disable=SC2016 # Match the literal checkout resolution in the script.
grep -F 'agentchats_root="$code_root/agentchats"' scripts/install.sh >/dev/null \
    || fail "installer does not own the cass installation call"
# shellcheck disable=SC2016 # Match the literal checkout resolution in the script.
grep -F 'agentdesk_root="$code_root/agentdesk"' scripts/install.sh >/dev/null \
    || fail "installer does not own the peekaboo installation call"
# One fleet root, honoured by every script that walks it. A script resolving
# $HOME/code directly cannot be pointed at a fixture tree, and one resolving it
# relative to its own location would silently skip the whole fleet on a worktree
# run — the checkouts are found where the machine keeps them, not beside $0.
for fleet_walker in scripts/install.sh scripts/install-agent-clis \
    scripts/install-agentvoice-cli scripts/remove-retired-integrations \
    scripts/sync-skills; do
    # shellcheck disable=SC2016 # Match the literal knob in each script.
    grep -F 'code_root="${AGENTSTART_CODE_ROOT:-$HOME/code}"' "$fleet_walker" >/dev/null \
        || fail "$fleet_walker does not resolve the fleet root through AGENTSTART_CODE_ROOT"
    # shellcheck disable=SC2016 # A bare $HOME/code path bypasses the knob.
    if grep -n '\$HOME/code' "$fleet_walker" | grep -vF 'AGENTSTART_CODE_ROOT' >/dev/null; then
        fail "$fleet_walker still resolves \$HOME/code directly instead of through code_root"
    fi
done
# shellcheck disable=SC2016 # Match the literal invocation in the script.
grep -F '"$agentchats_root/scripts/install.sh" --install' scripts/install.sh >/dev/null \
    || fail "installer does not invoke the agentchats contract"
# shellcheck disable=SC2016 # Match the literal invocation in the script.
grep -F '"$agentdesk_root/scripts/install.sh" --install' scripts/install.sh >/dev/null \
    || fail "installer does not invoke the agentdesk contract"

# The ownership boundary, from this side: nothing here may install a desktop
# cask, migrate gh credentials, or grow launchd machinery — those are the
# machine's.
if grep -Eq -- '--cask' scripts/install.sh scripts/sync-skills; then
    fail "an AgentStart script crossed the boundary: casks are the machine's"
fi
if grep -F 'oauth_token' scripts/install.sh >/dev/null; then
    fail "an AgentStart script crossed the boundary: gh migration is the machine's"
fi
# launchd is split rather than wholly the machine's: a bare <tool>.<service>
# label is a fleet service and this repository owns it; a reverse-DNS label is
# the machine's. The boundary that remains is the naming, so
# what is tested is that nothing here installs a machine-shaped service.
if grep -Eq '<string>(com|org|net)\.' config/launchd/*.plist; then
    fail "an AgentStart launch agent used a reverse-DNS label: machine services are not ours"
fi
# The updater path stays unattended-safe: sync-skills runs every six hours with
# no sudo and no service restarts, so it must never reach launchd.
if grep -Eq 'launchctl|\.plist' scripts/sync-skills; then
    fail "sync-skills must stay unattended-safe: launchd restarts do not belong there"
fi

# --- the fleet launch agents -------------------------------------------------

[ -x scripts/install-launchagents ] || fail "the launch agent installer is not executable"
# shellcheck disable=SC2016 # Match the literal helper invocation in the script.
grep -F '"$script_dir/install-launchagents" --install' scripts/install.sh >/dev/null \
    || fail "installer does not converge the fleet launch agents"
# shellcheck disable=SC2016 # Match the literal helper invocation in the script.
grep -F '"$script_dir/install-launchagents" --check' scripts/install.sh >/dev/null \
    || fail "installation plan omits the fleet launch agents"
# shellcheck disable=SC2016 # Match the literal non-mutating diagnostic invocation.
grep -F '"$script_dir/configure-agentsource-webhooks" --check || true' scripts/install.sh >/dev/null \
    || fail "ordinary install does not emit agent guidance for incomplete webhook wiring"
if rg -n 'agentbus\.(daemon|codex-appserver)' scripts/install-launchagents \
    config/launchd tests/validate.sh >/dev/null; then
    fail "retired AgentBus launch agents remain in the fleet service contract"
fi
[ ! -e config/launchd/agentweb.broker.plist ] \
    || fail "retired Agentweb broker template still exists"
if rg -n 'AGENTSCRAPE_CONDUIT|__CONDUIT_|agentweb_state' \
    scripts/install-launchagents config/launchd >/dev/null; then
    fail "retired Agentweb conduit wiring remains in the launch agent contract"
fi
grep -Fq "local label=agentweb.broker" scripts/install-launchagents \
    || fail "launch agent installer does not retire the canonical Agentweb broker label"
grep -Fq "agentstart-installer-owned: agentweb.broker.v1" scripts/install-launchagents \
    || fail "retired broker cleanup does not require the exact ownership marker"

expected_services='agentbrain.worker|agentbrain|worker.log|resident
agentbrain.share|agentbrain|share.log|resident
agentbrain.doctor|agentbrain|doctor.log|periodic
agentusage.observer|agentusage|observer.log|resident
agentattention.server|agentattention|server.log|resident
agentscrape.queue-processor|agentscrape|queue-processor.log|queue-triggered
agentsource.receiver|agentsource|receiver.log|resident
agentwiki.server|agentwiki|server.log|resident'
for entry in $expected_services; do
    grep -Fq "\"$entry\"" scripts/install-launchagents \
        || fail "launch agent manifest omits canonical entry: $entry"
done
for legacy_binary in agentusaged agentwebd; do
    if sed -n '/^SERVICES=(/,/^)/p' scripts/install-launchagents | grep -Fq "$legacy_binary"; then
        fail "launch agent manifest still runs legacy daemon binary: $legacy_binary"
    fi
done

for template in config/launchd/*.plist; do
    label=$(basename "$template" .plist)
    # The marker is what lets the installer tell its own service from a
    # stranger's, so a template whose marker does not match its own file name
    # would either be refused forever or adopt something it should not.
    grep -Fq "agentstart-installer-owned: $label.v1" "$template" \
        || fail "template is missing or misnaming its ownership marker: $template"
    grep -Fq "<string>$label</string>" "$template" \
        || fail "template Label does not match its file name: $template"
    # Every value is rendered from the manifest; a per-tool token is a leftover
    # from the checkout this service was migrated out of.
    if grep -Eq '__[A-Z]+_(PROGRAM|HOME|PATH|LOG)__' "$template"; then
        fail "template still carries a per-tool token: $template"
    fi
    for required in '<key>Umask</key>' \
        '<key>StandardOutPath</key>' '<key>StandardErrorPath</key>'; do
        grep -Fq "$required" "$template" \
            || fail "template omits $required: $template"
    done
    # Correct at login, by one route or the other: started outright, or started
    # by launchd because the directory it watches is not empty.
    if ! grep -Eq '<key>(RunAtLoad|QueueDirectories)</key>' "$template"; then
        fail "template declares neither RunAtLoad nor QueueDirectories: $template"
    fi
    grep -Fq '<string>__LOG__</string>' "$template" \
        || fail "template does not log through the standard token: $template"
    # A service is either resident or periodic; one of the two must say so.
    if ! grep -Eq '<key>(KeepAlive|StartInterval)</key>' "$template"; then
        fail "template declares neither KeepAlive nor StartInterval: $template"
    fi
    if command -v plutil >/dev/null 2>&1; then
        plutil -lint "$template" >/dev/null || fail "template is not a valid plist: $template"
    fi
    grep -Fq "\"$label|" scripts/install-launchagents \
        || fail "template has no manifest entry: $template"
done

# And the reverse, so a manifest entry can never name a template that is not here.
# The service half of a label may be hyphenated (queue-processor),
# so both halves match hyphens too — a character class that stopped at [a-z] read
# straight past those entries and checked nothing.
while IFS= read -r label; do
    [ -f "config/launchd/$label.plist" ] \
        || fail "manifest names a service with no template: $label"
done < <(sed -n 's/^ *"\([a-z-]*\.[a-z-]*\)|.*/\1/p' scripts/install-launchagents)

grep -Fq '<string>webhook-daemon</string>' config/launchd/agentsource.receiver.plist \
    || fail "Agentsource receiver does not enter through the installed webhook-daemon subcommand"
grep -Fq '<string>serve</string>' config/launchd/agentattention.server.plist \
    || fail "Agentattention server does not enter through the installed serve subcommand"
if grep -Eq '<key>[^<]*(TOKEN|SECRET)[^<]*</key>' config/launchd/agentattention.server.plist; then
    fail "Agentattention server rendered a credential-shaped environment variable"
fi
grep -Fq '<string>__SECRET_FILE__</string>' config/launchd/agentsource.receiver.plist \
    || fail "Agentsource receiver does not name the private secret by path"
grep -A1 -F '<string>--port</string>' config/launchd/agentsource.receiver.plist \
    | grep -Fq '<string>8787</string>' \
    || fail "Agentsource receiver does not pin its Funnel-coupled HTTP port"
if grep -Eq '<key>[^<]*SECRET[^<]*</key>' config/launchd/agentsource.receiver.plist; then
    fail "Agentsource receiver rendered a credential-shaped environment variable"
fi

printf 'ok\n'
