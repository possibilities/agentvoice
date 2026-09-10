# AgentVoice design studio

A separate host browser app for comparing native Android voice controls and
tuning the existing Persona Halo. The Android target renders the interactive demo;
the browser separates Appearance, orientation-local Layout, Shared spacing and
Shared session controls, plus **Save complete design**.
No tuning panel obscures the preview.

For agent-driven design and verification, take explicit turns with the human on
the physical phone. Notify when requesting access and when returning it; wait for
a handoff before device operations. Preserve each target's latest draft/checkpoint
and the operator's running host. Emulators are no longer used. Use a separate
scratch export path for tests, never the operator's saved design path.

## Continue from production

On first use only, Studio seeds its draft from the bundled production design.
After that it always opens the last configured draft, even after a new production
release or Studio upgrade. Only **Reset to production** adopts production again. Its complete
baseline is `android/design/shipping-profile.json`; the generated debug-only
`StudioProduction` preserves both layouts, shared appearance and exact override
flags, all seven visual choices, both shown/hidden PTT extents and sounds.

Every acknowledged design edit is atomically autosaved on the phone in
`files/persona-studio-draft.json`. It survives process death, force-stop,
reopening Studio, host restart and same-production APK reinstall. The host
never replays stale browser edits after reconnect. Simulation mode/gates/activity,
held pointers and bridge capabilities are excluded from this durable draft.
Activity-local rehearsal continuity may survive recreation; its older Bundle
cannot replace the durable design even after production changes.

**Reset to production** restores the entire shipped design in both orientations
as one revision- and orientation-fenced command. It preserves the phone's current
orientation and the explicit saved checkpoint. Granular reset controls remain.
**Save complete design** exports the complete working design to the phone checkpoint
`files/persona-tuning.json` and the host JSON; only Save writes those files.
“Draft kept on phone · not exported” distinguishes autosave from that checkpoint.
A failed draft write does not apply/acknowledge the edit; a failed load stays
visible and retains the unreadable file for recovery or explicit reset.

**AgentVoice** and **AgentVoice Studio** are separate installed apps with separate
storage. The local `production` build retains `com.arthack.agentvoice.dev` so the
real app keeps its grant and permission state. The `studio` build uses
`com.arthack.agentvoice.studio`, a distinct launcher and no microphone/network
permissions. Its only launcher opens the synthetic Persona preview. Install both
with `:app:assembleProduction :app:assembleStudio`; the host command targets Studio.
Neither installation nor promotion resets an existing Studio draft. Draft version2
removes automatic-production-refresh semantics; version1's old marker is ignored
without rewriting its file on load. The former `shipping.ts release` command is
removed because a code release must never discard Studio work.

Opening Studio on the phone restores its design independently of the browser.
Keep the host configurator running to use the browser controls. Studio stores
that host's private synthetic-bridge binding separately from the draft, so an
ordinary launcher open after process death reconnects the same browser without
replaying edits. A host restart prints a new local URL; it observes the existing
draft. This binding is never a production device grant and is never exported.
Production APKs contain neither Studio's bridge/store nor its full reset snapshot.

The promoted baseline currently selects Contained, Splayed traces, i cons channel
icons, Relay Aperture launcher and Rocker 13 sounds. Numeric reset values follow
the complete promoted profile rather than historical experiment defaults below.

Appearance has four groups: **Traces**, **Background glow**, **Halo appearance**
(variant, motion and colors), and **Light and color behavior** (button light and
Persona color response). Each shows **Shared** or **Portrait/Landscape only**.
**Customize Portrait/Landscape** snapshots the current effective group for that
orientation. Unchecking discards that local group and returns it to the existing
shared choice. Editing a Shared group updates both inheriting orientations; an
overridden orientation keeps its own choice. All trace properties, including
reach, fade and contact/foot spacing, belong to the Traces group; glow is separate.
Persona sizes, scales, positions, button dimensions and side stay local to their
orientation. All scene spacing is shared, without an override option. Theme applies to both orientations and is saved. Synthetic session controls
also apply to both orientations but remain transient.

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
kept in the working draft; explicit Save updates the exported checkpoint.

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
(160–1600 dp). **With push to talk** and **Without push to talk** each keep their
own extent in each orientation: four independently saved values. The slider
edits only the visible choice. Fresh portrait values are 387 dp and landscape
values 262 dp; older profiles seed each hidden extent from that orientation's
stored extent. Switching visibility never copies one choice over the other.

