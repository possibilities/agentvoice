# Live workspace-role voice trial

Run after the role-database changes are merged into local `main`. This trial
creates a private, dedicated workspace and role database, then starts a fresh
foreground server from that checkout. The client opens audio and a native Codex
call. Keep the working-agent pane visible and stop at the first failed check.

## 1. Prepare and start the server (terminal 1)

Paste this entire block. It captures the usual config, the checkout's default
role, and an explicit initial Cove selection. Ejection errors stop the block.
The database and recordings remain available afterward for investigation.

```sh
(
  set -eu
  cd /Users/arthack/code/agentvoice
  bun -e 'import { CONTROL_PROTOCOL_VERSION as v } from "./src/control/types.ts"; if (v !== 5) throw new Error(`Expected control API 5, found ${v}`); console.log("Checkout control API: 5");'
  trial_parent="${XDG_STATE_HOME:-$HOME/.local/state}/agentvoice"
  mkdir -p "$trial_parent"
  trial_workspace="$(mktemp -d "$trial_parent/voice-trial.XXXXXX")"
  bun run src/main.ts role eject --workspace "$trial_workspace" \
    --role "$PWD/roles/default" --voice cove
  bun run src/main.ts role status --workspace "$trial_workspace"
  printf '\nWORKSPACE: %s\n\nRun this exact command in terminal 2:\n' "$trial_workspace"
  printf 'bun run %q --workspace %q\n\n' "$PWD/src/main.ts" "$trial_workspace"
  exec bun run src/main.ts server --workspace "$trial_workspace"
)
```

Expected saved state: revision `1`, `savedVoice: "cove"`. Keep terminal 1
running. Copy its printed client command into terminal 2 and run it. The explicit
workspace connects that client to this foreground server. Reuse the same printed
command whenever the instructions say to reopen the client.

## 2. Establish the live baseline

Say:

> This is a voice-setting test. Use the AgentVoice MCP tools, starting with
> agentvoice_status. Discover the actual tool if necessary. Do not substitute a
> CLI command or guess an HTTP endpoint. Show the exact status fields in the
> working-agent pane and give me a short spoken summary. Check protocolVersion
> is 5, role.loaded and role.desired exist, role.error is absent, and the voice
> session is live. Record workspace, instanceId, threadId, runtime.pid,
> generation, role.loaded.revision, role.desired.revision, role.voiceRevision,
> role.voice, and role.desiredVoice. The two voice names should be cove. Verify
> agentvoice_voice_set is available. Stop the test if any check fails. Live is
> a connection phase, not a voice name. Do not read the UUIDs aloud.

Expect the printed workspace, revision `1` in all three revision fields, and
Cove in both voice-name fields. An absent value is unknown, never a reason to
invent a value. Do not continue without this baseline.

Say:

> Say exactly: The sunlight falls across the quiet garden.

Listen to the baseline voice before proceeding.

## 3. Apply Maple now

Say:

> Use fresh agentvoice_status, then agentvoice_voice_set to set voice maple with
> apply voice. Use a new operationId and copy expectedInstanceId,
> expectedGeneration, and expectedRoleRevision from that status; the revision
> comes from role.desired.revision. Submit the change once. Check that operation
> in status until its voiceEdit.application is applied, or stop on failed,
> unknown, or a thirty-second timeout. Acceptance alone is not completion.
> Verify role.voice and role.desiredVoice are maple and role.voiceRevision
> equals the saved revision. Verify the workspace, instanceId, threadId,
> runtime.pid, and generation match the baseline. Show the result in the pane.

Expect `role.loaded.revision` to remain `1`; the saved and voice revisions
advance together. The working-agent attachment should remain connected.

After it reports applied, say:

> Say exactly: The sunlight falls across the quiet garden.

Confirm whether Maple sounds different. Application status confirms live media;
only your listening check establishes what you heard.

## 4. Save Sol for the next call

Say:

> Use fresh status and a new operationId to set voice sol with apply next-session.
> Use the current instance, generation, and desired role revision. Submit once.
> Verify voiceEdit.application is deferred, role.desiredVoice is sol, and
> role.voice remains maple. The saved revision should advance, while
> role.voiceRevision and role.loaded.revision stay unchanged. Verify the baseline
> workspace, instance, thread, runtime PID, and generation are unchanged.

Then ask for the same garden sentence. It should still sound like Maple, with
no voice reconnect caused by this save.

## 5. Verify persistence across calls

Close terminal 2's client/composition, leaving terminal 1's server running.
Run the exact same printed client command again. It opens a new call in the
same trial workspace.

Say:

> Use agentvoice_status and report the database role's saved and loaded
> revisions and voice names. Check protocolVersion is 5, the workspace is the
> same trial workspace, and role.voice and role.desiredVoice are sol. The loaded,
> desired, and voice revisions should now agree. Show the exact values in the
> working-agent pane, then say: The sunlight falls across the quiet garden.

A new instance, thread, and PID are expected for this new call. Its generation
can start at `1` again. Confirm that you hear Sol.

## Stop and preserve evidence

On the first failure, say:

> Stop the trial. Do not change settings, retry the mutation, redial, restart,
> export MCP credentials, or guess endpoints. Read agentvoice_status once if
> available, show the exact result and operationId in the pane, and distinguish
> saved state, applied state, and anything unknown.

Record what you heard and the approximate time. Close the client when finished,
then press Ctrl-C in terminal 1 to stop the trial server. Keep the trial workspace
and database for the audit. Report the printed workspace and the failed step;
AgentVoice's saved voice transcript and native tool transcript provide the rest.
