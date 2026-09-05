# 0015: Retain the foreground controller, replace the voice runtime

Accepted 2026-09-05. Supersedes ADR 0009's single-process topology while
preserving its foreground, workspace, permission, and owned-child policies.

AgentVoice now has two foreground processes. The retained controller owns the
terminal UI, selected canonical workspace and exact thread identity, thread
leases, operation journal, Unix socket, and loopback MCP host. A disposable
runtime child owns all reloadable application state: config/prompt/role reads,
native audio library and devices, WebRTC, `VoiceRuntime`, and the owned Codex
app-server child. The controller does not import audio/WebRTC/runtime modules;
RTP and PCM never cross its IPC boundary.

The controller starts a candidate Bun runtime and asks it to validate the pinned
launch inputs before it changes a live call. It fingerprints reloadable source
and native artifacts before and after preflight, refusing a build that changes
during that window. Once committed, the controller mutes/cancels input, drains
the old runtime, and starts the candidate with the exact controller-held thread
ID. The candidate validates it with `thread/read` and then uses `thread/resume`;
it never runs ordinary history inventory during a restart. A native-verified,
leased thread ID is published before MCP readiness, so an initial readiness
failure also retries that exact ID. If a newly created thread was not persisted
before native exit, its exact resume can fail; AgentVoice does not invent history
or fall back to Fresh. The controller and
TUI remain alive on startup or replacement failure, with a visible failed state.
Both media gates stay muted through activation; the controller enables media
with its latest mute preferences only after the replacement connects.

Runtime shutdown closes native stdin and allows 15 seconds for EOF drain, then
uses 2-second TERM and KILL windows. The worker parent watchdog allows 24 seconds
for runtime shutdown, with bounded worker and captured-descendant TERM/KILL
cleanup afterward. Both owners snapshot descendant ancestry and kernel process
birth identities, including detached process sessions, and revalidate identity
before signaling. A replacement fails if captured survivors cannot be verified
gone. A descendant that becomes orphaned entirely between ownership samples
cannot be discovered safely after abrupt parent death; cleanup is not an
unconditional promise about unobserved processes. Native live turns and tool
execution do not survive replacement. A controller restart
is not exposed: it is ordinary quit/relaunch.

The controller exposes versioned private NDJSON over a `0600` Unix socket and a
bearer-authenticated loopback Streamable HTTP MCP projection. Both invoke the
same schema/dispatch path. `agentvoice_control` is injected after raw per-thread
config on every start, resume, and Fresh; user/role collisions fail before audio.
The installed Codex 0.153.4 contract was verified in isolated probes: the
required MCP server must become connected with the exact catalog before audio
opens. The bearer remains only in the owned child environment, never in a
native configuration dump.

Mutation operations are journaled and fsynced before accepted results. A
controller lifetime accepts at most 256 operation IDs and reports the latest 16
plus the current operation. Duplicate immutable requests return their existing
operation; a conflicting reuse fails. Acceptance returns before a short async
grace, and may not be persisted by the initiating native tool before it dies.
Status after exact-thread resume is therefore the completion/recovery path. The
journal is not adopted after full quit/relaunch.

Redial remains the narrow voice/WebRTC recovery action. Full runtime restart
reloads configuration/prompt/role snapshots, native code, audio/WebRTC, and the
Codex child beneath the retained UI; it does not offer audio-only, Codex-only,
arbitrary-PID, arbitrary-thread, or mailbox controls. Native role skills,
`mcp.json`, prompts, and config are still native/runtime initialization inputs;
they do not hot-reload within a live runtime.
