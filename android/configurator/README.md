# AgentVoice configurator

A separate host browser app controlling the native Halo preview on an Android
phone. The phone is the preview surface; the browser holds Speaking, Listening,
Idle, the selected state's size slider, Reset sizes, and Save profile. No tuning
panel obscures the phone.

Install the current Android debug APK on an explicitly selected, ADB-authorized
phone, then run from the repository root:

```sh
bun run android:configure --device R5CT91TW4RP
```

Or from this directory: `bun run start --device <adb-serial>`. Bun and ADB must be
on PATH. Open the printed loopback address in a browser **on the host machine**.
ADB runs without a mirroring window. scrcpy is optional and can run alongside
the configurator; it is not used for control or rendering by this app. Moving
the preview between displays, recreating its activity or backgrounding it can
interrupt the connection. Leave this browser tab open: it shows **Waiting for
phone** and reconnects automatically when the preview returns. Unsaved sizes and
the selected state survive backgrounding and Android activity recreation.
Temporary USB/ADB loss also reconnects to the same selected phone; the host
recreates its own port forward if necessary. It never pulls the app into the
foreground. Return to **Halo preview** on the phone when ready.
Port 4317 is the default; `--port 0` selects an available port. Ctrl+C stops the
host app and removes only its own ADB forward. The preview stays on the phone.
Force-stopping the app, dismissing its task, or restarting the host command ends
this binding; rerun the host command to establish a fresh session in those cases.

The command opens the debug-only **Halo preview** activity. It loads the phone's
existing private `files/persona-tuning.json` without rewriting it. Size remains
35–120%, independently for each state; position is fixed at +35 dp in all states.
Reset restores the phone build's compiled defaults, currently 78 / 58 / 78%.
Phone channel buttons and hold-to-talk also select synthetic states, which the
browser observes. Reattaching to a still-open preview retains its unsaved choices.
There is no microphone, playback, grant, controller, Codex,
WebRTC or voice-server connection in this preview.

Save writes the existing version 2 profile atomically on the phone. Only after
the phone confirms that exact profile does the host write a matching, mode-0600
JSON copy to `profiles/<device-serial>.json`. Use `--save-to /absolute/file.json`
to choose another destination. The browser names that destination after Save.
A changed phone revision refuses a stale save. Browser edits and saves are also
bound to the observed connection, so delayed requests cannot run after reconnect.
Reconnection reads the current phone state; it never replays edits or Save.
An unconfirmed Save remains visible for review after recovery. A failed host write is reported
separately from a successful phone save. Reset and live edits do not persist
until Save. Version 1 phone profiles still seed all three sizes and migrate on
explicit Save. Profiles are ignored by Git.

The real voice client retains its compiled `PersonaPlacement` defaults; adopting
a saved profile into those defaults remains an explicit code change, as before.
The unchanged native Halo adapter owns all rendering and transition timing.

## Boundary

The host serves only fixed local assets and bounded tuning requests on
`127.0.0.1`, behind a random per-run URL. Writes require the exact Host and Origin.
CSP blocks external assets, scripts and embedding; there is no CDN or WebView.
The existing bundled IBM Plex Mono font is served under its [OFL](../fonts/OFL.txt).

ADB forwards an ephemeral host port to a new abstract Unix socket owned by the
debug preview. Its separate random token admits one peer at a time, including
successive peers from the same host run. Frames are limited
to 8 KiB; commands can only read preview state, select/resize Halo, or save its
fixed private profile. The phone exposes no TCP listener. The bridge closes on
activity stop and reopens on return using the same binding retained in private
Android activity state. Host loss, invalid framing or liveness failure closes
the peer; a new peer must authenticate again. The bridge is absent from
the release APK and does not relax Android's cleartext/TLS configuration. This
does not change or forward the production phone-browser gateway.

## Development

`src/web.ts` and `public/` own the browser controls. `src/server.ts` serves them
and coordinates saves; `src/device.ts` owns the selected ADB connection and
`src/reconnecting-phone.ts` handles bounded retries and shutdown;
`src/protocol.ts` validates the preview contract. Android's debug
`PersonaPreviewSession` applies the corresponding commands and `PersonaPreview`
renders the shared production screen with synthetic state.

```sh
bun run test
bun run typecheck
```

These tests use fake phones, loopback sockets and disposable profile files.
Android instrumentation exercises the real abstract socket, authentication,
state selection, stale-save rejection, atomic profile receipts and shutdown,
using a unique cache file. Tests never overwrite the operator's tuning profile.
The existing Halo animation regressions still run against the same renderer.

See [ADR 0037](../../docs/adr/0037-host-persona-configurator.md).
