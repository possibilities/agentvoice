# AgentVoice design studio

A separate host browser app for comparing native Android voice controls and
tuning the existing Persona Halo. The phone renders the interactive demo;
the browser separates Appearance, orientation-local Layout, Shared spacing and
Shared session controls, plus Save profile.
No tuning panel obscures the phone.

Fresh portrait previews use provisional studio defaults: Contained at 78%,
Original state sizes 78 / 56 / 78%, vertical offset −22 dp, controls height
387 dp and Push-to-talk share 40.9%. Traces use Parallel, 130% stance, 175%
weight, zero glow and 100% contact/foot spacing. Light is Still
at 35%; Persona color follows channels. Both orientations inherit this fresh
appearance. Landscape keeps its local size and layout baseline below. These
experimental defaults do not change the production app.

Appearance has four groups: **Traces**, **Background glow**, **Halo appearance**
(variant, motion and colors), and **Light and color behavior** (button light and
Persona color response). Each shows **Shared** or **Portrait/Landscape only**.
**Customize Portrait/Landscape** snapshots the current effective group for that
orientation. Unchecking discards that local group and returns it to the existing
shared choice. Editing a Shared group updates both inheriting orientations; an
overridden orientation keeps its own choice. All trace properties, including
reach, fade and contact/foot spacing, belong to the Traces group; glow is separate.
Persona sizes, scales, positions, button dimensions and side stay local to their
orientation. All scene spacing is shared, without an override option. Theme and synthetic session controls apply to both
orientations but are never saved.

Both mute buttons and **Push to talk** use Rockers. Press and keep the talk
surface down to talk; release to mute. Active styling stays dark with focused
lime accents. There are no button-style, preset or header selectors.

**Traces** is the fixed composition. **Route** compares Parallel (the baseline
paired routes), Splayed (a wider fan of routes), and Circuit (staggered mechanical
steps). **Stance** spans 75–150% of the baseline; **Trace weight** spans 50–250%,
with 100% equal to 1.2 dp. **Persona contact spacing** and **Button foot spacing** each
span 50–200%, default 100%. They separate neighboring traces within each bundle
at its upper and lower ends; Stance moves the bundles themselves. Foot spacing
remains fixed when stance hits a button edge. At large Persona sizes, protected
center clearance can limit upper spacing or make it depend on the foot positions.
The other compositions and their selector are removed.

**Reach into Persona** moves the trace endpoint relative to its existing join
from −40 to +120 dp. Zero keeps the existing reach; positive reaches farther
under Persona and negative pulls back. **Fade length** spans 0–80 dp; zero gives
a hard end. **Tip opacity** spans 0–100% and lifts the minimum opacity at the tip.
The defaults preserve the existing fade: reach 0 dp, fade length 12 dp and tip
opacity 0%, yielding transparency at the join, 72% at 2 dp and full opacity at
12 dp. Each control has an individual reset. **Reset traces** also resets all
three, retaining Background glow. These share the Traces group scope and remain
unsaved until explicit Save.

Routes now reach the selected Persona size and position instead of ending a
fixed distance above the deck. Their geometry and soft clear aperture follow
settings, never animated pixels, and preserve the transparent center and native
glow. Original uses one conservative attachment envelope across its three state
sizes; a deliberately smaller state can sit farther from its routes. When that
envelope reaches the deck, routes collapse and can disappear even while the
current smaller ring remains above it. Contained's single size across states avoids
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

**Controls height** in portrait becomes **Controls width** in landscape
(240–480 dp). Landscape width fits the available control lane and anchors to its
outer edge; height fills the visible safe area inside shared top/bottom padding.
Persona size and manual position do not move when deck width changes. **Push-to-talk share** spans 30–60%: it is
height share in portrait and width share in landscape. Portrait gives the mute
row the remaining height after its join; landscape gives the stacked mute column
the remaining width after its join. Landscape retains its independent 262 dp
width and approximately 44.3% share baseline (`116 / 262 × 100`). **Reset button
sizes** restores only these two sliders to the visible orientation's defaults,
keeping spacing, composition, light and Persona tuning.

