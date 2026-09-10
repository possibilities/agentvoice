# 0041: Configure the native phone preview from a host browser

Accepted 2026-09-08 at the operator's request to extract the existing configurator
before expanding its scope. Supersedes the on-phone tuning overlay in
[ADR 0035](0035-native-android-voice-client.md).

`android/configurator/` is a separate Bun browser app, launched explicitly with
`bun run android:configure --device <adb-serial>`. Its Controls panel owns
trace routes and background glow, surface light, control height and talk-button share; its
Persona panel owns connection preview, state, variant, size, position, motion
and colors. Save profile retains both panels' design and geometry. The phone
runs debug-only studio controls around native Halo, with synthetic voice state
and no tuning overlay. Original retains its renderer and transitions; Contained
uses the separate native adaptation described below. The host never substitutes
a browser Halo renderer for the phone.

The operator narrowed the initial Current/Signal/Field radio/Ghost terminal
exploration to Rockers or Keycaps for mute controls and, initially, one fixed Trigger.
That iteration removed preset, header and talk-surface selectors; protocol 6
restored an independent Trigger/Rocker talk-surface selector. Protocol 8 converges
both controls on Rockers and removes those style selectors. The visible and accessible
label is Push to talk; pressing and holding still opens the temporary capture
gate, and release or cancellation closes it. Active styling keeps a dark face
with focused lime accents.

Controls height spans 240–480 dp, including the fixed 16 dp join. Push-to-talk
share spans 30–60% of the total; the mute row uses the remaining height after
the join. Baseline geometry is 130 + 16 + 116 = 262 dp, so the exact talk share
is `116 / 262 × 100` (about 44.3%). Reset button sizes restores only these
two dimensions, keeping composition, light and Persona tuning. The granular
Persona resets below replace the former Reset Persona. Portrait now reserves a
screen-width square for Persona, independent of control height. Surplus room
separates that square from the bottom-aligned deck; overflow scrolls instead of
shrinking the stage. Traces follow the actual deck position and square's center.
Control resizing leaves Persona's layout center, diameter and tuning unchanged.
Landscape needs a later dedicated composition and is outside this refinement.

The operator then removed the header entirely. A top overlay with a static
glyph remains visible only while Connecting or Disconnected; it slides down
and away over 240 ms, respecting disabled animations. Connected removes the
notice without a success toast. The notice reserves no height and shifts
neither Halo nor controls. The host's connection selector is a synthetic preview
condition, distinct from its actual ADB link. It cannot start media and is not
persisted in the profile. The production layout and behavior stay as before
until explicit adoption; its labels now say Push to talk.

The host serves fixed assets on loopback with a per-run capability URL and exact
Host/Origin validation. Explicitly selected, authorized ADB forwards a fresh
port to a debug-activity-owned abstract Unix socket. A separate per-session
token admits one peer at a time; bounded requests can only observe the preview,
select its design and synthetic state, adjust size/position, and save the fixed
private profile. The host removes
only its own forward on exit. There is no phone TCP listener, production grant,
Codex connection, audio or media. Release manifests and TLS policy are unchanged.
The production same-device browser gateway is not reused or widened.

Updated 2026-09-08 at the operator's request: the debug configurator now
automatically reconnects after preview backgrounding/recreation and temporary
ADB loss, superseding this ADR's initial no-reconnect choice. Activity stop
closes the listener; returning reopens it with the same private binding and
unsaved preview state. The host retries with bounded backoff, recreates only
its own missing forward and authenticates each new peer before publishing its
state. It retains the browser URL and never foregrounds the activity on retry.
Force-stop/task dismissal and host restart require a fresh binding. Android's
private saved-instance state retains this debug token, never a production grant.
Production voice and attachment disconnect policies remain unchanged.

Only observation is retried. Browser edits and saves name the observed connection
generation and are refused after reconnect. In-flight commands are not replayed;
an ambiguous Save stays visible even after the connection recovers. Closing the
host cancels retries, closes late peers and removes only this run's forwards.

