# AgentVoice control API

This is the authoritative reference for AgentVoice control protocol version 2.
The persistent foreground controller owns this API, the exact conversation
identity, operation journal, Unix socket, and loopback MCP host. Its disposable
voice runtime may be replaced without replacing this API.

The controller exposes three operations: inspect status, redial
voice/WebRTC, and replace the full runtime. It does not accept a thread ID,
workspace, PID, socket path, or component selector from callers.

Version 2 adds an optional restart handoff prompt and its submission status.
Version 1 Unix frames are rejected; update socket clients and fully relaunch
the foreground application to activate a new controller. Runtime restart keeps
the existing controller and cannot upgrade its API. The MCP transport version
and the native Codex/voice protocols are separate from this control version.

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
and optional exact thread. This reflects Fresh immediately and remains available
when the runtime phase is `failed`. Zero matches and ambiguity fail rather than
selecting the newest record. Successful output is the fleet-standard
`mcpServers` JSON with an `Authorization: Bearer …` header for Claude Code and
MCP Inspector. The JSON is an explicit capability export for the current
controller lifetime; Codex's native MCP configuration uses a different shape.

AgentVoice registers this MCP server for each orchestration thread as
`agentvoice_control`. Its native configuration has `required: true`,
`enabled_tools` set to the three tool names below, `startup_timeout_sec: 5`,
`tool_timeout_sec: 5`, and a
`bearer_token_env_var`. Registration is not readiness: the controller/runtime
also checks the native MCP catalog for a connected server and the exact tool
set before it reports the bridge ready.

## Unix socket transport

The socket is newline-delimited JSON (NDJSON). A request is one UTF-8 line;
responses may finish out of order and retain the caller-selected `id`.

```json
{"v":2,"type":"request","id":"status-1","method":"agentvoice.status","params":{}}
```

```json
{"v":2,"type":"response","id":"status-1","ok":true,"result":{"protocolVersion":2,"instanceId":"…","workspace":"/work","threadId":"…","generation":7,"runtime":{"phase":"ready"},"recentOperations":[]}}
```

`v` must be `2`; `type` must be `request`; `id` is a nonempty string of at
most 128 characters. Unknown envelope fields are rejected. Input frames are
capped at 1 MiB, a connection may have at most 128 requests in flight, and
unwritten response data is capped at 4 MiB. A slow peer is disconnected.

Failure responses retain the request `id` where it can be recovered:

```json
{"v":2,"type":"response","id":"restart-17","ok":false,"error":{"code":"stale_generation","message":"controller generation changed"}}
```

Error codes are `invalid_request`, `invalid_params`, `unknown_method`,
`instance_mismatch`, `stale_generation`, `operation_conflict`, `unavailable`,
and `internal_error`. A timeout or disconnected socket says nothing about
whether a mutation was accepted; query status before retrying.

The separate [lifecycle event socket](events.md) serves read-only state subscribers.
There are no unsolicited event frames in control version 2. Poll `agentvoice.status`
for an operation's state. This keeps a replacement runtime from inheriting a
caller connection, event subscription, or pending request.

### Socket methods

| Method | Parameters | Result |
| --- | --- | --- |
| `agentvoice.status` | `{}` | `ControlStatus` |
| `agentvoice.redial` | `MutationRequest` | accepted/current `ControlOperation` |
| `agentvoice.restart` | `MutationRequest` plus `scope: "runtime"` and optional `handoffPrompt` | accepted/current `ControlOperation` |

`MutationRequest` is:

```json
{"operationId":"restart-17","expectedGeneration":7,"expectedInstanceId":"controller-instance-id"}
```

`operationId` is an opaque caller-created value matching
`[A-Za-z0-9][A-Za-z0-9._:-]*`, at most 128 characters. It is durable idempotency
identity, not a JSON-RPC/socket request ID. `expectedInstanceId` binds a call to
one controller, and `expectedGeneration` prevents a caller attached to a prior
runtime incarnation from bouncing a replacement runtime.

### Result shapes

`ControlStatus` contains:

```ts
{
  protocolVersion: 2;
  instanceId: string;
  workspace: string; // empty while initial candidate startup has not identified it
  threadId: string;  // empty while initial candidate startup has not identified it
  generation: number;
  runtime: { pid?: number; buildId?: string; phase: string; voicePhase?: string };
  currentOperation?: ControlOperation;
  recentOperations: ControlOperation[];
}
```

`ControlOperation` contains immutable request identity and lifecycle state:

```ts
{
  operationId: string;
  kind: "redial" | "restart";
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
mutations are serialized by the controller. A full quit/relaunch does not adopt
the old journal. A completed operation retains its `result` identity snapshot,
including the activated build and PID, even after later replacements.

`accepted` means durable acceptance only. `quiescing` stops the current voice
runtime; `interrupted` records graceful shutdown; `forced` records deadline
termination; `starting` starts a replacement; `ready` for a restart confirms it
resumed the controller-bound conversation and reached live media. For redial,
`ready` confirms that its exact successor voice connection reached live media.
Failed, superseded, stopped, or timed-out negotiation fails that operation. Read
`runtime.voicePhase` when present for voice state, while `runtime.phase` is
process readiness. `failed` includes a stable error. `forced` can remain true
on later states. No state promises exactly-once execution. Cleanup verifies captured descendant
identities, including detached sessions; descendants orphaned entirely between
ownership samples cannot safely be discovered after abrupt parent death.

`agentvoice.redial` has scope `voice`: it reconnects voice/WebRTC on the same
runtime and does not reload configuration, prompts, native code, or Codex.
`agentvoice.restart` accepts only scope `runtime`: it replaces audio/WebRTC,
native AgentVoice code, configuration/prompt snapshot, and owned Codex child
under the retained controller/TUI. Audio-only, Codex-only, PID-targeted, and
arbitrary-thread restart scopes do not exist in version 2.

## Optional restart handoff

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
media with the retained mute preferences. Submission uses the owned Codex
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
unrelated retry. Full quit/relaunch does not adopt old handoffs. This API does not
provide a separate mailbox, queue, cancellation method, or persistent prompt edit.

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
| `agentvoice_redial` | `agentvoice.redial` | `MutationRequest` |
| `agentvoice_restart_runtime` | `agentvoice.restart` | `MutationRequest` plus `{scope:"runtime"}` and optional `handoffPrompt` |

MCP tool results carry the same result object as structured content. Validation
or controller failures are MCP tool errors. `agentvoice_status` is read-only;
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
