# AgentVoice control API

Control protocol **9** provides new session, status, voice redial and runtime restart with an
optional handoff prompt, plus persistent workspace voice selection. MCP and Unix control use the same schemas and dispatcher.
The server-owned controller retains exact conversation identity, operation journal
and control/event endpoints across runtime replacements and frontend detach. A
frontend owns only its media attachment; closing it stops realtime voice and
leaves native work and these endpoints available until server shutdown.

Versions 1–5 Unix frames are rejected. Rediscover endpoints for each new server
workspace session, not for each frontend attachment.
The retired `agentvoice.routing_context` method is unknown and its former MCP
tool is absent; saved native routing outputs remain readable in transcript history.
Runtime restart reloads runtime code and settings; it cannot upgrade the retained
controller API. Restart the server process to load changed controller code.
The frontend, event and native voice protocols are separate contracts.

## Discovery and authorization

The controller starts the private Unix socket and loopback MCP endpoint before
it starts a voice runtime. The socket path is under the controller's private
state directory, in a `control/` directory with mode `0700`; its socket mode
is `0600`. A live controller owns an exclusive lock while it probes stale
residue and binds, so a second launch cannot take over a live instance. The
owned Codex child receives the exact path in `AGENTVOICE_CONTROL_SOCKET`; this
is its inherited Unix-socket discovery mechanism.

Every controller instance has a different loopback URL and a random bearer
capability. MCP requests must send `Authorization: Bearer <capability>`. The
capability is supplied to the owned Codex child only in the per-instance
environment variable named by `bearer_token_env_var`; it is never written to
the native MCP configuration or printed in diagnostics.

For an explicitly requested external-client connection,
`agentvoice mcp-config [--workspace <dir>] [--thread <exact-id>]` reads controller-owned discovery
records under `$XDG_STATE_HOME/agentvoice/control/instances/` (or the default
state location). The directory is mode `0700`; each descriptor is an atomically
published mode `0600` regular file containing only immutable version, controller
identity/PID, socket path, loopback URL, and bearer capability. Normal shutdown
removes the owned descriptor. Readers reject unsafe directories, files, links,
and sockets, bound directory entry count and file sizes, and probe all candidate sockets within
a fixed deadline. A well-permissioned malformed record or stale crash record is
ignored and never deleted by the reader.

Selection never trusts workspace or thread data in a descriptor. It calls
`agentvoice.status` on each live Unix socket, verifies that the returned instance
identity matches the descriptor, then matches the current canonical workspace
and optional exact thread. This remains available
when the runtime phase is `failed`. Zero matches and ambiguity fail rather than
selecting the newest record. Successful output is the fleet-standard
`mcpServers` JSON with an `Authorization: Bearer …` header for Claude Code and
MCP Inspector. The JSON is an explicit capability export for the current
controller lifetime; Codex's native MCP configuration uses a different shape.

AgentVoice registers this MCP server for each orchestration thread as
`agentvoice_control`. Its native configuration has `required: true`,
`enabled_tools` set to the six tool names below, `startup_timeout_sec: 5`,
`tool_timeout_sec: 5`, and a
`bearer_token_env_var`. Registration is not readiness: the controller/runtime
also checks the native MCP catalog for a connected server and the exact tool
set before it reports the bridge ready.

## Private host gateway bootstrap

The web Agent composer and explicit speech helper reuse live Unix status discovery,
then send an authenticated `POST /tui/attach` to the controller's loopback HTTP
host with `{instanceId, generation, threadId, workspace}`. The historical path is
a private host-side bootstrap endpoint, not an MCP tool, Unix operation or browser
API. It accepts no Origin and requires the exact Host and controller bearer.

The controller must still match the exact target before and after its private
runtime request. The result contains only the selected thread/workspace, gateway
URL and a 30-second bearer ticket, with `Cache-Control: no-store`. The owned native
app-server token and executable path never leave the runtime.

