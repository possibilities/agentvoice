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

## Four physical orientations and capture

Studio independently retains **Portrait**, **Landscape**, **Reverse portrait**
and **Reverse landscape**. Turn the device to edit the visible slot; the label
above the controls identifies it. A 180° display change selects the opposite slot
even when Android's portrait/landscape configuration does not change. Android's
user rotation policy still applies outside an explicit capture.

Geometry and appearance overrides are local to each slot. Shared spacing, shared
appearance, sounds and the eight shared visual choices apply across all four.
Protocol30 carries the visible slot, its facing-pair `otherLayout`, and the other
two in `remainingLayouts`, plus saved counterparts. Profile21 added
`portraitReverse` and `landscapeReverse` beside root portrait and `landscape`.
Draft3 saves this complete profile. Readers clone legacy reverse slots from their
matching axis in memory; loading never rewrites older drafts or checkpoints.
Reset to production restores all four without writing the explicit Save checkpoint.

**Capture all 4 layouts** temporarily locks the selected device to each physical
orientation and waits for the native Studio to settle. Keep Studio foreground,
unlocked and untouched during capture. Held buttons and connection rehearsals
must be closed first. The gallery labels all four native PNGs; **Download
comparison** exports a labeled sheet, and each original remains downloadable.
These are sequential animation samples, not simultaneous or frozen poses.

The compact comparison places both portraits together beside stacked landscapes,
using one pixel scale across all four. Original PNG downloads keep the native
resolution. **Show system guides** overlays Android-reported visible system-bar
insets and cutout bounding rectangles; it does not modify the screenshot bytes.
Guides are omitted when the optional native viewport measurement is absent or
its dimensions differ from the PNG. Missing measurements are not zero insets.
A cutout rectangle describes Android's bounds, not the exact rounded hardware
shape. A physical-device check remains necessary for camera-hole alignment.

Outer button padding counts the space already reserved for a display cutout.
For example, 21dp padding beside a 27dp cutout adds no extra gap after the
cutout-safe boundary; beside an 8dp cutout it adds 13dp. Interior button gaps
keep the full chosen padding. This applies per physical edge and on either
landscape side, without moving the manually positioned Persona or changing
saved tuning values.

Capture sends only state reads to Studio: no edit, reset or Save. It refuses
changed design/session state, reconnection and stale orientation/revision requests,
restores the prior rotation mode on success/failure/cancellation, and publishes
no partial comparison. A restoration failure is explicit. Captures stay only in
host memory until replaced or the host stops. No screenshot is automatically
written to the profile directory. Phone mappings assume a natural-portrait device;
physical cutout, reverse-rotation and natural-landscape tablet behavior need
separate device acceptance.

Shipping generates all four slots from the adopted profile23. New promotion
receipts use provenance3; existing provenance1/2 receipts remain readable and
retain their original source text and hashes.
Legacy profile20 reverse defaults are synthesized from their matching axis only
when reading that older format; loading it never rewrites its saved bytes.

## Participant icon audition

The shared channel-icon selector includes **Human / Agent · Speaking profiles**
(original artwork) and **Human / Agent · Phosphor Bold / Fill** (MIT). These
identify whose audio is controlled. Rocker labels and accessibility descriptions
still identify microphone and agent audio; changing icons does not disable or
disconnect a participant. The same pair appears in the small center indicators.
PTT can retain its press symbol or use **Match human channel**.

These are additional choices in the existing profile23/protocol30 icon field;
Save, draft persistence, rotation and Reset to production use the same complete
selection. A matching updated Studio APK is needed to render the new choices.
No production selection is adopted by adding an audition. Promotion packages
only the selected vectors and license, while the full library remains in Studio.

## Continue from production

**Connection display** is shared across all four layouts. **Relay mark** places
a quiet connection glyph above the status, **Beacon word** emphasizes larger
words, and **Datum line** uses a compact labeled status. The display sits inside
the Persona and follows its existing center in both axes. It replaces the old
top connection plate; it does not resize or pause the Persona. The connected
muted indicator and disconnected connection display never compete.

