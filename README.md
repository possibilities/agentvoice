> *Slop Made With Sweat: Made with a lot of love by someone who loves code but read none of it.*

# AgentVoice

AgentVoice is an experimental local voice frontend for Codex. A waiting server
immediately restores a selected workspace's saved session when one exists, or
creates one when the first frontend connects. It owns the exact workspace,
conversation, and stock `codex app-server` child; the connected terminal, phone
browser, or native Android client owns audio and WebRTC.

It is not a turnkey product yet. A usable installation currently requires a
prepared checkout, stock Codex authentication, platform dependencies, and
hands-on setup. Expect operator intervention, especially for microphone access,
macOS service installation, private-network pairing, and Android development.

## What it provides

- Bare `agentvoice` prints command help. The AgentVoice web UI presents one
  persistent Agent transcript with keyboard-submitted Agent input and projected
  `Via Voice` Human messages.
- `agentvoice client` opens only the pointer voice frontend.
- `agentvoice phone` serves a capability-bearing loopback page whose browser owns
  microphone capture, playback, and WebRTC.
- The native Android client supports private WSS pairing and foreground calls,
  but remains a development build.
- Each workspace resumes one exact Codex thread. Closing the active frontend stops
  realtime speech and client media, while the server retains native work and its
  endpoints. A later sole frontend attaches fresh media to the same session.
  A terminal connection automatically replaces the current media client; Android
  asks for confirmation before replacing it. Cancel leaves that client connected.

The server never owns production audio. Network access is opt-in, authenticated,
and limited to the client API; native Codex, attachment, MCP, and event sockets
remain local.

A saved marker pins the server's workspace at startup; a markerless workspace is
pinned when its first frontend connects. For the managed default this means a
newer workspace generation is selected only at an applicable server/session
boundary, never between frontend attachments. Redial is voice-only and requires
an attached frontend; explicit runtime restart and new session remain the
intentional native replacement operations.

## Try it from a prepared checkout

Run the server and explicit voice client in separate terminals, and open the web UI
at `https://agentvoice.localhost` for transcripts and typed Agent input:

```sh
# Restores saved native work if marked; always waits without opening audio
bun run src/main.ts server

# Attaches media, creating a new session only when the workspace was unmarked
bun run src/main.ts client
```

Use the same absolute workspace for both processes when you do not want the
managed default:

```sh
bun run src/main.ts server --workspace /absolute/project
bun run src/main.ts client --workspace /absolute/project
```

The terminal client needs Bun 1.3+, an authenticated stock Codex, built native
audio, and microphone permission. The phone path
uses browser audio and does not require the native audio build. See the
[complete manual](docs/manual.md) for setup, installation, clients,
configuration, permissions, web interaction, and troubleshooting.

## Documentation

- [Durable Work HUD](docs/hud.md) — independent work records and native observations

- [Manual](docs/manual.md) — detailed operation and reference
- [Architecture and source ownership](docs/architecture.md)
- [Configuration schema](server.schema.json) and [field guide](docs/field-guide.md)
- [Client API](docs/client-api.md), [control API](docs/api.md), and
  [event protocol](docs/events.md)
- [Direct child completion delivery](docs/direct-child-completions.md)
- [Android client](android/README.md) and
  [private-network handoff](docs/android-client-handoff.md)
- [Vocabulary](CONTEXT.md) and [decision log](docs/adr/README.md)

## Development

```sh
bun run test
bun run typecheck
bun run lint
```

Tests use fake protocol and media boundaries and do not open a microphone or
start inference. Hardware probes, installation, service restarts, Android device
work, and live calls are separate explicit operations.

For an independently restartable test server, targeted pointer client and two
simultaneous web origins, see [parallel production/test sessions](docs/parallel-test-environment.md).