**Shared spacing** offers one **Padding** slider (0–40 dp) for minimum outer control
space and both button gaps. Fresh layouts start at 16 dp. Older profiles show
**Custom** and preserve their separate side, edge and button-gap settings until
you adjust Padding; the slider rests at 16 without applying it. In portrait,
controls stay inside the visible safe area; use Persona vertical position to
adjust the space above them. **Section separation** is shown only in landscape,
where it retains its existing 0–80 dp minimum extra gap between Persona and
controls, with zero as its default. Hiding it in portrait retains its stored value. Each slider has its own reset. **Reset spacing** restores
Padding to 16, section separation to zero, and the stored legacy baseline values
for both orientations. The entire spacing object is shared: padding, legacy
custom side/edge spacing, both button gaps and section separation. Changing or
resetting it in either orientation updates both layouts. These controls sit
outside the orientation-only Layout section. Spacing remains unsaved until Save.

**Switch sounds** is a shared, saved choice for both orientations, independent
of appearance overrides. Choose **Off**, **Rocker 29** or **Rocker 13**, then set
**Level** from 0–100%. Fresh and migrated previews start Off at 70%; **Reset
sounds** restores both values. Off retains the selected level. Use the phone's
actual controls to audition: both mute switches share the same on/off sound pair, and Push to talk
has its own press and release pair. Playback also follows the phone's media
volume. Selecting a family, moving Level, resetting, rotating or reconnecting
does not audition audio. The browser contains no player or audio asset routing.
Changes remain unsaved until explicit Save.

**Show push to talk** is a shared session choice, initially on. Turning it off
hides Push to talk and its connector; the mute buttons fill the selected deck. In landscape the stacked mute column
fills its width and the height inside shared padding. The
Push-to-talk share slider becomes disabled while its value
is retained for when the button returns. This choice survives rotation and
reconnection, but is excluded from Save. It changes only the design preview.

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

In portrait, controls are bottom-aligned inside the visible safe area with the
selected padding; the portrait page does not scroll. The Persona stage remains
a screen-width square, independent of control height, with the selected size
and vertical offset. Its position is not moved automatically to fit the deck.
Use Persona vertical position to adjust clearance above the controls. Portrait
section separation is retained in state and profiles but has no layout effect.
Traces use the square's center and the actual deck position. Changing control
size preserves that center, Halo diameter and saved tuning values.

Landscape places a square Persona beside a two-column Rocker deck. The mute
buttons stack top/bottom in the column nearest Persona, with full-height Push to
talk in the far-right column. A future opposite Persona side mirrors the column
placement while retaining the mute order. The full deck fits the viewport and
does not scroll. Hiding Push to talk removes its column and connector, leaving
the stacked mute column to fill the deck. Portrait and landscape have independent
sizes and layout geometry; their appearance
groups inherit shared choices unless explicitly customized. The position slider
moves Persona vertically in portrait and horizontally in landscape. Both axes
span−200 to200 dp; landscape preserves but does not render its historical
vertical offset.
Rotate the connected phone to edit that orientation: the browser follows its
reported orientation and offers no orientation selector. Every edit and Save
carries the observed orientation and rotation epoch as well as the host's peer
generation; the host and phone refuse stale requests, including a round trip
back to the same orientation. Queued browser drafts are dropped on rotation.
Both effective layouts, their override flags and the shared base are stored on
Save. Legacy portrait appearance seeds that base; untouched landscape appearance
inherits it while explicit landscape differences stay local.
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

- **Reset size** restores Contained's orientation-local size or only the currently selected
  Original state's size.
- **Reset position** restores the active axis: −22 dp vertically in portrait or
  0 dp horizontally in landscape. The other stored axis remains intact.
- **Reset animation** restores only Ring spread, Listening pulse, Speaking motion
  and Idle breathing.
- **Reset colors** restores only the three Contained colors.
- **Reset light** restores Still and 35% without changing Persona color behavior.
- **Reset color behavior** restores the shared Follow channels default,
  without changing the chosen colors or light.
- **Reset traces** restores the route, stance, weight, contact/foot spacing and trace-tip settings, preserving glow.
- **Reset glow** restores only Background glow to zero.
- **Reset spacing** restores the shared portrait spacing defaults in both layouts.
  Each individual spacing reset changes only its named field.

