# Using AgentVoice from an orchestrator

AgentVoice is a foreground voice application. Its persistent controller keeps
the terminal UI, exact workspace/thread identity, thread lease, control socket,
and operation journal. The voice runtime beneath it owns audio, WebRTC, native
AgentVoice code, configuration/prompt loading, and the owned Codex app-server.

Your orchestration thread receives a built-in `agentvoice_control` MCP entry on
start, resume, and Fresh. It is required, but connection/catalog readiness is
checked separately; tool registration does not force a model to select a tool.
There is no global `CODEX_HOME` write and no permanent user MCP configuration.

## Connect another local MCP client

Use the fleet-standard config export while the target AgentVoice controller is
already running:

```sh
agentvoice mcp-config --workspace /absolute/workspace
claude --mcp-config <(agentvoice mcp-config --workspace /absolute/workspace)
```

It prints only a pretty-printed `mcpServers` JSON object with the controller's
live loopback URL and bearer header. The workspace defaults to the command's
current directory and is canonicalized. If more than one controller matches,
pass `--thread <exact-id>`; zero matches and remaining ambiguity are errors.
Claude Code and MCP Inspector consume this JSON shape directly. Codex's native
MCP configuration has a different shape and does not consume this file directly.

The command discovers an existing controller; it does not launch or restart
AgentVoice, load launch settings, open media, or require
`--allow-full-access`. It can export a controller whose voice runtime is failed,
which permits inspection and recovery through the still-live control endpoint.
The JSON contains a bearer capability, so do not log or retain it beyond that
controller session. Regenerate it after every launch because the token and
controller identity are fresh even if the operating system reuses a port.

Use the MCP tools when you are operating the conversation that supplied them:

```text
agentvoice_status({})
agentvoice_redial({ operationId, expectedGeneration, expectedInstanceId })
agentvoice_restart_runtime({ operationId, expectedGeneration, expectedInstanceId, scope: "runtime" })
```

Start with `agentvoice_status`. It gives the controller-bound `instanceId`, the
current runtime `generation`, exact thread ID, state, current operation, and
recent operations. Copy its instance and generation into any mutation. Do not
invent a workspace, thread ID, process ID, socket path, or narrower component
scope: the control plane is intentionally bound to its owning controller.

## Pick the smallest supported recovery

Use `agentvoice_redial` when voice/WebRTC needs to reconnect while the current
runtime stays live. It preserves the runtime's loaded code and configuration.

Use `agentvoice_restart_runtime` only when the runtime must be replaced: for
example, to reload the AgentVoice configuration/prompt snapshot, native audio
library, WebRTC/audio stack, or owned Codex child. It is not an audio-device
reopen, audio-only reset, Codex-only restart, or a way to choose another
conversation. The controller retains the exact thread and resumes it after
replacement.

```ts
// These values come from the immediately preceding status result.
const operationId = `restart-${crypto.randomUUID()}`;
await agentvoice_restart_runtime({
  operationId,
  expectedInstanceId: status.instanceId,
  expectedGeneration: status.generation,
  scope: "runtime",
});
```

The result may only say `phase: "accepted"`. That means the controller has
durably recorded the requested action; it does not mean the calling model saw
or persisted the answer, or that the replacement is ready. A full restart can
end the calling native connection before the tool result reaches conversation
history. Active work, subagents, tool processes, approvals, and realtime state
are interrupted. Persisted conversation/thread state is the substrate for the
exact-thread resume; active execution does not continue.

Poll `agentvoice_status` after reconnecting. Operation states proceed through
`accepted`, `quiescing`, `interrupted` or `forced`, `starting`, then `ready` or
`failed`. A `forced` shutdown records that the bounded graceful interval
expired. For a runtime restart, `ready` confirms the exact-thread replacement
has reached live media. For redial, `ready` confirms that the exact replacement
voice connection reached live media; a failed, superseded, stopped, or timed-out
successor fails the operation. Check `runtime.voicePhase` when present
for the voice state, and `runtime.phase` for process readiness. If an operation
fails, read its error and status before deciding whether a new action is appropriate.

## Idempotency, timeouts, and stale callers

Give one intended action one stable `operationId` matching
`[A-Za-z0-9][A-Za-z0-9._:-]*`. The controller durable journal returns the same
operation for a duplicate ID with the same immutable arguments. Reusing an ID
with different scope, instance, or generation is refused. The controller keeps
at most 256 IDs for its own lifetime and exposes its latest 16 operations plus
the current one. Mutations are serialized; this protects against parallel
orchestrator branches issuing two restarts. A full quit/relaunch begins a new
journal and cannot recover an old operation ID.

If a tool times out, fails to return, or dies during restart, the outcome is
unknown. Do not submit a new operation ID. On the resumed exact thread, first
call `agentvoice_status`, locate the original ID in `currentOperation` or
`recentOperations`, and reuse the same request only if it cannot resolve the
operation. A stale `expectedGeneration` prevents a caller from bouncing a new
runtime that replaced the old one. If preflight fails before replacement, the
old generation remains valid; after committed replacement failure, read the
new generation from status before retrying.

## Writing a skill or wrapper

Keep a wrapper thin. It should read status, construct a durable operation ID,
call one MCP tool, and expose the accepted operation ID so a later invocation
can recover it. It should not shell out to a socket path, store bearer tokens,
or launch a second AgentVoice process.

```ts
type Control = {
  agentvoice_status(input: Record<string, never>): Promise<Status>;
  agentvoice_restart_runtime(input: {
    operationId: string;
    expectedInstanceId: string;
    expectedGeneration: number;
    scope: "runtime";
  }): Promise<Operation>;
};

export async function restartRuntime(control: Control, operationId: string) {
  const status = await control.agentvoice_status({});
  return await control.agentvoice_restart_runtime({
    operationId,
    expectedInstanceId: status.instanceId,
    expectedGeneration: status.generation,
    scope: "runtime",
  });
}
```

For a non-MCP local integration, use the same versioned NDJSON contract over
the inherited `AGENTVOICE_CONTROL_SOCKET` path. It identifies this controller
only; do not derive socket paths from a workspace or use an endpoint supplied by
another instance. This Bun example sends the exact status frame;
[`tests/control.test.ts`](tests/control.test.ts) is an executable, end-to-end
fake-controller example for both UDS and HTTP MCP.

```ts
const request = {
  v: 1,
  type: "request",
  id: "status-1",
  method: "agentvoice.status",
  params: {},
};
socket.write(`${JSON.stringify(request)}\n`);
```

Socket permissions protect the local Unix API. The MCP endpoint is loopback
only but still requires its per-instance bearer capability. Do not log that
token or serialize it outside the explicit `mcp-config` export. Multiple
AgentVoice launches have distinct controller identities and endpoint capabilities,
even for the same user or workspace.

The complete method, result, error, transport, and compatibility reference is
in [`docs/api.md`](docs/api.md). Agentmux is the relevant precedent for shared
Zod validation/dispatch across Unix socket and MCP; smolmux is the precedent
for a private, bounded singleton socket. AgentVoice retains a foreground
controller rather than adopting either project's daemon topology.