Only the physical viewport and Shared padding limit the rendered deck. Landscape
height fills the padded viewport; there is no half-screen or Persona-lane width
cap. Persona size and position remain fixed, and a larger control deck may overlap
in front of it. Use Persona position to set separation. **Push-to-talk share**
spans 30–60%: height share in portrait and width share in landscape. **Reset button
sizes** resets only the active extent. It resets the PTT share only when PTT is
shown; hidden mode preserves the stored share and the inactive extent.

**Shared spacing** offers one **Padding** slider (0–40 dp) for minimum outer control
space and both button gaps. Fresh layouts start at 16 dp. Older profiles show
**Custom** and preserve their separate side, edge and button-gap settings until
you adjust Padding; the slider rests at 16 without applying it. In portrait,
controls stay inside the visible safe area; use Persona vertical position to
adjust the space above them. Section separation is hidden because it no longer
constrains either layout; its stored value remains in shared spacing for legacy
compatibility. Persona position controls separation. **Reset spacing** restores
Padding to 16, the retained section gap to 0, and legacy baseline fields for both
orientations. The entire spacing object is shared: padding, legacy
custom side/edge spacing, both button gaps and section separation. Changing or
resetting it in either orientation updates both layouts. These controls sit
outside the orientation-only Layout section. Spacing is autosaved in the draft; Save exports it.

**Switch sounds** is a shared, saved choice for both orientations, independent
of appearance overrides. Choose **Off**, **Rocker 29** or **Rocker 13**, then set
**Level** from 0–100%. Fresh and migrated previews start Off at 70%; **Reset
sounds** restores both values. Off retains the selected level. Use the phone's
actual controls to audition: both mute switches share the same on/off sound pair, and Push to talk
has its own press and release pair. Playback also follows the phone's media
volume. Selecting a family, moving Level, resetting, rotating or reconnecting
does not audition audio. The browser contains no player or audio asset routing.
Changes remain kept in the working draft; explicit Save updates the exported checkpoint.

**Show push to talk** is a shared session choice, initially on. Turning it off
hides Push to talk and its connector and selects the separately saved hidden
extent. Landscape height continues to follow shared padding. The
Push-to-talk share slider becomes disabled while its value
is retained for when the button returns. This choice survives rotation and
reconnection and process restart, and is included in Save. It changes only the design preview until promotion.

**Theme** offers Bright (default), Quiet and Grayscale. **Center indicator**
compares Off, Tide (original), Words, Channel icons, Icons + words and Contacts.
Tide remains the original both-muted indicator. Words shows the live/muted
channel truth; Channel icons pairs the microphone on the left with the speaker
on the right; Icons + words adds compact live/muted captions. Contacts keeps
Human left and agent right: joined contacts are live and a lifted contact is muted.

The new styles offer **Show**: Both muted, Either muted (default), or Always.
This selector stays hidden for Tide and Off, retaining its choice for the next
new-style selection. Tide always keeps its existing both-muted behavior.
Theme, indicator style and Show are shared visual choices: they survive orientation
changes, process restart and ordinary tuning resets, and are included in Save complete design.

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
saved in profile 19 alongside style, scope, theme and visibility. The adopted
reset baseline is generated from the shipping profile; the values above describe
the original pre-adoption tuning baseline.

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

Install the current AgentVoice Studio APK on an explicitly selected, ADB-authorized
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
foreground. Return to **AgentVoice Studio** on the phone when ready.
Port 4317 is the default; `--port 0` selects an available port. Ctrl+C stops the
host app and removes only its own ADB forward. The preview stays on the phone.
After force-stop or task dismissal, open AgentVoice Studio again and the running
host reconnects. Restarting the host command establishes a fresh binding and URL
while retaining every design value.

