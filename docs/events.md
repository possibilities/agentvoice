# AgentVoice lifecycle events

The retained foreground controller owns a **separate read-only Unix socket** for
thread-state consumers. Control protocol 2 and its MCP tools are unchanged. The
event endpoint uses protocol 1 and survives voice runtime replacement. Fully quit
and relaunch AgentVoice to start a controller with this endpoint; runtime restart
alone cannot add it to an older controller.

## Discovery

```sh
agentvoice event-socket --workspace ~/code/myapp
agentvoice event-socket --workspace ~/code/myapp --thread <main-thread-id>
```

The command prints one absolute socket path, followed by a newline. It selects
an existing controller through the same bounded live status checks as
`mcp-config`: exact canonical workspace, optional exact current main thread,
and an error on ambiguity. It does not start AgentVoice, load voice configuration,
open audio, or export a control bearer token. `--allow-full-access` is not needed.
The owned Codex child also receives the path in `AGENTVOICE_EVENTS_SOCKET`.

The endpoint is `<controller-hash>.events.sock` beside the control socket under
`$XDG_STATE_HOME/agentvoice/control/` (default `~/.local/state/agentvoice/control/`).
The directory is mode 0700 and the socket 0600. Both endpoints belong to the same
foreground controller and close when it quits. Read-only is the API's contract,
not isolation from other processes running as the same Unix user.

## Wire contract

One UTF-8 JSON object per line, over a long-lived duplex connection. Envelopes
follow agentmux and smolmux: `v`, `type`, request/response `id`, and event
`event`/`data`. Request IDs are nonempty strings up to 128 characters. Requests
and params reject unknown fields. Protocol versions are endpoint-local.

```json
{"v":1,"type":"request","id":"subscribe","method":"event.subscribe","params":{"events":["thread*","runtime.*"]}}
{"v":1,"type":"response","id":"subscribe","ok":true,"result":{"subscribed":true,"events":["thread*","runtime.*"]}}
{"v":1,"type":"request","id":"snapshot","method":"state.get","params":{}}
```

| Method | Params | Result |
| --- | --- | --- |
| `event.subscribe` | `{events?: string[]}` | `{subscribed: true, events: string[]}` |
| `state.get` | `{}` | Complete current controller projection, described below |

Omitted `events` means `["*"]`. Supply 1–32 patterns, each at most 128 characters;
duplicates are removed. An exact name matches only itself. `*` matches everything;
a trailing `*` matches a **literal string prefix**, following agentsource's channel
matcher. `thread.*` matches `thread.state.changed` but not `threads.changed`;
`thread*` matches both. There are no regexes, middle wildcards, glob segments,
or case folding. Names/prefixes use lowercase letters, digits, `.`, `_`, `:`,
`/`, and `-`, starting with a letter. Unknown well-formed names are allowed.

A new `event.subscribe` replaces this connection's entire filter. Its response
marks the boundary: already queued events can precede it, subsequent events use
the new filter. Invalid requests preserve the existing filter. Close the
connection to unsubscribe. There are no control methods on this endpoint.

Failures retain the request ID when recoverable:

```json
{"v":1,"type":"response","id":"bad","ok":false,"error":{"code":"unknown_method","message":"unknown event method"}}
```

Errors are `invalid_request`, `invalid_params`, `unknown_method`, or
`internal_error`. Malformed uncorrelatable frames use `id: null`. Oversized frames
and peers exceeding resource limits may be disconnected without a final reply.

## Snapshot and reconciliation

`state.get` returns:

```ts
{
  instanceId: string;
  generation: number;
  sequence: number;
  runtime: { phase: string; workspace: string; mainThreadId: string };
  inventory: "pending" | "ready" | "incomplete" | "unavailable";
  threads: ThreadView[];
}
```

`instanceId` identifies this controller lifetime. `generation` identifies its
runtime generation; `sequence` increases for every published event across that
controller lifetime, including runtime replacements. A snapshot's sequence is
its watermark. No events are replayed from a log.