The connection rehearsal now includes **Failed**. In Studio, Connect/Retry moves
only the synthetic preview to Connecting; choose Connected in the host to finish
that rehearsal. Cancel returns the rehearsal to Disconnected. These actions do
not use grants, a microphone or the voice server. Production Connect/Retry is an
explicit attempt using the existing saved grant; Cancel or End attempt ends the
current attempt. Details retains the complete error in a selectable, scrollable
dialog. Very small Personas or large accessibility fonts use one 48dp details
control so the full status and actions remain reachable. There is no invented
Disconnecting phase: the controller does not currently expose one.

QR enrollment, device-access recovery and permission overlays remain separate.
A usable saved grant no longer opens a full-screen reconnect overlay after a
call ends; its Connect action lives inside the Persona.

Protocol29/profile22 add required shared `connectionStyle: relay|beacon|datum`
with live/saved/production values. Older profiles gain Relay in memory without
rewriting the checkpoint. Draft3 continues to store the complete profile. Save
captures the style; Reset to production restores it with every other design
choice. Only the selected production style is used in the real app.

**Thinking** auditions verified coding activity with the bundled Rive state.
Contained offers **Thinking wingspan**, from **1–10**. **2** preserves the compact
reach, **10** matches Original’s full arm reach, and **1** brings the arms a little
closer still. Only the moving arms change; the circle, vertical geometry and
timing stay fixed. Original remains the unmodified comparison.
The slider belongs to Halo appearance: it follows Shared/current-orientation
scope and survives draft restarts, Save and production promotion. Profile23 and
protocol30 carry it; older designs gain 2 in memory without rewriting saved
bytes. Reset to production restores the adopted value.
It shares Idle size/color (and Contained's shared size); these controls explicitly
edit that shared tuning. The Thinking state rehearsal is transient and excluded from saved
profiles; its wingspan setting is saved. Muting a channel retains the simulated work; holding PTT temporarily
shows Listening, and releasing returns to Thinking. Production uses the server's
content-free coding-activity state, with audible voice and human input taking priority.
Protocol28 adds this audition; profile21 and draft3 are unchanged.

Disconnected and connecting previews keep the Persona's idle loop moving in its
disconnected color and normal Idle size, matching production. Backgrounding and
Android's disabled-animation setting still settle it to a still frame.

On first use only, Studio seeds its draft from the bundled production design.
After that it always opens the last configured draft, even after a new production
release or Studio upgrade. Only **Reset to production** adopts production again. Its complete
baseline is `android/design/shipping-profile.json`; the generated debug-only
`StudioProduction` preserves all four layouts, shared appearance and exact override
flags, all eight visual choices, both shown/hidden PTT extents and sounds.

Every acknowledged design edit is atomically autosaved on the phone in
`files/persona-studio-draft.json`. It survives process death, force-stop,
reopening Studio, host restart and same-production APK reinstall. The host
never replays stale browser edits after reconnect. Simulation mode/gates/activity,
held pointers and bridge capabilities are excluded from this durable draft.
Activity-local rehearsal continuity may survive recreation; its older Bundle
cannot replace the durable design even after production changes.

**Reset to production** restores the entire shipped design in all four orientations
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
its private synthetic-bridge binding separately from the draft, so an
ordinary launcher open after process death reconnects the same browser without
replaying edits. A host restart retains the same local URL on its selected port; it observes the existing
draft. This binding is never a production device grant and is never exported.
Production APKs contain neither Studio's bridge/store nor its full reset snapshot.

The promoted baseline currently selects Contained, Splayed traces, i cons channel
icons, Relay Aperture launcher and Rocker 13 sounds. Numeric reset values follow
the complete promoted profile rather than historical experiment defaults below.

Appearance has four groups: **Traces**, **Background glow**, **Halo appearance**
(variant, motion and colors), and **Light and color behavior** (button light and
Persona color response). Each shows **Shared** or **current orientation only**.
**Customize current orientation** snapshots the current effective group for that
orientation. Unchecking discards that local group and returns it to the existing
shared choice. Editing a Shared group updates every inheriting orientation; an
overridden orientation keeps its own choice. All trace properties, including
reach, fade and contact/foot spacing, belong to the Traces group; glow is separate.
Persona sizes, scales, positions, button dimensions and side stay local to their
orientation. All scene spacing is shared, without an override option. Theme applies to all four orientations and is saved. Synthetic session controls
also apply to all four orientations but remain transient.

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
glow. Original follows the same displayed scale as its native wrapper, including
shrink-before-Listening and native-controlled exit growth. A larger setting for
another state no longer hides the current smaller state's routes. Its existing
conservative attachment factor remains unchanged; it is not an exact animated
edge and can leave space around the smaller central ring. Both orientations read
that scale during drawing, without restarting the renderer or adding a separate
state timer. Contained retains its shared size and existing attachment rule. Contained now uses its nominal frame and maximum selected speaking
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
resetting it in either orientation updates all four layouts. These controls sit
outside the orientation-only Layout section. Spacing is autosaved in the draft; Save exports it.

**Switch sounds** is a shared, saved choice for all four orientations, independent
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

While a press waits for the microphone gate, the button retains **Push / to talk**
and depresses for immediate touch feedback. It shows **Live now / release to mute**
only after the microphone opens; no intermediate Opening or Wait labels flash.
Accessibility reports the pending press as **Pressed**. Disconnected status remains visible.

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
talk in the outside column. The opposite Persona side mirrors the column
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
All four effective layouts, their override flags and the shared base are stored on
Save. Legacy portrait appearance seeds that base; untouched landscape appearance
inherits it while explicit landscape differences stay local.
**Controls side** appears in Layout for both landscape rotations: Right
(right-handed) puts the controls to the right of Persona; Left (left-handed)
puts them to its left. Switching also negates the horizontal Persona offset,
preserving its relative placement; switching back restores it exactly if there
were no intervening edits. Icons are never mirrored and HUMAN stays above AGENT.
The selection is local to the visible physical rotation and persists in the
working draft and complete Save through the existing `personaSide` field.
There is one layout per physical rotation, not separate tuning banks per hand.
Both hands share its sizes, traces, padding and appearance. Position reset uses
the adopted default mirrored to the currently selected side in either landscape.
The four-view capture shows each rotation's selected side.

**Use balanced production layout** explicitly replaces only the active landscape's
Persona scales/Contained size, horizontal position, shown/hidden control widths
and PTT share. It uses this checkout's promoted production geometry; when changing
hands relative to production it mirrors the opposite landscape rotation so the
camera is on the equivalent edge. Appearance, override flags, shared padding,
sounds and other rotations stay intact. It does not Save or promote. This is a
starting point for the current phone, not a promise of identical insets on every
device. The separate side selector mirrors current tuning without resetting it.

The phone has no header while connected. **Preview connection** selects a
synthetic Connected, Connecting or Disconnected state. A notice with a static glyph
slides down from the top for Connecting or Disconnected and remains until that
condition ends. It slides away when Connected returns; there is no connected
toast. The 240 ms transition reserves no layout space and moves neither Halo
nor the controls. The connection selection is transient and is not saved in
the profile. It does not change the host's actual ADB connection.

Install the current AgentVoice Studio APK on an explicitly selected, ADB-authorized
phone. Open **AgentVoice Studio** on the phone, then run from the repository root:

```sh
bun run android:configure
```

Open `http://127.0.0.1:4317/` on the host machine (or the printed address if
using `--port`). Only one host can own a Studio device: stop an older host before
linking it from another. The browser starts with a
**Studio device** picker. Initial discovery and **Refresh** list only authorized,
online ADB devices with Studio currently foreground; discovering never launches
an app or attaches a controller. Choose a device and **Link selected device**.
**Choose another device** releases the current connection before another selection.
The controls and screenshot gallery always belong to the selected device.

`--device <serial>` optionally pins/preselects one running Studio device.
`--save-to /absolute/file.json` is allowed only with that pin; otherwise each
selected device exports to its own `profiles/<encoded-serial>.json`. No phone ID
is required at startup, and the browser stays usable with an empty device list.
Bun and ADB must be on PATH. `--port 0` chooses an available port; the default is
4317. Do not replace an operator's existing host just to free its port.

Studio creates a private random synthetic-bridge binding on its first open.
Selection reads that exact file with authorized ADB `run-as`, validates it and
allocates a new owned local port. Tokens never reach browser state or diagnostics.
A matching forward from another host means **busy**: this host neither replaces
its binding nor reuses/removes that forward. Stop the owning host normally before
linking here. A crashed host's stale forward requires ownership-verified manual
cleanup; discovery does not delete it. This coordination covers one local ADB
daemon; independently authorized computers do not share a controller lease.

The host reconnects only to the selected device and binding, observing its latest
state without replaying edits or Save. It never pulls the app into the foreground.
Return to Studio after backgrounding, force-stop or task dismissal. Ctrl+C stops
the reconnect loop and removes only ports allocated by this host. The app and
its working draft remain. A restarted host retains its browser URL and explicitly
links the existing Studio binding; it does not replace design settings.

Switching targets is excluded during edits, Save, capture or other pending
commands. Selection epochs fence stale requests in addition to the existing
connection generation and physical orientation checks. Switching clears the
browser's old draft, export receipt and capture gallery before observing the new
phone. Native binding corruption is a visible recovery error, never a silent
rewrite of the draft, profile or private binding.

Opening Studio loads the phone's
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
- **Reset spacing** restores the shared portrait spacing defaults in all four layouts.
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

Explicit Save writes a version 23 profile atomically on the phone. Root geometry,
`design`, `halo`, `spirit` and `personaSide` hold effective portrait values;
`landscape` holds effective landscape values (integer-percent `scales`, both
offsets, design, Halo, spirit and side). Root and landscape each include sorted
`appearanceOverrides`; root `sharedAppearance` stores the shared base. Root
`sounds` stores the shared sound family and level. Root `icons`, `theme`,
`mutedPresence`, `presenceScope`, `mutedTuning`, `launcher`, `connectionStyle` and
`showPushToTalk` capture the
remaining visual choices. All four layouts and every shared visual and sound
setting must match the captured save request, even if
the phone rotates before its receipt arrives. `connectionStyle` is exactly
`relay|beacon|datum`; profiles through version21 gain Relay only in memory and
retain their original bytes. Its root `design`
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
version 21 only on explicit Save. Legacy profiles through16 use portrait spacing
for both effective layouts; the previous landscape spacing stays in the untouched
raw file until Save. Profiles are ignored by Git.

The real voice client and release APK use the adopted shipping profile through
generated constants and shared renderers. Saving a later Studio choice does not
adopt it into the product; promotion remains explicit. Original's native Halo
adapter retains its rendering and state-transition timing; Contained has a
separate shared renderer.

## Boundary

The host serves only fixed local assets and bounded tuning requests on
`127.0.0.1`, at a stable root URL (default `http://127.0.0.1:4317/`).
There is no browser URL token. Writes require the exact Host and Origin.
CSP blocks external assets, scripts and embedding; there is no CDN or WebView.
The existing bundled IBM Plex Mono font is served under its [OFL](../fonts/OFL.txt).

ADB forwards an ephemeral host port to a new abstract Unix socket owned by the
debug preview. Its separate random token admits one peer at a time, including
successive peers from the same host run. Incoming debug phone replies are
limited to less than64 KiB; browser requests and outbound command bounds remain
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
`src/discovery.ts` enumerates foreground authorized targets; `src/targets.ts` owns explicit selection, lifetime and export isolation. `src/protocol.ts` validates the preview contract. Android's debug
`PersonaPreviewSession` applies the corresponding commands. `PersonaPreview`
renders shared `PreviewStudioScreen` with synthetic state; production supplies
actual call state to the same renderer. The studio
composes a connection notice and controls around the existing native Halo.
Preview protocol30 carries live/saved/default designs, sizes, vertical and
horizontal offsets, Halo and `spirit` selections, plus transient
`connection: connected|connecting|disconnected|failed`, `activity: steady|voice`,
`theme: bright|quiet|grayscale`,
`mutedPresence: off|tide|words|channels|labeled|contacts`, required
`presenceScope: both-muted|any-muted|always` (default `any-muted`), and required
`mutedTuning`. The latter has exactly integer `textSizeSp` (12–32),
`brightnessPercent` (−100–100), `driftPercent` (0–300), `breathPercent` (0–100),
`cycleSeconds` (6–30), and `motion: float|ripple`. Adopted defaults are
32/−19/196/100/13/ripple. Theme, indicator style, presence scope and muted tuning are required
session-root fields on Preview/PhoneState, never Layout. Protocol is29;
saved profile is version23 with separately saved shown/hidden extents and all
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
in all four orientations.
Protocol29's active fields describe the phone's visible orientation; it also
reports `orientation`, `orientationEpoch`, `personaSide`, `savedPersonaSide`,
`defaultPersonaSide`, `otherLayout` and `savedOtherLayout`. Ordinary tuning follows only the phone’s displayed orientation. The explicit capture operation temporarily rotates it, then restores its rotation setting. Version22 profile receipts must
include all four exact confirmed layouts, including design, geometry, side,
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
never include it. Current live protocol30 is strict; Android restoration from
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

Current protocol30 and profiles18–23 require both extent fields. Legacy profiles
through17 keep their strict original design fields and 240–480 dp bounds, and
their raw saved bytes remain untouched. Effective readers seed
`controlsWithoutPttDp` from that orientation’s `controlsHeightDp`. Native
restoration from protocol19 or earlier does the same. Only explicit Save writes
profile23.


## Icon auditions and launcher studies

The Shared appearance controls offer a coherent channel pair (Current, Engraved,
Phosphor Bold, Phosphor Fill, Boatman, i cons or the Human / Agent auditions)
and an independent push-to-talk icon (Current
press, Contact or Match human channel). Match human channel follows the live
human icon from the selected pair. Each selector resets independently to its adopted default (i cons channels,
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
choice with all four layouts and shared choices. Reload, rotation and reconnect observe the retained selection;
disconnected cards are disabled and no selection is replayed automatically.
Reset launcher uses the adopted shipping default. Choosing a card does not
install an APK; explicit promotion generates the selected launcher resources.
Circle and squircle previews expose the central72 units of each108-unit source.
Monochrome previews use illustrative tints.

Assets are served from a fixed loopback-only local allowlist. Phosphor source
and MIT links are pinned HTTPS URLs; Original denotes project-authored artwork,
not a claim of CC0 licensing. Boatman and i cons use acquired Noun Project
artwork under CC BY3.0; the panel names both source assets, their creator and
license, and describes the modifications. For Noun pairs, Match human channel credits only its source microphone. See [icon preview provenance](public/icon-previews/README.md).


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
Protocol29 and profile22 add `connectionStyle` as the eighth shared appearance
field. Protocols through28 and profiles through21 use Relay only in memory and
remain byte-for-byte unchanged until explicit Save. Reset shared choices restores
all eight together without changing geometry or
sounds. Runtime connection, activity, synthetic mode and call gates are never part of Save.

Shipping is explicit and leaves Studio available for a later promotion:

```sh
bun android/configurator/src/shipping.ts promote --profile saved-profile.json --live-state captured-studio-state.json
bun android/configurator/src/shipping.ts generate
bun android/configurator/src/shipping.ts generate --check
```

Promotion accepts strict profiles18–22. Profiles19–22 can supply their own saved
appearance without another flag. A legacy profile requires an explicit
`--session <eight-field-json>`, `--live-state <captured-state-json>`, or
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

New exports record `disconnectedArtboardScale: 1.9`, equal to connected scale.
Older receipts with `1.5` remain readable without rewriting their source bytes;
this field records renderer behavior, not a user-tunable size. Current rendering
always preserves normal Idle size across connection changes.