Each ticket admits one watcher/client pair, with at most eight grants per runtime.
Frames are capped at 4 MiB, pending requests at 64, and request timeouts at 30
seconds. After initialization, the allowlist contains only exact-root `turn/start`,
`turn/steer`, `turn/interrupt`, and `thread/realtime/appendSpeech`. Reads, settings,
descendant navigation, client answers to native questions and arbitrary methods are
rejected before native dispatch. Runtime restart and server shutdown revoke grants;
frontend detach and redial preserve the gateway. See
[web Agent input](web-agent-input.md) and [ADR 0072](adr/0072-retire-terminal-composition-and-attachments.md).

## Unix socket transport

The socket is newline-delimited JSON (NDJSON). A request is one UTF-8 line;
responses may finish out of order and retain the caller-selected `id`.

```json
{"v":9,"type":"request","id":"status-1","method":"agentvoice.status","params":{}}
```

```json
{"v":9,"type":"response","id":"status-1","ok":true,"result":{"protocolVersion":9,"instanceId":"…","workspace":"/work","threadId":"…","generation":7,"runtime":{"phase":"ready"},"recentOperations":[]}}
```

`v` must be `9`; `type` must be `request`; `id` is a nonempty string of at
most 128 characters. Unknown envelope fields are rejected. Input frames are
capped at 1 MiB, a connection may have at most 128 requests in flight, and
unwritten response data is capped at 4 MiB. A slow peer is disconnected.

Failure responses retain the request `id` where it can be recovered:

```json
{"v":9,"type":"response","id":"restart-17","ok":false,"error":{"code":"stale_generation","message":"controller generation changed"}}
```

Error codes are `invalid_request`, `invalid_params`, `unknown_method`,
`instance_mismatch`, `stale_generation`, `operation_conflict`, `unavailable`,
and `internal_error`. A timeout or disconnected socket says nothing about
whether a mutation was accepted; query status before retrying.

The separate [lifecycle event socket](events.md) serves read-only state subscribers.
There are no unsolicited event frames in control version 7. Poll `agentvoice.status`
for an operation's state. This keeps a replacement runtime from inheriting a
caller connection, event subscription, or pending request.

### Socket methods

| Method | Parameters | Result |
| --- | --- | --- |
| `agentvoice.status` | `{}` | `ControlStatus` |
| `agentvoice.voice_get` | `{refresh?: boolean}` | `VoiceGetResult` |
| `agentvoice.voice_set` | `MutationRequest` plus `expectedRoleRevision`, `voice` or `selection`, `apply` | saved/apply `ControlOperation` |
| `agentvoice.redial` | `MutationRequest` | accepted/current `ControlOperation` |
| `agentvoice.new_session` | `MutationRequest` | accepted/current `ControlOperation` |
| `agentvoice.restart` | `MutationRequest` plus `scope: "runtime"` and optional `handoffPrompt` | accepted/current `ControlOperation` |

`MutationRequest` is:

```json
{"operationId":"restart-17","expectedGeneration":7,"expectedInstanceId":"controller-instance-id"}
```

`operationId` is an opaque caller-created value matching
`[A-Za-z0-9][A-Za-z0-9._:-]*`, at most 128 characters. It is durable idempotency
identity, not a JSON-RPC/socket request ID. `expectedInstanceId` binds a request to
one workspace-session controller, and `expectedGeneration` prevents a caller attached to a prior
runtime incarnation from bouncing a replacement runtime.

### Result shapes

`ControlStatus` contains:

```ts
{
  protocolVersion: 9;
  instanceId: string;
  workspace: string; // empty while initial candidate startup has not identified it
  threadId: string;  // empty while initial candidate startup has not identified it
  generation: number;
  runtime: { pid?: number; buildId?: string; phase: string; voicePhase?: string };
  directoryRole?: {
    source: { kind: "directory"; path: string };
    loaded: { generation: number; digests: RoleContent };
    desired?: { digests: RoleContent };
    stale: boolean | null;
    error?: "Directory role content is unavailable or exceeds observation limits";
  };
  role?: {
    loaded: RoleRef;
    desired?: RoleRef;
    desiredVoice?: string | null;
    voiceRevision: number;
    voice: string | null;
    adoptionSource?: {
      source: { kind: "directory"; path: string };
      loaded: { generation: number; revision: number; digests: RoleContent };
      current?: { digests: RoleContent };
      stale: boolean | null;
      error?: "Configured role source is unavailable or exceeds observation limits";
    };
    error?: string;
  };
  currentOperation?: ControlOperation;
  recentOperations: ControlOperation[];
}
```

`RoleContent` has `format: "agentvoice-role-content-v1"` and four lowercase
SHA-256 strings: `content`, `prompts`, `mcp`, and `skills`. `directoryRole` is an
additive protocol-7 field for directory-backed roles only. Loaded identifies the
last successfully activated runtime's preflight inputs; desired rereads current
bytes at that source path on each status request. `stale: null` plus the fixed
error means desired could not be observed, not that the role is current. No
prompt/MCP contents, commands, arguments, environment values or filesystem error
details appear in this field.

For a DB-backed role, `loaded` and `desired` remain immutable database revision
references. Optional `role.adoptionSource` separately compares the loaded
revision's effective assets with the current contents at the configured directory
candidate. It never makes that directory a runtime input, discovers a changed
selector after preflight, or applies content. Empty skill directories and unrelated
root files are absent because a database snapshot does not retain them. A null
staleness value and fixed error mean the recorded source path could not be read.

Redial/reattachment never replace the loaded observation. Successful runtime
replacement does. Live native skill reads may observe directory edits after
preflight, so this is not proof of continuous native consumption. Traversal is
bounded and non-atomic; it does not validate desired configuration or discover
changed role selectors. See [the exact framing and limits](adr/0069-directory-role-content-status.md).

`ControlOperation` contains immutable request identity and lifecycle state:

```ts
{
  operationId: string;
  kind: "redial" | "restart" | "new-session" | "voice-set";
  scope: "voice" | "runtime";
  expectedGeneration: number;
  expectedInstanceId: string;
  phase: "accepted" | "quiescing" | "interrupted" | "forced" | "starting" | "ready" | "failed";
  acceptedAt: string; // ISO 8601
  updatedAt: string;  // ISO 8601
  forced?: boolean;
  handoff?: {
    status: "pending" | "submitting" | "accepted" | "failed" | "unknown";
    clientUserMessageId: string;
    turnId?: string;
    error?: { code: string; message: string };
  };
  result?: { generation: number; threadId: string; workspace: string; pid?: number; buildId?: string };
  error?: { code: string; message: string };
}
```

The controller journal accepts the first valid mutation record before any
teardown. It retains at most 256 mutation IDs for one controller lifetime and
returns the latest 16 through `recentOperations`, alongside `currentOperation`.
Reusing an ID with identical immutable arguments returns the same latest
operation, even when its recorded generation is now old. Reuse with different
kind, scope, instance, generation, or handoff prompt (including omission) fails with `operation_conflict`. Concurrent
mutations are serialized by the controller. Frontend detach and reattachment
retain the journal. A completed operation retains its `result` identity snapshot,
including the activated build and PID, even after later replacements.
At the 256-operation bound, explicit server restart begins a new controller and
journal; deleting retry history automatically would break immutable-ID recovery.

