# AgentVoice event socket

The retained foreground controller owns a **separate read-only Unix socket** for
thread-state consumers, transient native voice items and conversation observation.
Control protocol 2 and its MCP tools are unchanged. The event endpoint uses protocol 2 and survives voice runtime replacement. Fully quit
and relaunch AgentVoice to start a controller with this endpoint; runtime restart
alone cannot upgrade an older controller. Protocol-1 clients must update.

For typed orchestrator/subagent content, live snapshots, bounded conversation
replay and native history reads, see [conversation observation](conversations.md).
The lifecycle and voice semantics below remain distinct from that content API.

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

To print only completed user and assistant voice messages from a checkout:

```sh
bun run voice:messages --workspace ~/code/myapp
# Optional when several controllers use that workspace:
bun run voice:messages --workspace ~/code/myapp --thread <main-thread-id>
```

The developer script (`scripts/voice-messages.ts`) uses the checkout's discovery
code; an installed `agentvoice` command is not required. Workspace defaults to
the current directory. It subscribes only to `voice.item.completed` and prints
`transcriptSegment` items as `user: ...` or `assistant: ...` on stdout, with
connection notices on stderr. It shows future completed voice segments, without
Codex conversation events or speech backfill. Completion does not mean audio
playback finished. Stop with Ctrl+C; rerun after disconnection to reconnect.
The script and controller must use the current event protocol. After a protocol
change, fully quit and relaunch AgentVoice from the current checkout; restarting
only the voice runtime leaves the old controller running. There is no version
negotiation or legacy compatibility path.

The endpoint is `<controller-hash>.events.sock` beside the control socket under
`$XDG_STATE_HOME/agentvoice/control/` (default `~/.local/state/agentvoice/control/`).
The directory is mode 0700 and the socket 0600. Both endpoints belong to the same
foreground controller and close when it quits. Read-only is the API's contract,
not isolation from other processes running as the same Unix user.

## Published schema

Every feed follows the repo-local `events.schema.json` convention. AgentVoice's
[checked-in JSON Schema](../events.schema.json) describes requests, responses,
and all named event types. `$defs.events.anyOf` lists references to definitions
named after their `event` value, such as `$defs["voice.item.completed"]`. Each
definition describes whether it is current state or transient content and gives
its payload shape. Clients can use this file to generate types or validate frames,
then filter by those event names through `event.subscribe`.

The fleet shares envelope fields, method/filter semantics, filename, and catalog
structure. Domain event names and payloads vary by app. Schemas live in each repo;
there is no runtime catalog request. Regenerate AgentVoice's file with
`bun run generate:events-schema`; drift tests and real socket-frame validation
keep it aligned with source. JSON Schema describes shape; ordering, byte-size
limits, and live-only delivery remain the behavioral contract below.

## Wire contract

One UTF-8 JSON object per line, over a long-lived duplex connection. Envelopes
follow agentmux and smolmux: `v`, `type`, request/response `id`, and event
`event`/`data`. Request IDs are nonempty strings up to 128 characters. Requests
and params reject unknown fields. Protocol versions are endpoint-local.

```json
{"v":2,"type":"request","id":"subscribe","method":"event.subscribe","params":{"events":["thread*","runtime.*"]}}
{"v":2,"type":"response","id":"subscribe","ok":true,"result":{"subscribed":true,"events":["thread*","runtime.*"]}}
{"v":2,"type":"request","id":"snapshot","method":"state.get","params":{}}
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
connection to unsubscribe. There are no control methods on this endpoint; additional read-only
`conversation.*` methods are documented in the conversation contract.

Failures retain the request ID when recoverable:

```json
{"v":2,"type":"response","id":"bad","ok":false,"error":{"code":"unknown_method","message":"unknown event method"}}
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
its watermark. Lifecycle and voice events are not replayed from a log.
Conversation events have a separate bounded replay method.

To connect or reconnect:

1. Register your event reader, call `event.subscribe`, and await its response.
2. Request `state.get`, buffering incoming events until its response arrives.
3. Replace local lifecycle state with that snapshot. Discard buffered **lifecycle**
   events at or below its sequence, then apply newer lifecycle events in order.
   Deliver every received `voice.*` event independently, including those at or
   below the snapshot watermark: the snapshot contains no voice items or text.
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
{"v":2,"type":"event","event":"thread.state.changed","data":{"instanceId":"controller-id","generation":2,"sequence":19,"thread":{"id":"thread-id","parentThreadId":null,"name":null,"status":"active","activeFlags":[],"turn":{"id":"turn-id","status":"inProgress"}}}}
```

Quiescing, failed, and stopping runtimes clear the projection and report
`unavailable`; they do not claim successful thread/turn completion. Fresh changes
the current main thread but preserves other loaded rows. Old runtime incarnations
cannot publish into a replacement generation. Subscriptions remain connected
through replacement because the controller owns them.

The lifecycle projection is a current-state feed. Worker-to-controller lifecycle
updates may coalesce under IPC pressure; intermediate transitions are not a
guaranteed audit trail. Lifecycle payloads contain no conversation bodies. The
controller validates bounded shapes before publishing. Lifecycle and voice events
forward no audio, SDP, control bearer capabilities, or arbitrary tool payloads.
Conversation events separately project known native tool item fields.
Native voice text can of course contain sensitive user-spoken content.

## Transient native voice items

The same endpoint publishes three additional events. `event.subscribe` with
`voice.*` selects only these; `*` includes both lifecycle and voice. Consumers
interested only in thread state should use the three lifecycle event names
above. All events share the controller's sequence, instanceId, and generation.

| Event | Native notification | Other data |
| --- | --- | --- |
| `voice.item.started` | `thread/realtime/item/started` | `{threadId, item}` |
| `voice.item.transcript.delta` | `thread/realtime/item/transcript/delta` | `{threadId, itemId, delta}` |
| `voice.item.completed` | `thread/realtime/item/completed` | `{threadId, item}` |

The native item shape is preserved, verified against Codex 0.153.4 and the local
upstream source:

```ts
type VoiceItem = { id: string; realtimeSessionId: string } & (
  | { type: "realtimeSessionStarted" }
  | { type: "transcriptSegment"; role: "user" | "assistant"; text: string }
  | { type: "bemItemPromoted"; turnId: string; itemId: string;
      presentation: { type: "wholeItem" } | { type: "inlineMarkdown" }
        | { type: "inlineVisualization"; index: number } }
  | { type: "realtimeSessionClosed"; outcome: "ended" | "failed" }
);
```

```json
{"v":2,"type":"event","event":"voice.item.transcript.delta","data":{"instanceId":"controller-id","generation":2,"sequence":20,"threadId":"native-thread","itemId":"native-item","delta":"Hello"}}
```

Deltas have no native role or session ID. AgentVoice does not add either or infer
identity from the currently active call. Consumers can correlate native item
IDs within their thread using started/completed items. Those items retain their
reported realtimeSessionId even if the call has since been replaced. User and
assistant segments may interleave; promoted-work references remain references.
No referenced work is fetched. AgentVoice does not combine the legacy flat
transcript events with this stream.

Started/completed payloads include their native item text when present. A
completed item can be useful even when a consumer missed its start or deltas;
it describes native canonical completion, not proof the human heard every word.
Observed voice items from old Fresh threads retain their original thread ID.
Obsolete runtime generations cannot publish into the replacement generation.

**Live voice delivery only.** AgentVoice does not accumulate voice text, store
voice transcript files or database rows, backfill speech, replay voice events,
or provide a transcript UI. Conversation replay/history is a separate API. There is no delivery acknowledgment or recovery promise. `state.get` remains
lifecycle-only, even though its sequence includes voice events already published.
Never discard voice events using a lifecycle snapshot watermark. A new
subscription gets future events; reconnect does not recover missed speech.

Malformed/unknown native item shapes and events over 64 KiB serialized as
`{event,data}` are dropped whole, without truncating text or inventing identity.
IDs are nonempty strings of at most 256 characters. At 16 pending runtime IPC
writes, new voice events are dropped immediately; they are never coalesced by
replacing earlier deltas and never enter the control queue's hard-overflow path.
Later events may still arrive, including a completed item. Accepted events retain
native arrival order. Socket backpressure can disconnect a slow subscriber;
restart/shutdown can also lose trailing items. Sequence gaps alone cannot
distinguish filtering from missing content, and drops before publication do not
allocate a sequence.

These item notification bodies are omitted from native receive debug logs.
Existing opt-in general debug logs can still contain other native conversation
content; this feature adds no transcript logging or persistence.

## Limits

Both Unix endpoints share framing and bounded-write code. Each endpoint permits
128 connections, at most 128 in-flight requests per connection, 1 MiB input
frames, and 4 MiB of queued output per connection. A slow subscriber is dropped
without blocking other clients or the voice runtime. The thread projection is
bounded to 256 rows and stays below the private IPC frame limit. No subscriber
causes a Codex start, resume, turn, hook, or media operation.
