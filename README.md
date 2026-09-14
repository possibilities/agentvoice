> *Slop Made With Sweat: Made with a lot of love by someone who loves code but read none of it.*

# AgentVoice

AgentVoice is an experimental local voice frontend for Codex. A waiting server
creates one retained workspace session when its first frontend connects, owning
the exact workspace, conversation, and stock `codex app-server` child; the
connected terminal, phone browser, or native Android client owns audio and
WebRTC.

It is not a turnkey product yet. A usable installation currently requires a
prepared checkout, stock Codex authentication, platform dependencies, and
hands-on setup. Expect operator intervention, especially for microphone access,
macOS service installation, private-network pairing, and Android development.

## What it provides

- Bare `agentvoice` opens a foreground terminal composition with voice controls,
  a persistent voice transcript, and an attached stock Codex TUI.
- `agentvoice client` opens only the pointer voice frontend.
- `agentvoice phone` serves a capability-bearing loopback page whose browser owns
  microphone capture, playback, and WebRTC.
- The native Android client supports private WSS pairing and foreground calls,
  but remains a development build.
- Each workspace resumes one exact Codex thread. Closing the active frontend stops
  realtime speech and client media, while the server retains native work and its
  endpoints. A later sole frontend attaches fresh media to the same session.

The server never owns production audio. Network access is opt-in, authenticated,
and limited to the client API; native Codex, attachment, MCP, and event sockets
remain local.

The first frontend pins the server's workspace until server shutdown. For the
managed default this means a newer workspace generation is selected on the next
server lifetime, not between frontend attachments. Redial is voice-only and
requires an attached frontend; explicit runtime restart and new session remain
the intentional native replacement operations.

## Try it from a prepared checkout

Run the server and client in separate terminals:

```sh
# Waits without opening audio or starting Codex
bun run src/main.ts server

# Connects and starts the call
bun run src/main.ts
```

Use the same absolute workspace for both processes when you do not want the
managed default:

```sh
bun run src/main.ts server --workspace /absolute/project
bun run src/main.ts --workspace /absolute/project
```

The terminal client needs Bun 1.3+, an authenticated stock Codex, built native
audio, microphone permission, smolmux 0.9.2+, and `codex-viewer`. The phone path
uses browser audio and does not require the native audio build. See the
[complete manual](docs/manual.md) for setup, installation, clients,
configuration, permissions, attachment, and troubleshooting.

## Documentation

- [Manual](docs/manual.md) — detailed operation and reference
- [Architecture and source ownership](docs/architecture.md)
- [Configuration schema](server.schema.json) and [field guide](docs/field-guide.md)
- [Client API](docs/client-api.md), [control API](docs/api.md), and
  [event protocol](docs/events.md)
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
