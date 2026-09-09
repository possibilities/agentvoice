# AgentVoice design studio

A separate host browser app for comparing native Android voice controls and
tuning the existing Persona Halo. The phone renders the interactive demo;
the browser holds separate Controls and Persona panels plus Save profile.
No tuning panel obscures the phone.

Fresh portrait previews use provisional studio defaults: Contained at 78%,
Original state sizes 78 / 56 / 78%, vertical offset −22 dp, controls height
387 dp and Push-to-talk share 40.9%. Traces use Parallel, 130% stance, 175%
weight, 88% offshoots, zero glow and 100% contact/foot spacing. Light is Still
at 35%; Persona color follows channels. Landscape retains its independent
baseline below. Existing saved profiles keep their choices; these experimental
portrait defaults do not change the production app.

Both mute buttons and **Push to talk** use Rockers. Press and keep the talk
surface down to talk; release to mute. Active styling stays dark with focused
lime accents. There are no button-style, preset or header selectors.

**Traces** is the fixed composition. **Route** compares Parallel (the baseline
paired routes), Splayed (a wider fan of routes), and Circuit (staggered mechanical
steps). **Stance** spans 75–150% of the baseline; **Trace weight** spans 50–250%,
with 100% equal to 1.2 dp. Landscape starts both at 100%. **Offshoots** adds much lighter
side and upward routes, independently of the selected pattern, from 0–100%.
Landscape starts at zero. **Persona contact spacing** and **Button foot spacing** each
span 50–200%, default 100%. They separate neighboring traces within each bundle
at its upper and lower ends; Stance moves the bundles themselves. Foot spacing
remains fixed when stance hits a button edge. At large Persona sizes, protected
center clearance can limit upper spacing or make it depend on the foot positions.
The other compositions and their selector are removed.

Routes now reach the selected Persona size and position instead of ending a
fixed distance above the deck. Their geometry and soft clear aperture follow
settings, never animated pixels, and preserve the transparent center and native
glow. Original uses one conservative attachment envelope across its three state
sizes; a deliberately smaller state can sit farther from its routes. When that
envelope reaches the deck, routes collapse and can disappear even while the
current smaller ring remains above it. Contained's single shared size avoids
that tradeoff. Contained now uses its nominal frame and maximum selected speaking
expansion for a closer body boundary, with a 1 dp guard. Trace ink stays at 72%
strength 2 dp outside that boundary and reaches full strength at 12 dp, making
the feeds less washed out near the glow. The hollow center stays protected;
this stationary boundary can still leave a small gap in contracted poses.
Independent size/expansion maxima persist for 600 ms after edits, including
reduced motion, to cover the native scale transition and source debounce.
Routes add no touch targets and never
move controls or replace the native Halo instance.

**Background glow** adds two broad, dim fields behind the scene. Zero (default)
is off; 1–100% controls strength. Its gentle breathing shares the existing
14-second clock but is independent of Button light and Persona color following.
Reduced motion retains a still glow; backgrounding, disconnect and pending
controls clear it. No audio level drives the background geometry.

**Button light** offers Still (the unchanged default) or Soft: a broad matte
light drifts inside the existing button faces on one 14-second cycle. Strength
starts at 35% and affects only button light; even at maximum, the added wash is
capped at 3.5% opacity. Active channel energy gently deepens it with a 200 ms
attack and 850 ms release. Mute, pending controls and disconnect fence the light
immediately. PTT still requires a muted mic; when the mic is already open its
label reads **Live now / microphone open**. Holding confirmed PTT reads
**Live now / release to mute**. Button shapes and hit targets do not animate.

Controls height spans 240–480 dp, including the adjustable join between mute
buttons and the talk surface. Push-to-talk share spans 30–60% of that total height;
the mute row gets the remainder after subtracting the join. The landscape baseline is
262 dp: 130 dp mute row, 16 dp join and 116 dp talk surface, an exact share of
`116 / 262 × 100` (about 44.3%). **Reset button sizes** restores
only these two sliders to the visible orientation's defaults, keeping spacing,
composition, light and Persona tuning.