To connect or reconnect:

1. Register your event reader, call `event.subscribe`, and await its response.
2. Request `state.get`, buffering incoming events until its response arrives.
3. Replace local state with that snapshot. Discard buffered events at or below
   its sequence, then apply newer events in order.
4. On socket loss, mark observation unavailable. Reconnect and repeat.

Snapshots and event updates are serialized in the controller's event loop.
Filtered-out events cause sequence gaps; gaps do not imply lost history.
`state.get` always returns the whole bounded projection regardless of the filter.
A UI displaying thread state should include `threads.changed`,
`thread.state.changed`, and `runtime.state.changed` (or simply subscribe to `*`).

## Thread state

```ts
type ThreadView = {
  id: string;
  parentThreadId: string | null;
  name: string | null;
  status: "unknown" | "notLoaded" | "idle" | "active" | "systemError";
  activeFlags: ("waitingOnApproval" | "waitingOnUserInput")[];
  turn: { id: string; status: "inProgress" | "completed" | "interrupted" | "failed" } | null;
};
```

Status comes from native thread status reports. A turn completing does not
manufacture an `idle` status. `turn` is the latest observed turn, not a history
query; `null` means no turn notification has been observed. A native failure
reports `failed` without forwarding error text. Names are optional and truncated
to 256 characters. `parentThreadId: null` means no parent was reported.

The inventory covers threads loaded in the **owned app-server**, including
native subagents and old Fresh conversations still loaded there. It does not scan
other Codex processes or native on-disk history. The runtime performs one bounded,
paginated `thread/loaded/list` scan after native readiness, plus `thread/read`
without turns for metadata. It then follows native notifications, reading
metadata for newly observed IDs. Observation does not gate audio readiness.

`ready` means the initial inventory and metadata reads completed without a known
failure; it is not a durable guarantee of every native event. An unsupported or
failed read, malformed inventory, or the 256-thread limit yields `incomplete`.
Known rows keep updating. There is no periodic polling or automatic retry loop;
a new runtime performs a new scan. Native `notLoaded` or `thread/closed` removes
a row. Successful work usually leaves the row present and idle.

## Events

Every event's `data` includes `{instanceId, generation, sequence}`.

| Event | Other data | Client action |
| --- | --- | --- |
| `threads.changed` | `{inventory, threads}` | Replace the thread list and its completeness state |
| `thread.state.changed` | `{thread}` | Replace that thread's row |
| `runtime.state.changed` | `{runtime, inventory, threads}` | Replace runtime and inventory state; treat this as a reset boundary |

```json
{"v":1,"type":"event","event":"thread.state.changed","data":{"instanceId":"controller-id","generation":2,"sequence":19,"thread":{"id":"thread-id","parentThreadId":null,"name":null,"status":"active","activeFlags":[],"turn":{"id":"turn-id","status":"inProgress"}}}}
```

Quiescing, failed, and stopping runtimes clear the projection and report
`unavailable`; they do not claim successful thread/turn completion. Fresh changes
the current main thread but preserves other loaded rows. Old runtime incarnations
cannot publish into a replacement generation. Subscriptions remain connected
through replacement because the controller owns them.

This is a current-state feed. Worker-to-controller updates may coalesce under
IPC pressure; intermediate transitions are not a guaranteed audit trail. It
carries no prompts, message bodies, tool arguments/results, transcript text,
audio, SDP, or bearer capabilities. The controller validates the bounded shape
before publishing. Conversation content APIs are outside this contract.

## Limits

Both Unix endpoints share framing and bounded-write code. Each endpoint permits
128 connections, at most 128 in-flight requests per connection, 1 MiB input
frames, and 4 MiB of queued output per connection. A slow subscriber is dropped
without blocking other clients or the voice runtime. The thread projection is
bounded to 256 rows and stays below the private IPC frame limit. No subscriber
causes a Codex start, resume, turn, hook, or media operation.