The phone's private tuning profile remains the initial source. Explicit Save
checks the observed revision, atomically stores version 15 on the phone, then
copies the exact confirmed bytes to a private host JSON file. The host checks
design, geometry, Halo and spirit settings in the receipt before writing that
copy. Partial save failure is visible. Live edits and all resets are unsaved changes.
Version 1–11 phone profiles load without rewriting; retired button styles map to
Rockers and old compositions map to baseline Traces in memory. Version 1 seeds all three Halo sizes. Stored position is
retained, with +35 dp used when absent. Versions 1–3 use the control geometry
baseline; versions 4–8 retain control dimensions. Versions 1–4 select Original;
versions 5–8 retain their Halo settings. Versions 7–8 keep their spirit settings.
Versions 9–11 retain their compatible layout settings; all earlier versions gain
only baseline scene spacing in memory. Older profiles become version 15 only on explicit Save. Production still
uses its existing screen and compiled defaults; adoption remains explicit in code.

The vertical position extension replaced the initial fixed offset with one
shared −200…+200 dp slider in integer steps; +35 dp remains the default.
That extension used protocol 2 and retained profile version 2. The initial
design comparison added protocol/profile version 3. The narrowed studio introduced
preview protocol 4 and profile version 4. Its bounded design fixed
`layout: studio`, `header: none`, `hold: trigger`, permitted
`mute: rockers|keycaps`, and added integer `controlsHeightDp` (240–480) and finite
`holdSharePercent` (30–60). Protocol 4 added live, saved and default designs
alongside sizes and offsets, plus transient
`connection: connected|connecting|disconnected`. Save excludes the connection
selection. The retained internal `hold` field does not change the user-facing
Push to talk label. Production defaults and Halo animation sequencing remain unchanged.

The browser, host transport, profile persistence and native preview are separate
modules, so later configuration can extend this app without placing a settings
surface over the voice UI. See the [configurator guide](../../android/configurator/README.md)
for commands, boundaries and verification.

Updated 2026-09-09: the operator requested an altered Halo and per-state colors.
The debug-only Contained variant patches a checksum-verified copy of the original
4,497-byte asset in memory. Listening ring spread and pulse move inward; cubic
interpolation replaces elastic overshoot. Speaking/idle gains scale authored
motion around 1. The original file and main renderer remain unchanged and remain
available as Original. The operator explicitly chose to proceed with best-effort
attribution without waiting for upstream permission. [The provenance record](../../android/third-party/persona-halo.md)
and packaged notice distinguish code/runtime licenses from the external asset's
unspecified current license; no upstream contact was made.

Protocol/profile 5 added `halo`: variant (`original|contained`), a shared Contained
size (35–120%, default 78%), ring spread (35%), listening pulse (25%), speaking
motion (25%), idle breathing (25%), and three opaque RGB colors. Motion ranges
are integer 0–100%. Initial Speaking/Listening/Idle colors match the native
violet/lime/warm-white palette. Original retains its independent sizes and
colors. Switching variants preserves both configurations. Its former Reset
Persona restored the active variant and shared offset. Version 1–4 profiles
load as Original without a write. Connection simulation stays transient and
media remains absent.

Protocol/profile 6 adds `design.composition: open|dock|yoke` and permits
`design.hold: trigger|rocker`, independently of `mute: rockers|keycaps`.
Trigger and Open were its defaults. Dock is a quiet chamfered shared plate
behind lower Persona and the control deck. Yoke is a minimal stem that branches
toward the mute buttons. Both are passive stationary neutral drawing layers:
they add no status, animation or interaction and change no layout, Halo renderer,
tuning, full-bleed artwork or touch target. Open keeps the unframed composition.

The reset controls now have precise scopes. Reset button sizes affects only
height/share. Reset size affects Contained's shared size or the current Original
state's size. Reset position affects only the shared offset. Reset animation
affects only Ring spread, Listening pulse, Speaking motion and Idle breathing.
Reset colors affects only the three Contained colors. Every reset preserves
other choices and remains unsaved until explicit Save. Save validates the exact
composition, control styles, geometry and Halo receipt before the host copy is
written. Version 1–5 profiles remain readable without automatic rewriting;
existing defaults, including Original tuning and the exact control ratio, remain intact.


Updated 2026-09-09: protocol/profile 7 adds independent `spirit` choices:
`surface: still|soft`, `strengthPercent: 0..100` (default 35), and
`persona: fixed|follow`. Still/Fixed preserves the current rendering and is the
migration default for versions 1–6. Reset light affects surface/strength only;
Reset color behavior affects persona only. Base Halo colors, motion and geometry
remain independent. Exact Save receipts include spirit. Transient
`activity: steady|voice` selects the rehearsal envelope and never enters a profile.