The command opens the debug-only **Halo preview** activity. It loads the phone's
existing private `files/persona-tuning.json` as the exported checkpoint without rewriting it, then loads the working draft (or seeds production once). Size remains
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
use the active orientation defaults. Each reset preserves all other choices and remains kept in the working draft; explicit Save updates the exported checkpoint.
Save complete design keeps the control design,
all Halo sizes, motion, colors and both local position axes.
Phone channel buttons and Push to talk also select synthetic states, which the
browser observes. Reattaching to a still-open preview retains its unsaved choices.
The preview has no microphone, voice playback, grant, controller, Codex,
WebRTC or voice-server connection. Optional switch effects play locally on the
phone only when its controls are used.

Explicit Save writes a version 20 profile atomically on the phone. Root geometry,
`design`, `halo`, `spirit` and `personaSide` hold effective portrait values;
`landscape` holds effective landscape values (integer-percent `scales`, both
offsets, design, Halo, spirit and side). Root and landscape each include sorted
`appearanceOverrides`; root `sharedAppearance` stores the shared base. Root
`sounds` stores the shared sound family and level. Root `icons`, `theme`,
`mutedPresence`, `presenceScope`, `mutedTuning`, `launcher` and `showPushToTalk` capture the
remaining visual choices. Both layouts and every shared visual and sound
setting must match the captured save request, even if
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
separately from a successful phone save. Resets and live edits persist in the
working draft without altering the exported checkpoint. Version 1–18 phone profiles remain readable without rewriting.
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
version 20 only on explicit Save. Legacy profiles through16 use portrait spacing
for both effective layouts; the previous landscape spacing stays in the untouched
raw file until Save. Profiles are ignored by Git.

The real voice client and release APK use the adopted shipping profile through
generated constants and shared renderers. Saving a later Studio choice does not
adopt it into the product; promotion remains explicit. Original's native Halo
adapter retains its rendering and state-transition timing; Contained has a
separate shared renderer.

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
renders shared `PreviewStudioScreen` with synthetic state; production supplies
actual call state to the same renderer. The studio
composes a connection notice and controls around the existing native Halo.
Preview protocol26 carries live/saved/default designs, sizes, vertical and
horizontal offsets, Halo and `spirit` selections, plus transient
`connection: connected|connecting|disconnected`, `activity: steady|voice`,
`theme: bright|quiet|grayscale`,
`mutedPresence: off|tide|words|channels|labeled|contacts`, required
`presenceScope: both-muted|any-muted|always` (default `any-muted`), and required
`mutedTuning`. The latter has exactly integer `textSizeSp` (12–32),
`brightnessPercent` (−100–100), `driftPercent` (0–300), `breathPercent` (0–100),
`cycleSeconds` (6–30), and `motion: float|ripple`. Adopted defaults are
32/−19/196/100/13/ripple. Theme, indicator style, presence scope and muted tuning are required
session-root fields on Preview/PhoneState, never Layout. Protocol is26;
saved profile is version20 with separately saved shown/hidden extents and all
shared visual settings.
`spirit` is `{surface: still|soft, strengthPercent: 0..100, persona: fixed|follow}`.
The design contract fixes `layout: studio`, `header: none`, `mute: rockers`,
`hold: rocker`, `composition: traces`,
and requires `controlsHeightDp` and `controlsWithoutPttDp` (integers160–1600)
and `holdSharePercent` (finite 30–60; height share in portrait, width share in
landscape). The internal `hold` names retain their
protocol meaning; the visible and accessible control is Push to talk.
Nested `design.traces` has exactly `pattern: parallel|splayed|circuit`, integer
`stancePercent` (75–150), `personaSpacingPercent` and `footSpacingPercent`
(each 50–200), `weightPercent` (50–250) and
`glowPercent` (0–100), `reachDp` (−40–120), `fadeLengthDp` (0–80) and
`tipOpacityPercent` (0–100). The adopted last three defaults are −9/80/0. Profiles through13
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
`design.spacing` fields are shared without an override. Protocol21 requires
current spacing to match `otherLayout` and saved spacing to match
`savedOtherLayout`; profiles17–18 require root and landscape spacing equality.
Legacy raw profiles through16 remain strict and unchanged, while their effective
landscape spacing is copied from portrait. Resets use portrait spacing defaults
in both orientations.
Protocol26's active fields describe the phone's visible orientation; it also
reports `orientation`, `orientationEpoch`, `personaSide`, `savedPersonaSide`,
`defaultPersonaSide`, `otherLayout` and `savedOtherLayout`. The phone alone
changes orientation; the host cannot select it. Version20 profile receipts must
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
never include it. Current live protocol26 is strict; Android restoration from
protocol17 or earlier supplies Off/70. Profiles16–17 require root sounds, while
profiles through version 15 forbid the field and default only in memory.
The shared root boolean `showPushToTalk` appears in profiles19–20 and in the
`savedAppearance`/`defaultAppearance` snapshots; it never appears in Layout. Native
restoration from protocol18 or earlier starts with Push to talk shown.
Profiles17–18 and current traces reject `offshootPercent` everywhere. Legacy
profiles that contain offshoots retain and validate their original field, then
strip it from effective root, landscape and shared appearance in memory. Other tuning, sounds,
explicit override flags and the original saved files stay intact until Save.
Connection, activity, synthetic mode and live call gates remain excluded from
the profile. Profile20 saves launcher choice, push-to-talk visibility, icons, theme,
indicator style, presence scope and muted tuning. Use matching current host code and debug APK.

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
never writes the original asset or accepts an asset path/URL. The selected Contained renderer also ships; the patch remains in memory and
the bundled source asset stays unchanged. See [Persona provenance and notices](../third-party/persona-halo.md)
for creator attribution, code/runtime licenses, and the external asset's published
license evidence.

