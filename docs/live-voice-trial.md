# Live workspace-role voice trial

Run after the role-database changes are merged into local `main`. This trial
creates a private, dedicated workspace and role database, then starts a fresh
foreground server from that checkout. The client opens audio and a native Codex
call. Keep the working-agent pane visible and stop at the first failed check.

## 1. Prepare and start the server (terminal 1)

Paste this entire block. It captures the usual config, the checkout's default
role, and an explicit initial Cove selection. Ejection errors stop the block.
The database and recordings remain available afterward for investigation.
The block runs in noninteractive Bash so interactive shell directory-change
hooks cannot interrupt setup when strict variable checking is enabled.
Generated role files use a private cache inside the trial workspace. This keeps
the trial independent of shared or symlinked cache locations such as an external
Scratch volume; it does not change your global cache configuration.
The server uses the resolved stock Codex binary installed at `~/.local/bin/codex`.
Bare `codex` can resolve to an AgentLaunch shim on an interactive shell's PATH;
that shim treats attachment `resume --remote` as a new managed launch and injects
its own settings. Both the owned app-server and attached TUI must use stock Codex.

```sh
env -u BASH_ENV /bin/bash --noprofile --norc <<'AGENTVOICE_TRIAL'
  set -eu
  cd /Users/arthack/code/agentvoice
  bun -e 'import { CONTROL_PROTOCOL_VERSION as v } from "./src/control/types.ts"; if (v !== 5) throw new Error(`Expected control API 5, found ${v}`); console.log("Checkout control API: 5");'
  trial_codex="$(bun -e 'import { realpathSync } from "node:fs"; import { homedir } from "node:os"; console.log(realpathSync(`${homedir()}/.local/bin/codex`));')"
  printf 'Stock Codex: %s\n' "$trial_codex"
  "$trial_codex" --version
  trial_parent="${XDG_STATE_HOME:-$HOME/.local/state}/agentvoice"
  mkdir -p "$trial_parent"
  trial_workspace="$(mktemp -d "$trial_parent/voice-trial.XXXXXX")"
  export XDG_CACHE_HOME="$trial_workspace/cache"
  bun run src/main.ts role eject --workspace "$trial_workspace" \
    --role "$PWD/roles/default" --voice cove
  bun run src/main.ts role status --workspace "$trial_workspace"
  printf '\nWORKSPACE: %s\n\nRun this exact command in terminal 2:\n' "$trial_workspace"
  printf 'bun run %q --workspace %q\n\n' "$PWD/src/main.ts" "$trial_workspace"
  exec bun run src/main.ts server --workspace "$trial_workspace" --codex "$trial_codex"
AGENTVOICE_TRIAL
```

Expected saved state: revision `1`, `savedVoice: "cove"`. Keep terminal 1
running. Copy its printed client command into terminal 2 and run it. The explicit
workspace connects that client to this foreground server. Reuse the same printed
command whenever the instructions say to reopen the client.

Run the client directly in terminal 2. Do not wrap it in macOS `/usr/bin/script`:
our trial and an isolated fake-call reproduction both retained the original
82×26 inner PTY after the outer terminal grew to 137×40. The live controls also
became unreliable; synchronizing the inner size restored normal interaction.
The direct launch resized correctly in the isolated test. Use the saved voice
and native transcripts for the audit; terminal recording must not break resize
propagation.

## 2. Try ordinary voice requests

Say each line separately and wait for the response before continuing. Use your
own wording if you prefer. Do not name tools, supply API arguments, or coach the
agent through a failed request: choosing how to do it is part of the test.

> Hi. Say something so I can hear your voice.

> Change your voice to maple.

> Tell me a short joke.

> Change your voice to cove.

> Tell me another short joke.

Listen for the changes. The working-agent pane should stay connected, and the
conversation should continue normally. A spoken claim that the voice changed
is not enough; note what you actually heard. This setup starts with Cove, so
switching to Maple first makes the later Cove request a real change.

## 3. Check that it remembers the choice

Close terminal 2's client/composition, leaving terminal 1's server running.
Run the same client command again to open a new call in the same workspace.

> What voice are you using? Tell me a short joke.

It should still use Cove. This is a new conversation; it does not need to
remember the previous jokes.

## 4. Optional: save a choice for later

If the basic trial worked, say:

> Use sol next time we talk, but keep your current voice for now.

> Tell me another short joke.

It should still sound like Cove. Close and reopen the client as above, then say:

> What voice are you using? Tell me a short joke.

It should now use Sol.

## If something goes wrong

Stop at the first failure and note the step, approximate time, and what you
heard or saw. Avoid repairing the request with tool names or detailed technical
instructions; preserve the initial failure for review. Close the client if
needed. When finished, stop the trial server with Ctrl-C in terminal 1. Keep the
workspace and database for the audit.

## Audit afterward (not spoken instructions)

Review the saved voice conversation and native tool transcript to establish
whether ordinary requests reached the correct operation without coaching.
Check protocol 5 and the bound workspace; successful voice-only changes should
advance saved/applied voice revisions while preserving the working child,
thread, runtime generation and attachment. A deferred change should advance
only saved state until the next call loads it. Distinguish acceptance, completed
application, unknown outcomes and the operator's listening observations.

Also review unnecessary delegation, latency, repeated confirmations, guessed
commands/endpoints, credential exposure, and claims unsupported by tool results.
Keep these checks out of the spoken trial so they do not supply the behavior
being tested. This trial does not change the role's system prompt.