Appearance resets use the shared default group, including when the group has an
orientation override. Spacing resets use the shared defaults reported in
`defaultDesign.spacing` in either orientation. Size, axis and button-size resets
use the active orientation defaults. Each reset preserves all other choices and remains unsaved
until explicit Save.
Save profile keeps the control design,
all Halo sizes, motion, colors and both local position axes.
Phone channel buttons and Push to talk also select synthetic states, which the
browser observes. Reattaching to a still-open preview retains its unsaved choices.
The preview has no microphone, voice playback, grant, controller, Codex,
WebRTC or voice-server connection. Optional switch effects play locally on the
phone only when its controls are used.

Explicit Save writes a version 17 profile atomically on the phone. Root geometry,
`design`, `halo`, `spirit` and `personaSide` hold effective portrait values;
`landscape` holds effective landscape values (integer-percent `scales`, both
offsets, design, Halo, spirit and side). Root and landscape each include sorted
`appearanceOverrides`; root `sharedAppearance` stores the shared base. Root
`sounds` stores the shared sound family and level. Both layouts, shared
appearance and sound settings must match the captured save request, even if
the phone rotates before its receipt arrives. Its root `design`
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
until Save. Version 1–16 phone profiles remain readable without rewriting.
Every retired button style maps to Rockers and every old composition to Traces
with baseline trace settings in memory. Version 9 preserves every existing trace
choice and adds only the two 100% spacing defaults. Version 1 seeds all three
Halo sizes; versions 1–3 use the control geometry baseline. Stored position
remains intact, with +35 dp when absent. Versions 4–10 retain saved control
dimensions. Versions 1–4 select Original, while versions 5–10 retain their Halo variant,
motion and colors. Versions 1–6 start with Still light and Fixed colors;
versions 7–10 keep their spirit settings. Version11 preserves both existing layout geometries.
All versions before 12 gain only baseline scene spacing in memory, without
adopting new geometry defaults. All profiles through version 12 migrate
to Custom padding in memory, keeping the raw saved spacing values. This also
applies to an absent legacy landscape layout. Fresh layouts use unified 16 dp
padding. Profiles through version 13 gain only the three baseline trace-tip defaults
in memory. Sharing migration seeds the shared base from legacy portrait
appearance. A legacy landscape group inherits when it equals either portrait or
the old canonical defaults; any other group keeps an explicit landscape override.
Old defaults mean Parallel, 100% stance/weight/contact/foot spacing, no offshoots
or glow, reach/fade/tip 0/12/0, Original Halo with motion35/25/25/25 and the existing
colors, and Still35/Fixed spirit. Halo size is excluded from this comparison. An
absent landscape uses those canonical defaults and inherits portrait appearance.
This migration changes only in-memory effective appearance and flags; local
geometry and saved bytes remain intact. Profiles through version 15 retain their
exact saved shape and gain Off/70 sound settings in memory. Older profiles become
version 17 only on explicit Save. Legacy profiles through16 use portrait spacing
for both effective layouts; the previous landscape spacing stays in the untouched
raw file until Save. Profiles are ignored by Git.

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
successive peers from the same host run. Incoming debug phone replies are
limited to less than16 KiB; browser requests and outbound command bounds remain
8 KiB. Profile parsing allows up to8 KiB. Commands can only read preview state, select a bounded design,
select/resize/position Halo, select shared switch sounds, or save its fixed
private profile. The phone exposes
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
Preview protocol19 carries live/saved/default designs, sizes, vertical and
horizontal offsets, Halo and `spirit` selections, plus transient
`connection: connected|connecting|disconnected`, `activity: steady|voice`,
`theme: bright|quiet|grayscale`,
`mutedPresence: off|tide|words|channels|labeled|contacts`, required
`presenceScope: both-muted|any-muted|always` (default `any-muted`), and required
`mutedTuning`. The latter has exactly integer `textSizeSp` (12–32),
`brightnessPercent` (−100–100), `driftPercent` (0–300), `breathPercent` (0–100),
`cycleSeconds` (6–30), and `motion: float|ripple`. Defaults are
14/0/100/0/14/float. Theme, indicator style, presence scope and muted tuning are required
session-root fields on Preview/PhoneState, never Layout. Protocol is19;
saved profile is version17 without retired offshoot settings;
session tuning stays excluded.
`spirit` is `{surface: still|soft, strengthPercent: 0..100, persona: fixed|follow}`.
The design contract fixes `layout: studio`, `header: none`, `mute: rockers`,
`hold: rocker`, `composition: traces`,
and retains `controlsHeightDp` (integer 240–480)
and `holdSharePercent` (finite 30–60; height share in portrait, width share in
landscape). The internal `hold` names retain their
protocol meaning; the visible and accessible control is Push to talk.
Nested `design.traces` has exactly `pattern: parallel|splayed|circuit`, integer
`stancePercent` (75–150), `personaSpacingPercent` and `footSpacingPercent`
(each 50–200), `weightPercent` (50–250) and
`glowPercent` (0–100), `reachDp` (−40–120), `fadeLengthDp` (0–80) and
`tipOpacityPercent` (0–100). The last three default to 0/12/0. Profiles through13
retain their exact previous trace shapes and gain these defaults in memory.
The old canonical baseline uses Parallel, 100%
stance/contact/foot/weight, zero offshoot and glow; fresh shared defaults are
listed above. Required `design.spacing` has exactly integer `paddingDp` (−1–40),
`sideMarginPercent` and `edgeClearancePercent` (0–200), `sectionGapDp` (0–80),
`channelGapDp` (0–40), and `pushGapDp` (0–48). Padding −1 retains the legacy
custom fields; 0–40 selects unified padding while retaining those fields in the
wire/profile for restoration. Fresh defaults are 16/100/100/0/10/16.
Version 12 profiles require their original five-field spacing object and gain
only `paddingDp: -1` in memory; earlier profile shapes remain strict too.
Current and saved design snapshots copy nested choices independently. All six
`design.spacing` fields are shared without an override. Protocol19 requires
current spacing to match `otherLayout` and saved spacing to match
`savedOtherLayout`; profile17 requires root and landscape spacing equality.
Legacy raw profiles through16 remain strict and unchanged, while their effective
landscape spacing is copied from portrait. Resets use portrait spacing defaults
in both orientations.
Protocol19's active fields describe the phone's visible orientation; it also
reports `orientation`, `orientationEpoch`, `personaSide`, `savedPersonaSide`,
`defaultPersonaSide`, `otherLayout` and `savedOtherLayout`. The phone alone
changes orientation; the host cannot select it. Version17 profile receipts must
include both exact confirmed layouts, including design, geometry, side,
variant, motion, colors, spirit, override flags, shared appearance and sounds before the
host copy is written. `horizontalOffsetDp` is an integer from−200 through200.
Portrait position edits use `verticalOffsetDp`; landscape edits use
`horizontalOffsetDp`. Landscape rendering ignores its retained historical vertical
offset. `appearanceOverrides` is a sorted, unique subset of
`["glow", "halo", "spirit", "traces"]`. `sharedAppearance` has exactly `traces`
(without glow), `glowPercent`, `halo` (without size), and `spirit`. Preview requests
contain effective values and flags, never the shared base. The phone alone returns
`sharedAppearance`, `savedSharedAppearance`, `defaultSharedAppearance`,
`savedAppearanceOverrides`, `savedHorizontalOffsetDp` and
`defaultHorizontalOffsetDp`. Shared root `sounds`, `savedSounds` and
`defaultSounds` have exactly `family: off|rocker-29|rocker-13` and integer
`volumePercent` (0–100). Preview requires `sounds`; Layout and appearance groups
never include it. Current live protocol19 is strict; Android restoration from
protocol17 or earlier supplies Off/70. Profiles16–17 require root sounds, while
profiles through version 15 forbid the field and default only in memory.
Protocol19 requires the shared session-root boolean `showPushToTalk`; it has no
saved/default counterpart and never appears in Layout or profiles. Native
restoration from protocol18 or earlier starts with Push to talk shown.
Profile17 and current traces reject `offshootPercent` everywhere. Legacy
profiles that contain offshoots retain and validate their original field, then
strip it from effective root, landscape and shared appearance in memory. Other tuning, sounds,
explicit override flags and the original saved files stay intact until Save.
Push-to-talk visibility, connection, activity, theme, indicator style, presence
scope and muted tuning are excluded from the profile. Use matching current host code and debug APK.

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

The retained wire/profile name `controlsHeightDp` stores the orientation's primary
deck extent: portrait height or landscape width. Values, saved files and profile
version stay unchanged; the studio labels the dimension for the visible
orientation. Reset button sizes restores its respective extent/share defaults.