`accepted` means durable acceptance only. `quiescing` stops the current voice
runtime; `interrupted` records graceful shutdown; `forced` records deadline
termination; `starting` starts a replacement; `ready` for a restart confirms it
resumed the controller-bound conversation and reached live media when a frontend
is attached. While detached, it confirms native runtime readiness and makes no
realtime speech or audible-media claim. For redial,
`ready` confirms that its exact successor voice connection reached live media.
Failed, superseded, stopped, or timed-out negotiation fails that operation. Read
`runtime.voicePhase` when present for voice state, while `runtime.phase` is
process readiness. `failed` includes a stable error. `forced` can remain true
on later states. No state promises exactly-once execution. Cleanup verifies captured descendant
identities, including detached sessions; descendants orphaned entirely between
ownership samples cannot safely be discovered after abrupt parent death.

`agentvoice.redial` has scope `voice`: it requires an attached frontend, reconnects
voice/WebRTC on the same runtime, and does not reload configuration, prompts,
native code, or Codex.
`agentvoice.restart` accepts only scope `runtime`: it replaces audio/WebRTC,
native AgentVoice code, configuration/prompt snapshot, and owned Codex child
under the retained workspace-session controller and separate frontend. Audio-only, Codex-only, PID-targeted, and
arbitrary-thread restart scopes do not exist in version 6.

## Optional restart handoff

`agentvoice.new_session` uses the same durable operation and instance/generation
fences, with scope `runtime` in its result. After successful preflight and old
runtime cleanup it removes the unchanged workspace `.agentvoice-session` marker,
creates and saves a new thread and reconnects voice when
a frontend is attached. `ready` confirms the new thread and runtime readiness;
it confirms media readiness only when attached. Preflight/cleanup failure
preserves the marker; failure after removal leaves either no marker or the
newly saved thread, which a later runtime retry uses. Old history and transcripts
remain, and mute preferences are preserved. The web reader follows the new exact
identity after revalidation. This operation
accepts no `scope` or `handoffPrompt` input.
Repeated operation IDs return their recorded outcome without another reset.

New session does not submit a working-agent turn or replay prior speech. It
starts a new conversation; ordinary `agentvoice.restart` resumes the active one.

### Handoff on an ordinary restart

Only `agentvoice.restart` / `agentvoice_restart_runtime` accepts `handoffPrompt`:

```json
{"operationId":"restart-17","expectedGeneration":7,"expectedInstanceId":"controller-instance-id","scope":"runtime","handoffPrompt":"Read AgentVoice status and report the new runtime generation."}
```

The prompt must contain non-whitespace text and occupy at most 8,192 UTF-8 bytes.
Its original contents are part of immutable request identity. Omission preserves
ordinary restart behavior. Redial does not accept a handoff prompt.

The controller privately journals the prompt and the selected workspace/thread
before accepting the restart. It submits the prompt at most once after the
replacement resumes that exact conversation, reaches live voice, and enables
media with the retained mute preferences. Without an attached frontend there is
no live voice, so handoff delivery records a not-ready failure rather than speaking
or replaying later. Submission uses the owned Codex
connection's native `turn/start`, with a labeled restart-handoff text input and
a stable `clientUserMessageId`. Native `turn/start` starts an idle backing agent
or steers an active regular turn; a handoff is not necessarily a dedicated new
turn. The correlation ID is not a promise of native deduplication.

Handoff status is separate from the restart's `phase`:

| `handoff.status` | Meaning |
| --- | --- |
| `pending` | Saved with the operation; no submission attempt has started. |
| `submitting` | The one permitted submission attempt is in progress. |
| `accepted` | Native returned a turn ID, recorded as `handoff.turnId`. |
| `failed` | Delivery was prevented or explicitly refused; see the stable error. |
| `unknown` | The attempt may have reached native, but its acceptance could not be established. |

A healthy replacement remains `phase: "ready"` when handoff submission fails.
Native acceptance does not establish completed work or audible speech. Observe
native work and the actual voice response separately. The prompt is not returned
in status or operation results, and errors omit prompt contents. It is stored in
the private operation journal and submitted to native conversation input; it is
not a secret-storage mechanism.