Soft light uses one lifecycle-aware 14-second scene clock, a draw-only face wash
capped at 3.5% alpha, and slow attack/release on the existing level-envelope seam.
Binary mute state, acknowledged capture, touch geometry and text remain immediate.
Closed gates fence activity immediately. Reduced motion freezes both drift and
energy modulation; background/disconnect/Off stop frame work. Follow channels
uses small per-family tonal changes and a 900 ms gate/palette blend; it neither
changes Rive motion tuning nor repeatedly settles the native pose on recoloring.
The preview remains synthetic and opens no microphone, playback or voice call.

`design.composition` also accepts Socket and Traces: stationary mechanical
supports and paired PCB routes. A placement-derived clear aperture prevents
these layers from appearing inside the transparent Persona center; their geometry
never follows an animated frame. Version 6 remains restricted to Open/Dock/Yoke
on load. All five choices retain the same native renderer and control layout.
An acknowledged open microphone is labelled Live now; PTT eligibility and
release behavior remain unchanged.

Protocol/profile 8 converges the studio on Rockers for both mute and Push to
talk. The non-Rocker painters, selectable styles and browser controls are
removed. The current design contract fixes `mute: rockers` and `hold: rocker`;
separate legacy readers validate each older shape before mapping its styles in
memory. Placement, composition, dimensions, Halo and spirit values survive
migration, and neither saved phone nor host profile is rewritten until Save.
Current receipts require version 8 and the exact fixed-style design. Rocker
geometry, dark active styling, PTT gates, renderer identity and all seven scoped
resets retain their behavior. This remains a debug studio convergence;
production adoption is still a separate decision.

The subsequent queued composition round locks Traces and removes Open, Dock,
Yoke and Socket. Protocol/profile 9 fixes `design.composition: traces` and adds
`design.traces`: `pattern: parallel|splayed|circuit`, `stancePercent: 75..150`,
`weightPercent: 50..250`, `offshootPercent: 0..100`, and `glowPercent: 0..100`.
All amounts are integers. Defaults are Parallel/100/100/0/0; 100% trace weight
is the existing 1.2 dp. Patterns change routing, while stance, weight, lighter
side/upward offshoots and ambient light remain independently adjustable. Reset
traces restores only pattern/stance/weight/offshoots; Reset glow affects only
glow. Existing resets preserve these new settings.

The old 56 dp route-rise cap left a gap when the selected Persona became smaller
or moved upward. Primary contacts now come from a stable placement-derived
lower circumference, with a soft fade into the glow. Degenerate overlap shortens
the route instead of moving Persona or inverting its elbow. Hard routes remain
outside the clear aperture and never sample native animation bounds. Original
retains the conservative envelope across its three selected state sizes; exact
contact in every unequal state would require a separate, deliberate attachment
transition coordinated with its existing settling. In the physical-phone
100/35/60 Original-size check, both Idle and Listening rings remain above the
deck while the conservative envelope collapses the routes. This is an explicit
stationary-envelope tradeoff, not successful contact. Contained shares one size.

Background glow is an independent, draw-only pair of broad dim fields. It uses
the same 14-second phase as Button light, without reading audio energy or
changing paths, controls, or native animation identity. Zero turns it off;
disabled motion retains a static field, while background/disconnect/pending
states clear it. Current profile snapshots deep-copy nested trace choices and
require an exact version 9 receipt. Native v1–8 and host v2–8 readers validate
their historical shapes before migration; no load or preview rewrites a saved file.


The subsequent endpoint-spacing round adds protocol/profile 10 fields
`personaSpacingPercent` and `footSpacingPercent`, both integers 50–200 with
default 100. They scale within-bundle contact/foot spacing independently of
stance, preserving the previous geometry at defaults. Stance clamps to the
available landing region before squeezing feet; impossible regions draw no
routes. Upper contacts retain outward-only clearance, which can cap the requested
spacing at large apertures and make it dependent on foot placement. This is an
explicit geometry limit, not animated-bounds tracking. No renderer or asset changes.