The retained wire/profile name `controlsHeightDp` stores the PTT-shown primary
extent: portrait height or landscape width. `controlsWithoutPttDp` stores the
corresponding hidden extent. The studio labels the current dimension and
visibility scope. Reset button sizes restores only that extent, plus share when
PTT is shown.

Current protocol26 and profiles18–20 require both extent fields. Legacy profiles
through17 keep their strict original design fields and 240–480 dp bounds, and
their raw saved bytes remain untouched. Effective readers seed
`controlsWithoutPttDp` from that orientation’s `controlsHeightDp`. Native
restoration from protocol19 or earlier does the same. Only explicit Save writes
profile20.


## Icon auditions and launcher studies

The Shared appearance controls offer a coherent channel pair (Current, Engraved,
Phosphor Bold, Phosphor Fill, Boatman or i cons) and an independent push-to-talk icon (Current
press, Contact or Matching microphone). Matching microphone follows the live
microphone from the selected pair. Each selector resets independently to its adopted default (i cons channels,
Current push symbol).
Selection remains while muted indicators are Off or Push to talk is hidden.
“Credits on phone” opens native icon credits through a one-shot, generation- and
orientation-fenced request. It changes no preview settings, profile or dirty state;
the button is disabled while disconnected or another request is pending.
Protocol26 requires exactly `icons: { channels, push }` at the shared root;
rotation, reconnect and activity restoration retain it. Restoration from
protocol20 or earlier supplies `current/current`. Profile19 saves these choices and includes them in dirty comparison. Production
defaults change only through explicit promotion. Legacy profiles through18
remain strict and preserve their original bytes until an explicit Save.

The Launcher gallery offers Current waveform, Duplex Halo, Relay Aperture and
Voice Carrier. Its selected card updates the shared launcher setting and becomes
dirty until **Save complete design**. The complete save includes the gallery
choice with both layouts and shared choices. Reload, rotation and reconnect observe the retained selection;
disconnected cards are disabled and no selection is replayed automatically.
Reset launcher uses the adopted shipping default. Choosing a card does not
install an APK; explicit promotion generates the selected launcher resources.
Circle and squircle previews expose the central72 units of each108-unit source.
Monochrome previews use illustrative tints.

Assets are served from a fixed capability-scoped local allowlist. Phosphor source
and MIT links are pinned HTTPS URLs; Original denotes project-authored artwork,
not a claim of CC0 licensing. Boatman and i cons use acquired Noun Project
artwork under CC BY3.0; the panel names both source assets, their creator and
license, and describes the modifications. Matching microphone credits only
its source mic. See [icon preview provenance](public/icon-previews/README.md).


