# 0052: Persist one current session in each workspace

Accepted 2026-09-13 at the operator's request. Supersedes the fresh-launch and
history-selection policy in [0020](0020-native-launch-defaults.md), the removal
of in-call session switching in [0024](0024-server-and-pointer-frontend.md), and
the attachment-exit behavior during runtime replacement in
[0028](0028-foreground-composition.md). Other lifecycle boundaries remain.

## Decision

Each canonical workspace owns `.agentvoice-session`: a private regular file
containing one native Codex main-thread ID and a newline. Every new call resumes
that exact ID after native ownership validation. Missing files create a new
thread; invalid or unavailable history fails visibly without selecting another.
There is no latest-history inventory or separate global session index. Native
Codex owns history. `--continue`, `--resume`, `--fresh` and `--no-continue` are
retired with actionable errors; explicit marker editing is the selection surface.

Workspace leases serialize calls before thread creation, and existing thread
leases still protect native identity. A new thread is saved before readiness
with exclusive atomic publication and fsync. An intervening marker creation is
never overwritten. Ephemeral native threads are rejected at preflight because
they cannot satisfy continuation. Changing native homes may make the saved ID
unavailable; AgentVoice does not migrate native state or hide that failure.

Deleting the marker selects a new thread on the next call. An active call keeps
its retained identity, including through ordinary runtime restart, and does not
recreate a manually deleted marker merely by resuming.

Control protocol 6 adds `agentvoice.new_session` and MCP `agentvoice_new_session`.
The operation uses the existing instance/generation fences and durable operation
IDs. After successful preflight it drains the owned runtime, verifies the marker
has not changed, removes it, clears the old mailbox and current identity, and
activates a runtime which creates and saves a new thread. The frontend remains
connected and voice reconnects with current mute preferences. Native work is
interrupted; native history and workspace content remain. Old leases last until
call shutdown, and read access uses only the current root. No speech replay,
summary, handoff prompt or automatic working-agent turn is introduced.

Preflight and cleanup failures preserve the marker. Failures after removal leave
the call failed with either no marker or the newly created thread's marker;
an explicit runtime retry uses that state. Repeating the same new-session
operation ID returns its recorded outcome and cannot wipe a successor again.

The voice-owning terminal composition observes the runtime generation. During
replacement it tolerates old attachment exits and reopens both pane apps against
the new exact identity once voice is live, using smolmux `app.restart`. A bounded
observation refresh handles attachment exit arriving before its generation event.
Client exit, call/observer loss and ordinary attachment exit still end the
composition. Input is never replayed. The independent desktop attachment view
still requires an explicit rerun. Voice recording closes the old thread's writer
and opens a separate transcript at verified new identity.

## Verification and adoption

Fake protocol/media tests cover exact continuation across new child/controller
processes, new-session idempotency and preflight failures, marker deletion and
concurrent publication, ownership checks, transcript separation and pane
replacement. These establish lifecycle and storage behavior, not audible output.
An existing live thread may be adopted only from an explicitly selected and
verified call. Saving that marker does not interrupt the live call. Installation
still requires the default frontend to be idle and the service window coordinated.