Strict version 9 readers preserve every previous trace value and add only
default spacing in memory. Older readers keep their prior migrations. Version 10
Save receipts include both fields; Reset traces includes both and still excludes
glow. All other scoped resets preserve the spacing choices. No saved file is
rewritten until explicit Save.

## Independent orientation experiments

Protocol/profile 11 separates portrait and landscape choices. Portrait retains
the screen-width square; landscape places the square beside the existing Rocker
deck, scrolling only the deck when it is taller than its available lane. The
hidden `personaSide` choice swaps lanes without mirroring artwork or HUMAN/AGENT
ordering. Each orientation owns placement, control dimensions, traces, Halo
variant/motion/colors and spirit. Transient synthetic call state remains shared.

The debug activity observes configuration changes and switches layouts itself.
Host edits cannot choose orientation. Each preview/Save request must carry the
observed orientation and monotonically advancing rotation epoch, in addition to
the host connection generation. Host and device both check the fence; a return
to the same orientation does not make an old request valid. Browser drafts are
discarded on a changed epoch. PTT is released when orientation changes.

Version 11 keeps portrait in the existing root profile fields and adds its side
plus an independent landscape layout. Older profiles preserve portrait settings
and seed baseline landscape with zero offset. Save validates both captured
layouts even if the phone rotates before the response arrives. Loading and
rotation never rewrite either saved file. This remains a synthetic debug studio;
Live/Design integration and production preferences are separate work.


## Muted presence, themes and spacing experiments

Protocol/profile 12 adds five per-orientation `design.spacing` values:
`sideMarginPercent` and `edgeClearancePercent` (0–200, default 100),
`sectionGapDp` (0–80, default 0), `channelGapDp` (0–40, default 10), and
`pushGapDp` (0–48, default 16). Each has an individual reset and the group has
an atomic reset. Defaults retain the prior 2 dp spacing rhythm. The Persona
stage is calculated from the existing baseline before spacing is resolved;
only the deck changes. Increasing the PTT join preserves both face heights and
adds the difference from 16 dp to deck extent. The size/share controls keep their
original denominator. Trace feet and the capture conduit use the actual channel
gap. Impossible margins are bounded to usable width without rewriting settings.

`theme: bright|quiet|grayscale` and `mutedPresence: tide|off` are transient preview
conditions shared across orientations, not fields of the saved visual profile.
Theme transformations read the original chosen colors after Spirit blending;
Bright is an exact bypass. Quiet/Grayscale use linear-light Halo gains .45/.2 and
chroma retention .25/0. Decorative opacity is .5/.2; captions and glyphs use a
separate contrast floor. Native color properties cover Original, Contained and
Asleep; a palette-only update redraws a paused pose without re-running settlement.
The bundled asset is unchanged. Production callers retain their original palette.

Tide is a separate input-transparent layer: lowercase muted in measured 14 sp Plex,
84% muted ink, at most 1 dp horizontal / 3 dp vertical drift on the shared 14-second
clock, and a 450 ms entrance. Effective gates own eligibility; PTT, pending controls,
disconnect or background removes it immediately. Reduced motion draws a static
word. Its measured rectangle plus 8 dp radial clearance must fit a conservative
inner aperture; drift decreases before the word is omitted at impossible sizes.
This is deliberately distinct from the outer trace-attachment envelope.

The operator's captured portrait choices become provisional studio defaults:
Contained 78% / offset −22 dp, controls 387 dp / share 40.9%, Parallel traces 130/175/88/0 with both
endpoint spacings 100, motion 35/25/25/25, existing base colors, Still 35 / Follow,
and Original 78/56/78. Landscape keeps its independent baseline. Existing profiles
preserve their values and gain only baseline spacing. No load, reset or preview
publishes a profile. Future Live/Design integration and product preferences remain
separate; these are adjustable design experiments.


## Adjustable muted typography and motion

Protocol 13 adds required session-root `mutedTuning`; saved profiles remain version
12. The exact object contains integer textSizeSp 12–32 (14), brightnessPercent
0–100 (0), driftPercent 0–300 (100), breathPercent 0–100 (0), cycleSeconds 6–30
(14), and motion float|ripple (float). Each reset changes only its value; group
reset leaves Tide/Off, theme, geometry and saved layouts untouched. Brightness
interpolates theme-appropriate secondary and primary ink. Ripple moves shaped
letter slices through a slow wave without changing text, layout or native Halo.
Reduced motion removes drift, ripple and breathing immediately.