## Complete saves and shipping promotion

Protocol24 adds durable working drafts and the atomic `resetProduction` command.
It keeps profile20 unchanged and rejects an older phone bridge before claiming
autosave support. `preview` acknowledges only after the draft write succeeds.


Profile19 added six required shared appearance fields at the root: `icons`,
`theme`, `mutedPresence`, `presenceScope`, `mutedTuning`, and `showPushToTalk`.
The existing layouts, appearance overrides, shared base and sounds retain their
contracts. Protocol22 adds required `savedAppearance` and `defaultAppearance`
objects, each containing exactly those six fields in that historical protocol.
Protocol23 and profile20 added `launcher` as the seventh shared appearance
field: `current`, `duplex-halo`, `relay-aperture`, or `voice-carrier`. Profile19
remains strict and contains no launcher field; its effective launcher defaults
to Current only in memory. Existing files are upgraded only by explicit Save. Dirty comparison checks every
saved appearance value. Icon and muted-tuning resets use adopted defaults;
Reset shared choices restores all seven together without changing geometry or
sounds. Runtime connection, activity, synthetic mode and call gates are never part of Save.

Shipping is explicit and leaves Studio available for a later promotion:

```sh
bun android/configurator/src/shipping.ts promote --profile saved-profile.json --live-state captured-studio-state.json
bun android/configurator/src/shipping.ts generate
bun android/configurator/src/shipping.ts generate --check
```

Promotion accepts strict profiles18–20. Profiles19–20 can supply their own saved
appearance without another flag. A legacy profile requires an explicit
`--session <seven-field-json>`, `--live-state <captured-state-json>`, or
`--default-session`. A live capture must match both saved layouts and sounds;
a mismatch stops promotion for review. Promotion never writes either input.

`android/design/shipping-profile.json` is a complete, independently parseable
profile20. The separate `shipping-provenance.json` retains the exact source
profile text/SHA and source-capture SHA, plus the adopted appearance snapshot.
The source's original Save timestamp is retained. Promotion updates the bundled production reset target; it never changes a
working Studio draft. Regeneration checks the canonical
profile against its promotion receipt before producing typed Kotlin defaults.
The generated file inventory allows later promotion to remove only previously
generated resources. Release includes only the adopted channel family, selected
sound quartet, selected launcher resources and applicable notices; Studio keeps all audition assets.

`--check` compares deterministic generated bytes and reports missing/stale
outputs without writing. Tests use disposable output roots and preserve source
profiles. The generator does not install an APK, contact a phone or start audio.


Launcher generation reads the original local108-unit SVG paths, independent of
the obsolete main launcher drawable. It emits only the chosen foreground,
monochrome layer, fixed background color, adaptive resources for API26/API33,
and a legacy vector using the central72-unit crop. The manifest references
`@mipmap/ic_agentvoice`; API33 adds the monochrome layer while older adaptive
resources retain foreground/background only. Unsupported SVG geometry fails
explicitly rather than being silently simplified. Launcher selection is included
in generated `ShippingDesign.launcher` and the owned generated-file inventory.


## Connection setup rehearsals

Protocol26 carries the transient `connectionPreview` state and an orientation-fenced
`connectionPreview` command (`scene`, `orientation`, `orientationEpoch`). The host
also checks connection generation. **Connection setup → App view** opens the
shared Relay Aperture overlay on the phone. Camera explanation, denied/unavailable,
invalid/found, securing, connecting, rejected, storage, microphone and failure
scenes are deterministic mock rehearsals. Only **Live camera** requests
camera permission and binds the rear camera for a preview; it has no analyzer.
Closing the overlay or backgrounding releases it. No QR parsing, credential
read/write, server request or microphone is used by Studio.

This rehearsal is excluded from draft/profile/dirty comparison and resets on a
new activity instance. All configured design values and saved bytes remain intact.
CameraX is shared app code; Studio continues to remove network and microphone
permissions. Production enrollment uses the native app's QR flow; Studio's
connection scenes are preview-only and never enroll a device.