**Spacing** offers one **Padding** slider (0–40 dp) for minimum outer control
space and both button gaps. Fresh layouts start at 16 dp. Older profiles show
**Custom** and preserve their separate side, edge and button-gap settings until
you adjust Padding; the slider rests at 16 without applying it. **Section separation**
retains its existing 0–80 dp minimum extra gap between Persona and controls,
with zero as its default. Each slider has its own reset. **Reset spacing** restores
Padding to 16, section separation to zero, and the stored legacy baseline values
for only the visible orientation. Spacing remains unsaved until Save.

**Theme** offers Bright (default), Quiet and Grayscale. **Center indicator**
compares Off, Tide (original), Words, Channel icons, Icons + words and Contacts.
Tide remains the original both-muted indicator. Words shows the live/muted
channel truth; Channel icons pairs the microphone on the left with the speaker
on the right; Icons + words adds compact live/muted captions. Contacts keeps
Human left and agent right: joined contacts are live and a lifted contact is muted.

The new styles offer **Show**: Both muted, Either muted (default), or Always.
This selector stays hidden for Tide and Off, retaining its choice for the next
new-style selection. Tide always keeps its existing both-muted behavior.
Theme, indicator style and Show are session choices: they survive orientation
changes, activity recreation and ordinary tuning resets, but are excluded from
Save profile.

**Indicator appearance** adjusts Float or Ripple motion, primary text/icon
Size (12–32 sp), Brightness (−100–100%), Drift (0–300%), Breathing (0–100%) and
Cycle (6–30 seconds). Defaults preserve the existing Tide appearance: Float,
14 sp, 0% brightness adjustment, 100% drift, 0% breathing and a 14-second cycle.
Negative brightness dims the indicator, reaching invisible at −100%; zero
retains the existing brightness. Larger text, icons and motion may be limited
to fit inside Persona. Appearance controls remain visible and disabled while
Off; choosing another style restores the session tuning. Every field has an
individual reset. **Reset indicator appearance** restores the six tuning
defaults without changing style, Show, theme, or either layout. This tuning is
also session-only and never enters the saved profile.

In portrait, the Persona stage is a screen-width square, independent of control
height. Extra vertical room sits between the stage and the bottom-aligned deck.
If the square and controls exceed the available height, the scene scrolls so
Push to talk remains reachable. Traces use the square's center and the actual
deck position. Changing control size preserves that center, Halo diameter and
saved tuning values.

Landscape places a square Persona beside the existing Rocker deck. The deck
scrolls independently if its requested height exceeds the viewport. Portrait
and landscape have independent sizes, offsets, traces, colors, motion and light.
Rotate the connected phone to edit that orientation: the browser follows its
reported orientation and offers no orientation selector. Every edit and Save
carries the observed orientation and rotation epoch as well as the host's peer
generation; the host and phone refuse stale requests, including a round trip
back to the same orientation. Queued browser drafts are dropped on rotation.
Both layouts are stored on Save. Existing profiles remain portrait choices;
landscape starts with independent baseline settings and zero vertical offset.
The model supports swapping Persona and deck sides without mirroring icons or
reordering HUMAN/AGENT. Its `personaSide` control is deliberately hidden for now.

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
35–120%. Original keeps independent state sizes; Contained shares one size.
Vertical position applies to every state,
from −200 to +200 dp in 1 dp steps: negative moves up, positive moves down.
**Halo** switches between Original and Contained. Original retains its independent
78 / 56 / 78% portrait and 78 / 58 / 78% landscape defaults, with established transitions. Contained uses one size
for every state (78% initially), inward listening rings and pulse, softer speaking
motion and idle breathing. Its Ring spread defaults to 35%; Listening pulse,
Speaking motion and Idle breathing default to 25%, all adjustable from 0–100%.
At zero, spread collapses to the frame and that motion is removed. Increasing
spread/pulse moves the listening rings inward, without enlarging the frame.