The existing scene clock integrates the selected cycle speed without resetting
phase or changing the other scene animations. Typography edits keep the native
Halo instance; fitting reserves maximum breathing and letter movement before
reducing motion, then omits the optional word if readable text still cannot fit.

The prior universal Contained inner-radius coefficient .07 unnecessarily limited
larger type at ordinary motion settings. Its replacement is the conservative
product .20*(1-.6S)*(1-10P/128)*(1-.06I)*(1-.071875M), with normalized spread,
pulse, idle and speaking amounts from the checksum-pinned asset. Multiplying by
stage diameter, 1.9 and shared size places the aperture inside all hard strokes,
including transitions; diffuse feathered glow may enter it. Independent historical
minimum size and coefficient cover crossed slider changes, tightening immediately
and relaxing after 600 ms unchanged to cover source debounce and scale handover.
This does not switch to an Idle-only bound: Listening can finish its current
four-second loop before exiting. Original retains its earlier conservative bound.
No Persona asset, production palette or audio behavior changes.


## Linked padding and dimmer muted text

Protocol 14/profile 13 adds required `design.spacing.paddingDp` (integer −1..40).
−1 preserves the five historical spacing values without changing geometry. Strict
profile 12 readers add only this sentinel, in both orientations; older omissions
retain their prior spacing. Fresh layouts and scoped padding reset select 16 dp.
The studio displays Custom for the sentinel, then one Padding slider links deck
side/bottom clearance and both button gaps. The existing section separation stays
0–80 dp; the operator withdrew the proposed negative range in favor of manual
Persona positioning. Persona stage/size/offset and safe system insets stay fixed.
Extra separation and constrained viewports can require additional room or scrolling.
Legacy fields remain in the model for lossless restoration and are overridden only
when linked padding is selected. Nothing is saved until explicit Save.

Muted brightness now spans −100..100. Negative values multiply the entire original
opacity cycle toward zero, preserving its phase, scale and hue. Zero and positive
values retain the previous behavior; the reduced-motion pose uses the same dimming.
This remains session-only and does not change the saved profile.


## Closer Contained trace contact

The trace-only radial fade now reaches 72% ink strength 2 dp outside its protected
boundary, then full strength at 12 dp. It never paints a disk over the Rive layer.
Contained's route and zero-alpha radius use D ×1.9×size×.25×(1+.155M)+1 dp,
where M is normalized speaking motion. This bounds the nominal centered frame:
the mapped speaking maximum is 1.15468752384, idle never exceeds 1, listening
contracts inward, and the relevant cubic is monotone. It is not an outer-glow
bound. Size and expansion retain independent historical maxima for 600 ms before
tightening; this also applies without animation because source debounce remains.
Original keeps its prior .4×maximum-selected-state envelope and known unequal-state
standoff. Neither variant tracks animated GPU bounds or changes the Rive asset.

Phone samples show Contained's feeds tucked below the lower arc in baseline and
speaking; some contracted/extreme poses still have a small gap. This is a closer
stationary connection, not exact contour tracking in every animation frame.


## Quiet center-indicator alternatives

Protocol 15 expands the session-only `mutedPresence` choice to
`tide|off|words|channels|labeled|contacts` and adds required `presenceScope`:
`both-muted|any-muted|always` (default any-muted). Profile 13 stays unchanged;
Save excludes these choices and `mutedTuning`. Protocol 14 restoration adds only
the default scope. Tide remains the original both-closed baseline, independent of
scope; Off hides the layer. Switching either retains appearance controls.

Words names the gate combination, with two-line mixed/fully muted captions.
Channels uses a mic/speaker pair with diagonal mute strikes. Labeled stacks
icon/live-or-muted rows, preserving the selected text size. Contacts uses tiny
PCB switches: joined means live, lifted means muted, human left. It deliberately
trades immediate recognition for a quieter mechanical connection with Traces;
the studio explains its convention. Footnote and Bookends remain creative
follow-up concepts, not extra controls in this round.

