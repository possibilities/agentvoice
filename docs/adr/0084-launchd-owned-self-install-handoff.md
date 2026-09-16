# 0084: Hand self-hosted installation to launchd

Accepted September 15, 2026 after a full installer launched from the managed
AgentVoice conversation unloaded the default server and killed the installer
before it could publish the staged runtime or bootstrap the replacement. Extends
[0082](0082-kernel-owned-service-operation-lock.md) and preserves the explicit
full-install and service-restart consequences in
[0065](0065-native-menu-server-lifecycle.md).

## Decision

When a full installer proves from one kernel process snapshot that its process is
a descendant of the currently loaded default LaunchAgent, it does not begin the
install. It writes a private, versioned request and asks launchd to submit a
separate randomly named helper job. The helper validates the exact request path,
owner, modes, operation identity, fixed default-service label, executable,
entrypoint and bounded launch environment. It records acceptance before waiting
for the initiating process's exact PID/birth identity to disappear, then reruns
the complete installer. That external job owns the installer file lock for the
whole build/publication transaction and the service file lock for its lifecycle
subtransaction. Its later `bootout` of the server cannot terminate the helper.

A self-hosted `agentvoice service restart` uses the same external boundary but
acquires the installer lock before the service lock and performs only the service
transaction. Calls from the native menu, a terminal, or any other process outside
the managed server continue synchronously. The menu app is not a broker: it may
be absent, intentionally quit for its own update, or replaced by the same full
installer, so it cannot own reliable server recovery.

This does not change the MCP `agentvoice_control` restart boundary. That operation
replaces the disposable conversation runtime while its server controller remains
alive. A full service restart or installer replaces the controller itself and
therefore requires this independent launchd owner; it does not promise to resume
the interrupted call or agent turn.

The helper keeps a private request, log and atomic status receipt with accepted,
running, succeeded or failed state. The submitted job is launchd-owned and
KeepAlive; if it dies after unload, its next invocation reopens the same request.
Install and service mutations are convergent, and a terminal receipt prevents a
completed operation from running again. The helper removes its own submitted job
only after writing a terminal receipt. Acceptance is a durable handoff, not proof
that publication has completed; the receipt is the recovery and diagnosis path.

Replace the installer's mkdir lock with the same retained mode-0600 kernel `flock`
used for service operations. A killed installer therefore releases ownership
without deleting or replacing the inode. Preserve a historical directory at that
path as an explicit legacy condition requiring inspection; never infer that it is
stale. While holding the service lock, validate only exact
`.runtime-stage-XXXXXX` owned, non-writable trees. A validated `previous` runtime
is restored when the active path is absent; a validated active runtime wins when
publication already finished, even if its obsolete backup was only partly
removed. Candidate-only debris is removed. Multiple backups, symlinks,
hard-linked files, foreign owners, or group/other writable permissions fail
closed and remain for inspection.

## Failure and verification boundary

Submitting the helper must reach an accepted receipt within a bound. A timeout
first boots out the submitted helper; cancellation failure is an unknown outcome
with the exact receipt path, never permission to start a second helper. Concurrent
installers and service actions still fail visibly through nonblocking locks.
Request files do not carry unrelated environment variables, credentials, or
arbitrary service labels.

Tests prove that the full installer remains idle until an independently owned
helper accepts and the initiator exits; killing that helper after fake bootout and
before fake bootstrap leaves a resumable running receipt, releases both kernel
locks, and a second invocation restores the loaded job. Installer tests prove
SIGKILL releases the retained installer lock. Runtime-stage tests remove a
validated partial tree and preserve a redirected tree. These fixtures never touch
the live LaunchAgent, menu app, phone, audio, or Codex service.
