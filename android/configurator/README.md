# AgentVoice design studio

A separate host browser app for comparing native Android voice controls and
tuning the existing Persona Halo. The phone renders the interactive demo;
the browser holds design choices, Speaking/Listening/Idle, per-state size,
shared vertical position, Reset tuning and Save profile. No tuning panel
obscures the phone.

| Direction | Header | Mute controls | Hold to talk |
| --- | --- | --- | --- |
| Current | Existing production screen | Existing controls | Existing surface |
| Signal | Quiet rail | Glyphs | Beam |
| Field radio | Slide-away | Rockers | Trigger |
| Ghost terminal | Hidden | Keycaps | Keycap |

Choose a direction, then mix its header, mute controls and hold surface using
the three selectors. Changing any selector switches to the experimental studio
layout. Current returns to the existing screen for comparison. Presets and
individual design choices preserve all three Halo sizes and the shared offset.
In the studio, revealing or hiding the header eases Halo's center while the
mute and hold targets stay fixed; it does not change the Halo diameter. Hidden
chrome has an explicit reveal control. Slide-away can remain open with Keep open.

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
phone** and reconnects automatically when the preview returns. Unsaved design,
sizes, position and selected state survive backgrounding and Android activity recreation.
Temporary USB/ADB loss also reconnects to the same selected phone; the host
recreates its own port forward if necessary. It never pulls the app into the
foreground. Return to **Halo preview** on the phone when ready.
Port 4317 is the default; `--port 0` selects an available port. Ctrl+C stops the
host app and removes only its own ADB forward. The preview stays on the phone.
Force-stopping the app, dismissing its task, or restarting the host command ends
this binding; rerun the host command to establish a fresh session in those cases.

The command opens the debug-only **Halo preview** activity. It loads the phone's
existing private `files/persona-tuning.json` without rewriting it. Size remains
35–120%, independently for each state. Vertical position applies to every state,
from −200 to +200 dp in 1 dp steps: negative moves up, positive moves down.
Reset tuning restores only the phone build's compiled geometry defaults,
currently 78 / 58 / 78% and +35 dp. It keeps the selected design and state.
Save profile keeps the design, all sizes and the shared position.
Phone channel buttons and hold-to-talk also select synthetic states, which the
browser observes. Reattaching to a still-open preview retains its unsaved choices.
There is no microphone, playback, grant, controller, Codex,
WebRTC or voice-server connection in this preview.

Explicit Save writes a version 3 profile atomically on the phone. Its `design`
contains the layout, header, mute and hold choices. Only after
the phone confirms that exact profile does the host write a matching, mode-0600
JSON copy to `profiles/<device-serial>.json`. Use `--save-to /absolute/file.json`
to choose another destination. The browser names that destination after Save.
A changed phone revision refuses a stale save. Browser edits and saves are also
bound to the observed connection, so delayed requests cannot run after reconnect.
Reconnection reads the current phone state; it never replays edits or Save.
An unconfirmed Save remains visible for review after recovery. A failed host write is reported
separately from a successful phone save. Reset and live edits do not persist
until Save. Version 1 and 2 phone profiles remain readable without rewriting:
version 1 seeds all three sizes, and both older versions select Current. Their
stored position remains intact; a missing position uses +35 dp. They become
version 3 only on explicit Save. Profiles are ignored by Git.

The real voice client and release APK retain their existing UI and compiled
`PersonaPlacement` defaults. Saving a demo choice does not adopt it into the
product; adoption remains an explicit code change after the operator selects
the final design. The unchanged native Halo adapter owns its rendering and
state-transition timing.

## Boundary

The host serves only fixed local assets and bounded tuning requests on
`127.0.0.1`, behind a random per-run URL. Writes require the exact Host and Origin.
CSP blocks external assets, scripts and embedding; there is no CDN or WebView.
The existing bundled IBM Plex Mono font is served under its [OFL](../fonts/OFL.txt).

ADB forwards an ephemeral host port to a new abstract Unix socket owned by the
debug preview. Its separate random token admits one peer at a time, including
successive peers from the same host run. Frames are limited
to 8 KiB; commands can only read preview state, select a bounded design,
select/resize/position Halo, or save its fixed private profile. The phone exposes
no TCP listener. The bridge closes on
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
`PersonaPreviewSession` applies the corresponding commands. `PersonaPreview`
renders either the shared production screen or debug-only `PreviewStudioScreen`
with synthetic state. The studio composes `PreviewHeader` and `PreviewControls`
around the existing native Halo.
Preview protocol 3 carries live/saved/default designs as well as sizes and
vertical offsets. The design contract permits `layout: original|studio`,
`header: quiet|drawer|none`, `mute: glyphs|rockers|keycaps`, and
`hold: beam|trigger|keycap`. Version 3 profile receipts must include the exact
confirmed design and geometry before the host copy is written. Use matching
current host code and debug APK.

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