Effective micOpen/speakerOpen establish truth, including PTT opening a mic whose
mute preference remains true. Connection, foreground and pending-control gates
suppress uncertain assertions. Text, color and semantic switch shape update
immediately; decorative motion cannot retain an obsolete live indication. No
open-mic state is labeled listening or thinking. The input-transparent layer
shares the existing clock, theme, conservative aperture and appearance settings;
it owns no Rive changes or interaction targets. Labeled rows reserve the longer
caption width to prevent horizontal gate-change jumps. Fitting reduces motion
first, then omits a block that cannot fit rather than shrinking selected type.


## Visible portrait footprint and soft trace underlap

Portrait no longer uses page scrolling or treats the screen-width Persona square
as a minimum flow height above the deck. The square defines renderer coordinates;
controls are bottom-anchored inside the safe viewport and visible padding. If the
requested deck itself exceeds that budget, its faces fit proportionally and its
join is bounded; stored controls-height/share/padding values are unchanged. The
foreground deck may overlap the square's lower area. Manual Persona placement,
size and native instance remain independent. Landscape retains its existing deck
scroll behavior. Section separation is hidden in portrait and preserved in profiles;
manual Persona offset controls separation there.

The Contained trace mask formerly used the maximum speaking expansion even in
contracted idle poses, producing a17–23dp standoff at the operator's85%/M68/I69
settings. The new static join uses92% of the nominal frame radius, retaining the
previous size briefly during source debounce, and removes bright Persona-side
contact tabs. The existing trace-only fade extends from that peripheral join;
Rive remains above it. This is an intentional soft underlap, not exact occlusion
following every animated ellipse. High expansion can reveal short peripheral
feeds inside the outer ring; the central disk remains clear. Original's conservative
max-state envelope and unequal-size limitation remain. The pinned Rive11.12.0 API
has no component world-transform getter; exact pose-derived masking would require
a separate runtime integration, not another scalar promoted as universal contact.


## Independent trace join controls

Protocol 16 / profile 14 adds orientation-local `design.traces.reachDp`
(−40..120, default 0), `fadeLengthDp` (0..80, default 12), and
`tipOpacityPercent` (0..100, default 0). Historical profile schemas stay strict;
profiles through 13 and activity sessions through protocol 15 gain only baseline
join fields in memory. Explicit Save is still the only profile write.

Both orientations derive the join radius as `max(0, previousRadius − reachDp)`,
with dp converted to scene pixels once. Routes, offshoots and radial trace ink
share that radius. The fade retains the old 72% shoulder at one sixth of its
length; selected tip opacity interpolates that shoulder toward full ink. A
zero fade is a hard edge. A positive radius still protects its inner disk, but
zero radius deliberately permits full center reach. No mask paints over native
Persona pixels. Per-field reset and Reset traces restore 0/12/0 without changing
other layout, Halo, indicator, spirit or glow choices.

This is the requested adjustable fallback, not exact animation-derived occlusion.
Pinned Rive Android 11.12.0 lacks a component/world-transform getter; artboard
bounds are canvas bounds and this asset exposes only a color binding. Following
the moving ellipse requires a separately scoped native runtime bridge. This round
changes neither the asset nor its renderer, and claims no universal clear-center
protection when the operator explicitly extends traces into that region.


## Fit status text before omitting it

The operator's Words/32 sp selection with strong Contained motion produced a
small conservative inner aperture. The indicator was eligible for “human muted”
but the measured two-line block failed the fit check and disappeared. Status
indicators now try the preferred size down to 12 sp, reducing motion within each
candidate before choosing smaller type. Words reserves the longest two-line
status when choosing size, so changing gates cannot enlarge a short “live” label.
The existing aperture and 8 dp clearance stay unchanged; impossibly small spaces
still omit the optional indicator. Tide keeps its previous behavior. Stored size,
brightness, motion, scope and geometry are untouched, and this needs no protocol
or profile migration.


## Shared appearance with explicit orientation overrides

Protocol 17/profile 15 separates appearance scope from local geometry. Four
shared groups contain trace settings except glow, glow, Halo appearance except
size, and spirit lighting/color response. Each layout stores a sorted unique
override-group list. Root state reports the effective current layout, other
layout, common appearance and their saved/default counterparts. The browser
submits effective current fields plus scope flags; it never writes arbitrary
common-base metadata or selects an unseen orientation.

