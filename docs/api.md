# AgentVoice control API

Control protocol **3** is read-only. A server-owned controller exposes status,
stock Codex attachment bootstrap and separate conversation/event observation for
one call. Closing the frontend closes that controller and its endpoints.

The former redial, restart and handoff methods, operation journal and operation
result fields are removed. Version 1/2 Unix frames are rejected. Existing clients
must use version 3 and rediscover endpoints for each call. The frontend protocol,
event protocol and native realtime version are separate contracts.

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
`enabled_tools` set to `agentvoice_status`, `startup_timeout_sec: 5`,
`tool_timeout_sec: 5`, and a
`bearer_token_env_var`. Registration is not readiness: the controller/runtime
also checks the native MCP catalog for a connected server and the exact tool
set before it reports the bridge ready.

## Private TUI launcher bootstrap

`agentvoice attach [--workspace <dir>] [--thread <id>]`
reuses live Unix status discovery. It then sends an authenticated `POST /tui/attach`
to the controller's loopback HTTP host with `{instanceId, generation, threadId,
workspace}`. This is a launcher-only endpoint, not an MCP tool or Unix
operation. It accepts no Origin and requires the same exact Host and bearer.

The controller must be ready and idle
with respect to lifecycle operations, and still match the target before and after
its private runtime request. The result contains the selected thread/workspace,
absolute Codex executable, gateway URL and an ephemeral bearer ticket. It is
returned with `Cache-Control: no-store`, never in status, diagnostics or tool
results. Every controller supports attachment; there is no opt-in or permission
gate. The native app-server token never leaves the runtime. The runtime uses
WebSocket for all native RPC, with no stdio transport branch.

The launcher must open its watcher before the TUI connects. Tickets admit one
watcher/TUI pair within 30 seconds, with at most eight grants per runtime. The
watcher controls launcher lifetime; native protocol initialization and correlation
remain per-client. Frames are capped at 4 MiB, pending requests at 64, and request
timeouts at 30 seconds. Requests outside the selected-thread allowlist are
rejected before native dispatch. Native command/file/permission approvals, tool
questions and MCP elicitations for the selected thread are forwarded to the TUI;
only answers matching a forwarded request ID pass back to native. Pending human
request IDs are bounded at 64 per connection, without a response deadline.
Native Codex owns pending requests, first-answer resolution and replay on resume.
AgentVoice neither auto-refuses them nor stores another approval queue. TUI resume
overrides are stripped to preserve the live settings; explicit settings updates
can change native permissions.

Call teardown revokes all grants before stopping media. Automatic renewal keeps
them. Lost connections require explicit reattachment and do
not replay input. See [ADR 0022](adr/0022-websocket-native-tui.md) for scope and
[README](../README.md#attach-a-stock-codex-tui) for launch instructions.

## Unix socket transport

Send one UTF-8 NDJSON request:

```json
{"v":3,"type":"request","id":"status-1","method":"agentvoice.status","params":{}}
```

The result is:

```ts
{
  protocolVersion: 3;
  instanceId: string; // unique per call
  workspace: string; // empty until runtime preflight resolves it
  threadId: string;  // empty until native identity is verified
  generation: number;
  runtime: { pid?: number; buildId?: string; phase: string; voicePhase?: string };
}
```

Responses retain `id` and have `{v:3,type:"response",ok:true,result}` or
`{v:3,type:"response",ok:false,error:{code,message}}`. `id` is a nonempty string
of at most 128 characters. Unknown envelope fields and nonempty status parameters
are rejected. Frames are capped at 1 MiB, requests in flight at 128 and queued
outgoing data at 4 MiB. Slow peers are disconnected. There are no unsolicited
control events; use the [event socket](events.md).

## Streamable HTTP MCP

The authenticated loopback `/mcp` endpoint supports the standard stateful MCP
handshake and advertises only `agentvoice_status({})`. It shares the socket's
schema and dispatcher. Results contain structured status; unknown tools fail.
Exact Host/Origin validation, 64 KiB request bounds, 32 sessions and five-minute
idle expiry apply. Native catalog readiness is verified before audio opens.

## Frontend socket

`agentvoice server` binds a separate mode-0600 socket in the mode-0700
`frontend/` directory, selected by a hash of the canonical workspace. Its version
is 1. `agentvoice` sends `{v:1,type:"request",id:"1",method:"call"}` to begin
one call. The server rejects additional callers while that call starts, runs or
tears down. It opens no runtime, native child or audio while waiting.

Only the owning connection can send `input` with one of:

```ts
{ action: "mute", target: "mic" | "speaker", muted: boolean }
{ action: "hold" }
{ action: "release" }
```

Strict validation runs before dispatch. The server publishes changed
`{v:1,type:"state",state}` frames containing only `available`, connection `phase`,
and each channel's persistent/effective mute booleans. No audio, volume samples,
thread content, diagnostics or credentials cross this socket. Disconnect releases
push-to-talk, stops the entire call and returns the server to waiting only after
cleanup finishes. If cleanup cannot be established, the server refuses new calls
until its process is restarted. There is no frontend reconnect or replay loop.