Contained also has Speaking, Listening and Idle color pickers, initially the
app's violet `#bbaaff`, lime `#d4ff72` and warm white `#f0f2e9`. Disconnected stays
muted. Original's rendering and colors remain the comparison reference.
**Persona color** independently selects Fixed or Follow channels for
Contained. Following retains each chosen hue, adds a small shared sheen, quiets
closed channels and softly tints Idle toward the sole open channel. Gate/palette
changes blend over 900 ms. It does not retime the Rive animation. Reduced motion
removes drift and level modulation, retaining static gate color; backgrounding
stops the shared clock. Color updates retain the native view and its pose.

**Preview activity** offers Steady or Synthetic voice, a deterministic rehearsal
envelope with syllables and pauses. It never starts audio or inference and is
not saved. The light integration accepts the existing `CallUi` input/output level
envelopes; the production client does not yet use this experiment.

Switching variants keeps each variant's settings. Resets affect only the named
settings:

- **Reset size** restores Contained's shared size or only the currently selected
  Original state's size.
- **Reset position** restores −22 dp in portrait or 0 dp in landscape.
- **Reset animation** restores only Ring spread, Listening pulse, Speaking motion
  and Idle breathing.
- **Reset colors** restores only the three Contained colors.
- **Reset light** restores Still and 35% without changing Persona color behavior.
- **Reset color behavior** restores Follow channels in portrait or Fixed in landscape,
  without changing the chosen colors or light.
- **Reset traces** restores the route, stance, weight and offshoots, preserving glow.
- **Reset glow** restores only Background glow to zero.
- **Reset spacing** restores only the active orientation's spacing values.
  Each individual spacing reset changes only its named field.

Each reset preserves all other choices and remains unsaved until explicit Save.
Save profile keeps the control design,
all Halo sizes, motion, colors and the shared position.
Phone channel buttons and Push to talk also select synthetic states, which the
browser observes. Reattaching to a still-open preview retains its unsaved choices.
There is no microphone, playback, grant, controller, Codex,
WebRTC or voice-server connection in this preview.