A shared-to-shared edit updates the common base and every inheriting layout.
Turning an override on snapshots the preceding effective group, ignoring
proposed group values in that toggle request. Turning it off adopts the existing
common base, also ignoring stale local values. Subsequent local edits cannot
change the common base or the other orientation. Common appearance can remain
stored even when both layouts override it. Save captures both effective layouts,
common data and scopes atomically under the existing revision/orientation fences.

Appearance resets use common defaults in their current scope; sizes, axes, deck
and spacing use orientation defaults. Theme/indicator remain shared session-only
choices. Default/new layouts share portrait's provisional appearance. Legacy
profiles derive common appearance from portrait; each old landscape group
inherits if equal to the canonical legacy defaults or common values, otherwise
its values survive as an explicit override. Loading never rewrites saved files.

Each layout also gains horizontalOffsetDp (−200..200, default 0). Portrait uses
its existing vertical offset; landscape uses horizontal offset and retains its
old vertical value without rendering it. The stage, Persona and center indicator
move together; traces use the actual center while retaining a stable routing
lane. Controls do not move. The scalar interpolates with the existing rotation
geometry; it introduces no renderer recreation or independent animation clock.

Debug phone replies now have a 16 KiB bound and profile text an 8 KiB bound to
carry the explicit common data and save receipt. Incoming preview requests remain
8 KiB. Production transports and release code are unchanged.


## Coordinated switch sound auditions

Protocol 18/profile 16 adds one shared root `sounds` object: family `off`,
`rocker-29` or `rocker-13`, and integer `volumePercent` 0–100. Default is Off/70.
This setting is independent of layout/appearance overrides and saved only by
explicit Save; legacy profiles and restored sessions migrate to Off/70 without
rewriting files. Current/saved/default receipts are validated by both endpoints.

Six cleared CC0 Kenney-derived WAVs form two matching trios. Each has a shared
mute click, a lower PTT down cue and a shorter/quieter PTT up cue. The debug
phone uses a preloaded native SoundPool with media volume and no focus request;
the browser never plays or serves sound assets. Configuration changes are silent.
Only accepted local mute gestures, accepted PTT press and ordinary release (or
explicit accessibility Start/Stop) play cues. Cancellation, background, rotation,
reconnect/hydration and disposal do not. A setting change invalidates an existing
pair. Unloaded samples are dropped, never queued; an unheard down cannot produce
an orphan up. The live-mic touch acknowledgement remains visual only.

This is a debug design audition. Production media/controllers, Halo rendering and
release behavior remain unchanged. Sound assets/attribution are in debug assets;
source hashes, license and reproducible processing are documented under
`android/third-party/switch-sounds`. Final subjective choice and acoustic pickup
in a real voice call are not established by decode/gesture instrumentation.

## Shared spacing, landscape columns and directional rockers

Protocol 19/profile 17 supersedes the separate-spacing, offshoot and three-cue
experiments above. Enforce equal spacing objects across both effective and saved
layouts, without an orientation override. All six spacing fields move/reset
together across orientations. Legacy landscape spacing adopts portrait values
in memory; original files remain untouched until explicit Save. Persona sizing,
placement and deck height/share remain local because their geometry differs.

Landscape stacks HUMAN/AGENT in the column nearest Persona, with a full-height
PTT column at the outer edge. Mirror columns, never channel order, for opposite
handedness. PTT share is width here, height in portrait. Use the portrait trace
engine with transposed axes instead of maintaining a second routing aesthetic.
Decks fit the visible viewport without scroll; transient center misalignment
during relocation suppresses traces rather than attaching to an invented center.
Offshoot rendering, controls and current schema fields are removed. Historical
readers validate then discard the old field.

Show push to talk is a strict shared session boolean, default true, excluded
from saved profiles and dirty comparisons. Hide removes the target/connector,
releases any held pointer silently, and gives the mute controls the spare room.
Retain PTT share while disabled. Rotation/restoration retains this experiment.

The two CC0 sound families now contain four cues each: shared mute on/off,
plus separate PTT down/up. Choose mute direction from the accepted persistent
state, never the effective PTT gate. Existing toggle recordings become on
byte-for-byte; PTT files are unchanged. New quieter/shorter off derivatives have
complete source/hash/processing receipts. No cues on configuration, hydrate,
reconnect, cancellation or relocation. Final sound preference remains the
operator's audition choice.
