# Foreground composition

Bare `agentvoice [--workspace <dir>]` launches an installed `smolmux start
--foreground --name <unique-name>`, controlled through its private protocol-2
socket. It checks that `instance.status` identifies the exact child PID, name
and foreground host before creating apps. The wrapper and smolmux use separate
processes and renderer dependencies. There is no headless Runtime or Companion
session. Smolmux 0.9.2 or newer and its installed local PTY helper are required.

Before creating any apps, Composition enables
`instance.configure({confirmExit:true})`. Smolmux consumes physical Ctrl+C:
first press displays its centered single-row bottom overlay, and a second within
three seconds stops every Session and the Runtime. The overlay never changes
pane sizes; individual apps cannot receive physical Ctrl+C. The voice client
disconnecting closes its call through the existing frontend ownership path.
An older smolmux that refuses configuration fails before starting the client.

The three equal-width initial panes contain `agentvoice client` and two text
placeholders. All three app declarations explicitly use `pty: "local"` and
`whenHidden: "keep"`; being squeezed to zero width does not end a call. Layout
replacement reads the current tree and passes its revision, retrying only an
explicit conflict so divider drags survive. Keyboard focus moves to the stock
agent attachment when it opens. Any pane app exit ends the composition and its call. There is no automatic
attachment/input replay.

## Frontend socket observation

The existing private frontend socket uses protocol version 2. These methods
are additive; a server without `observe` refuses the composition before it
starts smolmux or the voice client. Update the waiting server through an explicit
installation/restart when adopting this command change.

- `observe`, with no params, replies with the current observation and subscribes
  the connection to subsequent `{v:2,type:"observation",observation:{...}}` frames.
  Observations contain `busy`, nullable `clientId`, `workspace`, `threadId`, and
  nullable `state` using the existing frontend-state schema. The response and
  subsequent publications are ordered on one connection. No history is replayed.
- `call` requires `{clientId:<UUID>}`. The UUID correlates a
  composition's spawned client with its call; it is not a permission or bearer
  capability. Existing private-socket and exclusive-peer ownership checks remain.
- An observer cannot acquire a call or send pointer input. Closing an observer
  only ends observation. Closing the owning client still releases holds and
  completes call cleanup before another client can start.

The composition subscribes before spawning its client and passes a fresh UUID
only to that client's environment as `AGENTVOICE_CLIENT_ID`. It launches the two
attachments once, after observing matching `clientId`, `busy:true`, available
state with `phase:"live"`, and nonempty workspace/thread. Both attachment argv
arrays contain explicit `--workspace` and `--thread`. A busy server at initial
subscription is refused; a competing later client cannot satisfy this gate.

Server/observer loss, pointer client exit or foreground termination ends the
composition and its local apps. An attachment exit also ends this voice-owning composition and its call.
Runtime restart may revoke the agent attachment; it stays disconnected rather
than automatically reconnecting. Voice redial does not reopen attachment apps.

## Desktop attachment view

```sh
agentvoice --attach
agentvoice --attach --host smolbird
agentvoice --attach --host smolbird --workspace /absolute/path/on/phone
```

This mode runs **only on desktop**, with two panes and no audio client. It can
wait for a mobile call without reserving admission. Closing the view ends its
attachments; the owning frontend keeps its call. The agent pane receives focus
when it opens. Either pane exiting ends the view.

Without `--host`, the desktop observes its local private frontend socket. An
explicit workspace first selects its own endpoint, falling back to the stable
default endpoint when absent. The controller is discovered by exact live
workspace/thread. `attachmentReady` becomes true after the native thread and
control registration are ready, independently of voice media. Older running
servers omit that optional status field and retain their media-ready gate.

With `--host`, existing SSH configuration supplies host, port and identity.
Host verification is strict, authentication is noninteractive, and agent and
port forwarding are disabled. No keys or known-host entries are created. Both
machines need the updated AgentVoice CLI. The phone needs its existing stock
Codex TUI, but no smolmux or codex-viewer for this view.

One SSH command runs the internal read-only `__attach-bridge` helper. It streams
versioned, strict NDJSON containing call identity, backend readiness and complete
voice JSONL records. Native credentials, controller descriptors, attachment
tickets and socket addresses are never exported. The desktop writes a disposable
mode-0600 transcript in a mode-0700 temporary directory, and runs local
`codex-viewer --voice-jsonl <copy> --follow`.

The other pane uses an SSH PTY to run `__attach-agent` on the backend. It bootstraps
the existing stock Codex attachment with the exact selected controller instance,
generation, workspace and thread. A successor cannot satisfy that bootstrap.
Local mode uses the same pinned bootstrap without SSH. The stock gateway retains
its normal policy for typed steering and native approvals.

The bridge pins the owning client and never follows another call. Call end,
server/SSH loss, controller replacement or either pane exiting ends the view.
Runtime replacement requires an explicit rerun. Voice redial preserves the
attachment. The copy is removed after pane cleanup; saved backend recordings
remain untouched. The separate voice WSS gateway is unchanged.

Bounds: 2 MiB per bridge frame, 1 MiB per voice record, 64 MiB per transcript,
15 seconds without a complete remote frame, and 5 seconds for a stalled helper
stdout write. SSH also uses bounded connect and keepalive timeouts. A malformed,
truncated, oversized or stalled stream fails visibly without reconnecting.

## Verification

`bun run test` covers the socket ownership and startup ordering with fake calls,
and layout revisions with fake smolmux responses. `tests/fixtures/composition-demo.ts`
supports a real terminal check without audio or Codex: set
`AGENTVOICE_COMPOSITION_FIXTURE` to a new private temporary directory, launch the
fixture with termctrl, then create `live` in that directory to release readiness.
It records fixture PIDs for cleanup checks and isolates smolmux's Companion
directory. Stop the termctrl session after checking placeholder replacement,
divider preservation and process cleanup. These checks establish UI/lifecycle
behavior, not live microphone or speech fidelity.

`tests/fixtures/attachment-demo.ts` checks the two-pane view with real smolmux and
codex-viewer, a fake mobile owner and a steerable fake orchestrator. Set
`AGENTVOICE_ATTACHMENT_FIXTURE` to a new private temporary directory and launch
with termctrl. After exit, `result.json` verifies the mobile owner was still
connected before fixture cleanup. This opens no audio or inference.