Explicit Save writes a version 13 profile atomically on the phone. Root geometry,
`design`, `halo`, `spirit` and `personaSide` hold portrait; `landscape` holds the
independent landscape layout (integer-percent `scales`, offset, design, Halo,
spirit and side). Its root `design`
contains the fixed layout/header and Rockers, composition, controls height
and talk-button share, plus nested `traces` and `spacing` settings. Its `halo` stores variant, common Contained size, motion
and opaque RGB colors. Its `spirit` stores surface light, light strength and
Persona color behavior. Only after the phone confirms that exact profile does
the host write a matching, mode-0600
JSON copy to `profiles/<device-serial>.json`. Use `--save-to /absolute/file.json`
to choose another destination. The browser names that destination after Save.
A changed phone revision refuses a stale save. Browser edits and saves are also
bound to the observed connection, so delayed requests cannot run after reconnect.
Reconnection reads the current phone state; it never replays edits or Save.
An unconfirmed Save remains visible for review after recovery. A failed host write is reported
separately from a successful phone save. Resets and live edits do not persist
until Save. Version 1–12 phone profiles remain readable without rewriting.
Every retired button style maps to Rockers and every old composition to Traces
with baseline trace settings in memory. Version 9 preserves every existing trace
choice and adds only the two 100% spacing defaults. Version 1 seeds all three
Halo sizes; versions 1–3 use the control geometry baseline. Stored position
remains intact, with +35 dp when absent. Versions 4–10 retain saved control
dimensions. Versions 1–4 select Original, while versions 5–10 retain their Halo variant,
motion and colors. Versions 1–6 start with Still light and Fixed colors;
versions 7–10 keep their spirit settings. Version 11 preserves both existing layouts.
All versions before 12 gain only baseline scene spacing in memory, without
adopting the new portrait defaults. All profiles through version 12 migrate
to Custom padding in memory, keeping every previous spacing value. This also
applies to an absent legacy landscape layout. Fresh layouts use unified 16 dp
padding. Older profiles become version 13 only on
explicit Save. Profiles are ignored by Git.

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
Preview protocol 15 carries live/saved/default designs, sizes, vertical
offsets, Halo and `spirit` selections, plus transient
`connection: connected|connecting|disconnected`, `activity: steady|voice`,
`theme: bright|quiet|grayscale`,
`mutedPresence: off|tide|words|channels|labeled|contacts`, required
`presenceScope: both-muted|any-muted|always` (default `any-muted`), and required
`mutedTuning`. The latter has exactly integer `textSizeSp` (12–32),
`brightnessPercent` (−100–100), `driftPercent` (0–300), `breathPercent` (0–100),
`cycleSeconds` (6–30), and `motion: float|ripple`. Defaults are
14/0/100/0/14/float. Theme, indicator style, presence scope and muted tuning are required
session-root fields on Preview/PhoneState, never Layout. Protocol is 15;
saved profile is version 13 for unified padding; session tuning stays excluded.
`spirit` is `{surface: still|soft, strengthPercent: 0..100, persona: fixed|follow}`.
The design contract fixes `layout: studio`, `header: none`, `mute: rockers`,
`hold: rocker`, `composition: traces`,
and retains `controlsHeightDp` (integer 240–480)
and `holdSharePercent` (finite 30–60). The internal `hold` names retain their
protocol meaning; the visible and accessible control is Push to talk.
Nested `design.traces` has exactly `pattern: parallel|splayed|circuit`, integer
`stancePercent` (75–150), `personaSpacingPercent` and `footSpacingPercent`
(each 50–200), `weightPercent` (50–250), `offshootPercent` (0–100) and
`glowPercent` (0–100). Landscape and legacy migration use Parallel, 100%
stance/contact/foot/weight, zero offshoot and glow; new portrait defaults are
listed above. Required `design.spacing` has exactly integer `paddingDp` (−1–40),
`sideMarginPercent` and `edgeClearancePercent` (0–200), `sectionGapDp` (0–80),
`channelGapDp` (0–40), and `pushGapDp` (0–48). Padding −1 retains the legacy
custom fields; 0–40 selects unified padding while retaining those fields in the
wire/profile for restoration. Fresh defaults are 16/100/100/0/10/16.
Version 12 profiles require their original five-field spacing object and gain
only `paddingDp: -1` in memory; earlier profile shapes remain strict too.
Current and saved design snapshots copy nested choices independently.
Protocol 15's active fields describe the phone's visible orientation; it also
reports `orientation`, `orientationEpoch`, `personaSide`, `savedPersonaSide`,
`defaultPersonaSide`, `otherLayout` and `savedOtherLayout`. The phone alone
changes orientation; the host cannot select it. Version 13 profile receipts must
include both exact confirmed layouts, including design, geometry, side,
variant, motion, colors and spirit
before the host copy is written. Connection, activity, theme, indicator style, presence scope and
muted tuning are excluded from the profile. Use matching current host code and debug APK.

```sh
bun run test
bun run typecheck
```

These tests use fake phones, loopback sockets and disposable profile files.
Android instrumentation exercises the real abstract socket, authentication,
state selection, stale-save rejection, atomic profile receipts and shutdown,
using a unique cache file. Tests never overwrite the operator's tuning profile.
The existing Halo animation regressions still run against the same renderer.

See [ADR 0041](../../docs/adr/0041-host-persona-configurator.md).

Contained patches a checksum-verified in-memory copy of the bundled Halo. It
never writes the original asset or accepts an asset path/URL. The changed bytes
and renderer stay in debug builds. See [Persona provenance and notices](../third-party/persona-halo.md)
for creator attribution, code/runtime licenses, and the external asset's published
license evidence.
