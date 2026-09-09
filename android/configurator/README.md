# AgentVoice design studio

A separate host browser app for comparing native Android voice controls and
tuning the existing Persona Halo. The phone renders the interactive demo;
the browser holds separate Controls and Persona panels plus Save profile.
No tuning panel obscures the phone.

Controls offers Rockers or Keycaps for the two mute buttons and one fixed
Trigger surface labeled **Push to talk**. Press and keep it down to talk;
release to mute. The active trigger stays dark with focused lime accents.
There are no preset, header or talk-surface selectors.

Controls height spans 240–480 dp, including the fixed 16 dp join between mute
buttons and the trigger. Push-to-talk share spans 30–60% of that total height;
the mute row gets the remainder after subtracting the join. The baseline is
262 dp: 130 dp mute row, 16 dp join and 116 dp trigger, an exact share of
`116 / 262 × 100` (about 44.3%). **Reset defaults** inside Controls restores
only these two sliders, keeping the chosen mute style and Persona tuning.
Changing control size preserves the Halo diameter and its saved tuning values.

The phone has no header while connected. **Preview connection** selects a
synthetic Connected, Connecting or Disconnected state. A notice with a static glyph
slides down from the top for Connecting or Disconnected and remains until that
condition ends. It slides away when Connected returns; there is no connected
toast. The 240 ms transition reserves no layout space and moves neither Halo
nor the controls. The connection selection is transient and is not saved in
the profile. It does not change the host's actual ADB connection.

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
**Halo** switches between Original and Contained. Original retains its independent
78 / 58 / 78% size defaults and established transitions. Contained uses one size
for every state (78% initially), inward listening rings and pulse, softer speaking
motion and idle breathing. Its Ring spread defaults to 35%; Listening pulse,
Speaking motion and Idle breathing default to 25%, all adjustable from 0–100%.
At zero, spread collapses to the frame and that motion is removed. Increasing
spread/pulse moves the listening rings inward, without enlarging the frame.

Contained also has Speaking, Listening and Idle color pickers, initially the
app's violet `#bbaaff`, lime `#d4ff72` and warm white `#f0f2e9`. Disconnected stays
muted. Original's rendering and colors remain the comparison reference.
Switching variants keeps each variant's settings. Reset Persona restores the
selected variant's defaults and shared +35 dp position, preserving the other
variant's settings, control styling, dimensions and preview state. Save profile keeps the control design,
all Halo sizes, motion, colors and the shared position.
Phone channel buttons and Push to talk also select synthetic states, which the
browser observes. Reattaching to a still-open preview retains its unsaved choices.
There is no microphone, playback, grant, controller, Codex,
WebRTC or voice-server connection in this preview.

Explicit Save writes a version 5 profile atomically on the phone. Its `design`
contains the fixed layout/header/trigger choices, mute style, controls height
and talk-button share. Its `halo` stores variant, common Contained size, motion
and opaque RGB colors. Only after the phone confirms that exact profile does
the host write a matching, mode-0600
JSON copy to `profiles/<device-serial>.json`. Use `--save-to /absolute/file.json`
to choose another destination. The browser names that destination after Save.
A changed phone revision refuses a stale save. Browser edits and saves are also
bound to the observed connection, so delayed requests cannot run after reconnect.
Reconnection reads the current phone state; it never replays edits or Save.
An unconfirmed Save remains visible for review after recovery. A failed host write is reported
separately from a successful phone save. Resets and live edits do not persist
until Save. Version 1, 2, 3 and 4 phone profiles remain readable without rewriting:
version 1 seeds all three Halo sizes. Version 3 retains Rockers or Keycaps;
legacy Glyphs and profiles without a mute choice use Keycaps. Version 1–3 profiles
start with the control geometry baseline and fixed headerless Trigger
layout. Their Halo sizes and stored position remain intact; a missing position
uses +35 dp. Version 4 retains its saved control dimensions. All older profiles
start as Original and become version 5 only on explicit Save. Profiles are ignored by Git.

The real voice client and release APK retain their existing layout, behavior and
compiled `PersonaPlacement` defaults; their labels now also say Push to talk.
Saving a demo choice does not adopt it into the
product; adoption remains an explicit code change after the operator selects
the final design. Original's native Halo adapter retains its rendering and
state-transition timing; Contained has a separate debug renderer.

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
renders debug-only `PreviewStudioScreen` with synthetic state. The studio
composes a connection notice and controls around the existing native Halo.
Preview protocol 5 carries live/saved/default designs, sizes, vertical
offsets and Halo selections, plus the transient `connection: connected|connecting|disconnected`.
The design contract fixes `layout: studio`, `header: none`, `hold: trigger`,
permits `mute: rockers|keycaps`, and adds `controlsHeightDp` (integer 240–480)
and `holdSharePercent` (finite 30–60). The internal `hold` names retain their
protocol meaning; the visible and accessible control is Push to talk.
Version 5 profile receipts must include the exact confirmed design, geometry,
variant, motion and colors
before the host copy is written. Connection preview state is excluded from the
profile. Use matching current host code and debug APK.

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

Contained patches a checksum-verified in-memory copy of the bundled Halo. It
never writes the original asset or accepts an asset path/URL. The changed bytes
and renderer stay in debug builds. See [Persona provenance and notices](../third-party/persona-halo.md)
for creator attribution, code/runtime licenses, and the external asset's published
license evidence.