Duplicate operation requests return the recorded result and never submit again.
There is no automatic retry after uncertain acceptance, later readiness events,
redials, or further restarts. A failed restart does not carry its prompt into an
unrelated retry. Frontend detach and reattachment do not create a new journal or
adopt work from another controller. This API does not
provide a worker-result queue, cancellation method, or persistent prompt edit.

## Streamable HTTP MCP projection

The loopback endpoint is `http://127.0.0.1:<ephemeral-port>/mcp`. It uses the
standard stateful Streamable HTTP MCP handshake: `initialize`,
`notifications/initialized`, `tools/list`, then `tools/call`; clients send the
returned `mcp-session-id` on later requests. Requests without valid bearer
authentication receive `401`. Unknown sessions receive `404`. The host accepts
only its exact loopback Host header and same loopback Origin when an Origin is
present. It caps request bodies at 64 KiB, limits live MCP sessions to 32, and
closes sessions idle for five minutes.

The tools are a one-to-one projection of the socket methods and call the same
Zod validation and dispatch implementation:

| MCP tool | Socket method | Input |
| --- | --- | --- |
| `agentvoice_status` | `agentvoice.status` | `{}` |
| `agentvoice_voice_get` | `agentvoice.voice_get` | `{refresh?: boolean}` |
| `agentvoice_voice_set` | `agentvoice.voice_set` | `MutationRequest` plus `expectedRoleRevision`, `voice` or `selection`, `apply` |
| `agentvoice_redial` | `agentvoice.redial` | `MutationRequest` |
| `agentvoice_restart_runtime` | `agentvoice.restart` | `MutationRequest` plus `{scope:"runtime"}` and optional `handoffPrompt` |
| `agentvoice_new_session` | `agentvoice.new_session` | `MutationRequest` |

MCP tool results carry the same result object as structured content. Validation
or controller failures are MCP tool errors. `agentvoice_status` and
`agentvoice_voice_get` are read-only;
mutation tools are deliberately not marked idempotent at MCP level because the
caller must supply the durable operation ID.

## Retry and self-restart rules

Use a fresh, stable operation ID for one intended action. If the MCP call
returns, retain its operation ID and accepted result. If it times out or the
initiating Codex client dies, reconnect after exact-thread resume and call
`agentvoice_status`; retry the *same* immutable request only when status cannot
already resolve it. Do not generate another ID just because a response was not
observed.

A restart can terminate the native client before its tool output is persisted
in conversation history. An `accepted` return is therefore not completion, and
the original live turn, delegated work, tool processes, approvals, and realtime
state can be interrupted. The controller keeps the selected exact thread ID;
the replacement resumes that exact thread rather than using normal “continue”
selection. Persisted thread/conversation state may resume, but active execution
does not. A preflight failure leaves the old runtime and generation intact, so a
new request may use that generation. Once replacement has committed, its
generation advances even if the replacement later fails; read status and use the
new generation for a retry.

Future versions may add fields and methods only through a protocol-version
change or optional result fields. Clients must reject a different `v` and
ignore optional result fields they do not understand.

## Frontend socket

`agentvoice server` binds a separate mode-0600 socket in the mode-0700
`frontend/` directory, selected by a hash of the canonical workspace. Its version
is 3. `agentvoice` sends a strict `call` request with an optional UUID `clientId`
for correlation and owns the media attachment. A new attachment may use a fresh
UUID; it is not backend continuation identity. Server startup restores a valid
marked workspace session without an owner; if there is no marker, the first
accepted owner lazily creates it. A later owner attaches to the retained controller
and may use a different clientId. The server rejects additional callers while an
attachment starts, runs or detaches. Before the first attachment a restored
session may own a runtime and native child, but it opens no audio, WebRTC or native
realtime session. After detach it retains the runtime and native child but no media.

Only the owning connection can send `input` with one of:

```ts
{ action: "mute", target: "mic" | "speaker", muted: boolean }
{ action: "hold" }
{ action: "release" }
```

