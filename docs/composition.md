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
agent attachment when it opens. Its exit replaces only its pane with text;
it does not end voice or trigger automatic attachment/input replay.

## Frontend socket observation

The existing private frontend socket retains protocol version 1. These methods
are additive; a server without `observe` refuses the composition before it
starts smolmux or the voice client. Update the waiting server through an explicit
installation/restart when adopting this command change.

- `observe`, with no params, replies with the current observation and subscribes
  the connection to subsequent `{v:1,type:"observation",observation:{...}}` frames.
  Observations contain `busy`, nullable `clientId`, `workspace`, `threadId`, and
  nullable `state` using the existing frontend-state schema. The response and
  subsequent publications are ordered on one connection. No history is replayed.
- `call` accepts omitted params or `{clientId:<UUID>}`. The UUID correlates a
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
composition and its local apps. An attachment exit leaves healthy voice running.
Runtime restart may revoke the agent attachment; it stays disconnected rather
than automatically reconnecting. Voice redial does not reopen attachment apps.

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