Strict validation runs before dispatch. The server publishes changed
`{v:3,type:"state",state}` frames with bounded media and coding-activity state;
see [the client API](client-api.md) for the complete contract. No audio, volume
samples, thread content, diagnostics or credentials cross this socket. Disconnect
releases push-to-talk, forces effective mute, stops realtime voice and returns
media admission to idle only after the native stop is acknowledged. It preserves persistent mute
assignments, native work, controller endpoints and the pinned workspace/thread.
If the stop is refused or times out, its outcome is unknown and the server reports
the failure and refuses new attachments until its process is restarted. The
disconnected client still closes local devices. A later client explicitly negotiates fresh media; there is
no reconnect or replay loop.

## Workspace voice selection

`agentvoice.voice_get` / `agentvoice_voice_get` is a read-only dedicated query for
available choices, current requested voice and write fences. `{refresh:true}` rereads
the native catalog without changing voice. The response is:

```ts
{
  instanceId: string; generation: number; workspace: string; threadId: string;
  nativePid?: number; phase: string;
  editable: boolean; canApplyNow: boolean; editError?: string;
  inspection: {
    managedVoice: string | null; requestedVoice: string | null;
    selectionSource: "explicit-request" | "native-resolution" | "unknown";
    masked: boolean; protocol: "v1" | "v3" | null;
    choices: string[]; defaultVoice: string | null;
    catalog:
      | { status: "available"; source: "thread/realtime/listVoices"; fetchedAt: string;
          voices: {v1: string[]; v2: string[]; defaultV1: string; defaultV2: string} }
      | { status: "unavailable"; source: "thread/realtime/listVoices"; error: string };
  };
  role?: ControlStatus["role"];
}
```

The catalog is declared by the owned Codex child, cached per runtime generation,
and never substituted from a static/public API list. WebRTC v3 maps native v1
voices; alternate unsupported protocols have empty choices. The native catalog
is not a guarantee of account eligibility or successful audio. `defaultVoice`
is the native fallback, separate from requested/effective voice. Native startup
notifications do not report the resolved voice when the request leaves it unset.
`requestedVoice` therefore stays null with `native-resolution` or `unknown`;
explicit requests require matching startup and live media before being reported.
`nativePid` and controller/generation bind provenance without guessing a native version.

`agentvoice.voice_set` / `agentvoice_voice_set` requires an explicitly ejected
workspace role. Pass operationId, expectedInstanceId, expectedGeneration,
expectedRoleRevision, voice (a bounded name or null to clear), and apply
(`voice` or `next-session`). Alternatively omit voice and pass
`selection:{kind:"random",excludeCurrent:true}`. Both selectors together are invalid.
Named choices are checked against the native compatible catalog before saving.
Random selection excludes the known active voice, chooses once, and records the
resolved `voice`, selector and catalog provenance in `voiceEdit` and the durable
SQLite receipt. Unknown current voice, ambiguous application, unsupported catalog
or no alternative fails before save. A repeated operation ID returns the original
choice; recovery after a journal-write failure also reuses the saved choice.
Save commits before asynchronous application.
`voice` requires an attached frontend and reconnects only the voice session; the
working child remains. `next-session` applies on the next explicit runtime
replacement, `new_session`, or server lifetime, not on ordinary frontend reattachment.
See [workspace roles](workspace-roles.md#voice-editing) for examples and retry,
saved-versus-applied, failure and status contracts. The operation adds kind
`voice-set` and a `voiceEdit` result; status optionally adds `role` with loaded
and desired references, desiredVoice, voiceRevision, voice and a database error
when needed.


Control protocol 9 replaces version 8 for bound-role adoption-source status. Existing loaded
controllers retain their old code and MCP catalog; a later explicitly authorized
server restart loads this API. A voice-only redial or runtime restart cannot replace
the retained controller. Publishing/building the command does not activate it.
