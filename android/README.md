# AgentVoice for Android

A native, foreground voice client for the existing AgentVoice server. One screen:
HUMAN and AGENT Rocker mute controls, a push-to-talk surface, and Vercel AI Elements'
Persona Halo. Kotlin/Compose and native Rive draw the interface; native WebRTC owns audio. Android
12 / API 31 or newer, ARM64 phones and x86-64 emulators.

This development build is installed on a Samsung Galaxy S22 running Android 16.
Native WSS/WebRTC connected to the desktop over Tailscale. Real-device checks
verified permission denial, PTT hold/release, background teardown, grant
revocation and rejection of the revoked grant. A human spoken request with an
audible answer and the remaining route/failure cases still require acceptance.
See [verification evidence](VERIFICATION.md). A preview's Connected label is synthetic.

![AgentVoice Android design preview: agent audio and push to talk](design/voice-preview.png)

## Adopted shipping design

The locked design is [shipping-profile.json](design/shipping-profile.json), a complete
version 20 Studio profile. Its [provenance receipt](design/shipping-provenance.json)
preserves the original saved bytes and the explicitly captured visual choices
that older Save versions omitted. It selects the Relay Aperture launcher, i cons pair, current PTT symbol,
Contained Halo, Splayed traces, Bright theme, tuned Tide/Ripple, and Rocker 13 at
60%, with both orientation layouts preserved.

The production `VoiceScreen` now consumes generated `ShippingDesign` constants and
the same rendering components as the Studio, using actual `CallUi` gates and
measured levels. It never loads a private Studio profile or a rehearsal state.
Back (or the accessible End call action) ends a call. Explicit grant import/Start,
errors and linked Credits remain available. Rotation preserves the call and uses
the configured landscape layout; relocation still cancels a held pointer.

The debug Studio remains intact. Profile 20 Save/reload includes icon pair/PTT,
theme, center form/scope/type/motion, launcher choice and PTT visibility as well as both layouts,
shared appearance and sound settings. Rehearsal connection/state/gates/activity
are not preferences. Reset uses the adopted baseline. Legacy profiles remain
readable; loading never silently rewrites them.

To deliberately adopt a later complete profile from the repository root:

```sh
bun android/configurator/src/shipping.ts promote --profile /absolute/path/to/saved.json
bun android/configurator/src/shipping.ts generate --check
```

Review the canonical JSON, receipt, generated Kotlin and selected assets together.
Normal builds check generation drift and never read the operator's ignored profile.
Release sources contain only the selected icon variants and sound quartet; the
Studio bridge, alternate icon/sound assets and browser gallery remain debug/host
only. R8 removes unreachable profile/migration helpers. The shared renderers retain
some small presentation branches to avoid maintaining a separate visual fork;
there is no runtime design-JSON parsing or synthetic-energy work on the shipping path.
Audit the built artifact with `python3 android/scripts/verify-shipping-apk.py`.
Release signing/distribution and full real-call audio acceptance remain separate.

## Build and verify

Use Bun, JDK 17 and Android SDK platform/build-tools 36. The Gradle 8.13 wrapper is
checksum-pinned. Set `ANDROID_HOME` to your installed SDK or configure an untracked
`local.properties` file.

```sh
cd android
./gradlew :app:assembleStudio :app:assembleProduction :app:assembleRelease
./gradlew :app:testStudioUnitTest :app:lintStudio :app:lintProduction
./gradlew :app:assembleStudioAndroidTest
```

Two installable apps coexist:

- `app/build/outputs/apk/production/app-production.apk`: **AgentVoice**, the real
  client with the shipped design. Package `com.arthack.agentvoice.dev` preserves
  the existing local installation's grant and permissions; signed with the local
  debug key but optimized/shrunk like release, with no Studio code or assets.
- `app/build/outputs/apk/studio/app-studio.apk`: **AgentVoice Studio**, package
  `com.arthack.agentvoice.studio`. Independent private draft and profile storage,
  distinct tuning icon, no microphone or network permissions. Its launcher opens
  Studio directly; the host browser talks to its private ADB bridge.

The unsigned distribution release remains `com.arthack.agentvoice`; distribution
signing is not configured. Verify the two local artifacts with
`python3 android/scripts/verify-design-apps.py`; the selected-assets audit also
accepts the production APK path. On an explicitly selected phone, install both
with `adb -s <serial> install -r <apk-path>`; updates preserve their separate data.
The old combined `debug` variant remains a development
fixture, not the normal phone installation. The desktop/Termux CLI's
`bun run android:build` is a different artifact.

Root `bun run test`, `bun run typecheck`, and `bun run lint` include the shared
contract fixtures. Both Kotlin and the server Zod schemas validate
`contract/server-frames.json`.

On an explicitly selected disposable emulator, with microphone/audio disabled:

```sh
adb -s <emulator-id> install -r app/build/outputs/apk/studio/app-studio.apk
adb -s <emulator-id> install -r app/build/outputs/apk/androidTest/studio/app-studio-androidTest.apk
adb -s <emulator-id> shell am instrument -w -r \
  com.arthack.agentvoice.studio.test/androidx.test.runner.AndroidJUnitRunner
```

Always select a device; never let `connectedAndroidTest` select every attached
phone. Installation on a personal phone is a separate explicit step.

## Connect

Follow [the Android handoff](../docs/android-client-handoff.md) to explicitly
enable the server's dedicated Tailscale WSS route and issue a device grant.
Transfer only the private JSON file through a trusted encrypted channel.

Open the app, choose **Import device grant**, and select that file using Android's
file picker. The app validates its exact shape and WSS endpoint, then encrypts
it with an Android Keystore AES-256-GCM key in app-private, no-backup storage.
No URL, grant, SDP, audio, or transcript is logged. The production activity
blocks screenshots and recents capture. Imports do not create a call. The source
file remains yours; the app does not delete or retain a URI permission for it.

Tap **Start voice** to request microphone and optional nearby-device permission
and start one call. Tailscale and upstream Internet access must be available.
The server controls conversation selection and persistent mute defaults.

HUMAN toggles the persistent microphone mute; AGENT toggles playback mute. While
HUMAN is muted and media is connected, hold the bottom surface to talk. Release,
pointer cancellation, a second pointer or focus loss closes the local hold
immediately. A delayed acknowledgement cannot reopen it. TalkBack exposes explicit
Start talking / Stop talking actions with the same gates.

The screen stays awake during a call. System bars can be revealed by swiping.
End call, Back, backgrounding, lock, transport loss, failed heartbeat, audio focus
loss or removal of the selected audio device tears down locally. Reopening the
app requires an explicit Start. Activity recreation still ends the call, while ordinary orientation changes now
retain the activity and release any owned hold. Portrait and landscape use their
adopted visible-viewport layouts without page scrolling. A quiet sliding notice
appears while connecting or disconnected; connected presentation has no header.

Expired/revoked grants require explicit replacement. The app has no enrollment,
refresh-secret, server configuration, account, approval or transcript interface.
The desktop's `agentvoice --attach` opens voice and orchestrator panes for the
phone's call; `agentvoice --attach --host smolbird` uses verified SSH when the
backend runs on that phone. The new CLI version must be installed on both ends
for remote viewing. This view owns no audio and closing it leaves the phone's
call running. Stock Codex TUI handles native approvals. See
[desktop attachment](../docs/composition.md).

## Implementation boundaries

- `Protocol.kt`: strict owner-frame decoder, endpoint validation, heartbeat,
  rate/pending limits and request correlation. Unknown/malformed frames terminate
  the connection; responses for methods this client never sent are invalid.
- `SecureTransport.kt`: verified WSS, exactly `agentvoice.v2`, Bearer header,
  no Origin, redirect, retry, caching or interceptors. Queued callback bytes and
  outgoing bytes are bounded. OkHttp delivers complete messages: the 1 MiB
  incoming check is after library reassembly, not an allocation bound inside
  OkHttp's WebSocket parser.
- `AudioGate.kt` / `CallController.kt`: server-authoritative gates with local
  restrictions, per-call generations, per-press acknowledgement fencing, one
  owner connection, no replay/reconnect. Runtime replacement retains ownership.
- `VoicePeer.kt`: one call-owned audio device/factory, at most a live and pending
  peer, one gathered offer per session, exact answer matching, bounded negotiation,
  and stale-callback fences. The direct WebRTC path never sends audio over WSS.
- `VoiceScreen.kt` / `PersonaHalo.kt`: the original bundled Persona Halo asset
  runs through native Rive, with no WebView or remote content. Violet speaking
  follows enabled playback RMS, with a short release hold between syllables;
  acid-green listening follows the open microphone gate. White idle is ambient
  presence; disconnected is a muted still. There is no inferred thinking state.
  The first native pose settles before drawing, avoiding a tiny startup ring.
  Window and system splash backgrounds use the same dark canvas.
  Disabled system animations and backgrounding settle the visual to one still
  frame. Persona uses the full width and the space freed by the status row. The
  padded artboard is enlarged to bring the ring near screen width. Its animation
  may bleed past the top and sides and underneath the header or buttons, which
  render and receive touches above it. There is no panel crop or edge mask.
  The disconnected still is smaller so startup details remain clear.
  The operator's chosen sizes are 78% for Speaking/Idle and 58% for Listening,
  with a fixed +35 dp vertical offset in every state. Each state has its own
  size multiplier; ordinary size changes ease over 300 ms, respecting reduced
  motion and lifecycle pause. Listening to Idle starts enlargement at Rive's
  actual `listening_out` state, spanning the asset's one-second exit. Listening
  to Speaking instead waits for `listening_off` before its 300 ms enlargement,
  so the incoming speech animation does not magnify the outgoing rings.
  Speaking animation and color start immediately; only growth waits. The
  transform affects the whole Halo. Stale callbacks are discarded on state changes.
  Entering Listening reaches its smaller scale before starting the ripples.
  Color still follows the audio gate immediately, and cancelling the entry
  prevents the pending ripple animation from starting.
  Disconnected uses Idle's multiplier with the smaller artboard.
  No audio samples reach Rive.

The UI uses IBM Plex Mono under the SIL Open Font License in `fonts/OFL.txt`,
downloaded from the Google Fonts `ofl/ibmplexmono` source. WebRTC is the pinned
`io.github.webrtc-sdk:android:150.7871.01` distribution (BSD-3-Clause). The
[Persona asset and Rive provenance](third-party/persona-halo.md) distinguishes
Apache-2.0 AI Elements component code, the MIT Rive runtime, and the separately
hosted Halo asset whose current license is not explicit in the inspected
sources. It records the Surge Studio/Vercel provenance and AgentVoice's
2026-09-09 modifications for the Contained Halo debug variant. The original
asset and production defaults are preserved; palette-only redraws retain the native pose. Full code/runtime licenses
and the separate Halo attribution notice ship in the APK's `assets/notices`.

## Design previews

Debug builds alone include `DesignPreviewActivity`. It imports only the screen
and synthetic view state; it cannot load a grant, create a controller, open audio,
or connect to a server. Scenarios: `setup`, `ready`, `connecting`, `live`, `talk`,
`error`. Force-stop only this development package in the disposable emulator
between scenarios, because launching an already topmost activity retains its state.

```sh
adb -s <emulator-id> shell am start \
  -n com.arthack.agentvoice.dev/com.arthack.agentvoice.DesignPreviewActivity \
  --es scenario live
```

See [the implementation decision](../docs/adr/0035-native-android-voice-client.md).

## Persona tuning and design studio

The [separate host configurator](configurator/README.md) runs in your desktop
browser and controls a full-screen native preview over ADB. It replaces the
on-phone tuner panel. The preview labels its microphone **HUMAN** and uses
readable on/off/live/wait captions that remain visible with larger system text.
Both mute buttons and **Push to talk** use Rockers:
press and keep the talk surface down to talk, release to mute. When the mic is
already open, touching Live now gives a subtle visual acknowledgement without
changing the mic or entering PTT. Active styling stays
dark with focused lime accents. Traces is the fixed composition: Parallel,
Splayed and Circuit routes share independent stance and weight controls.
Offshoots are removed. Persona contact spacing and Button foot spacing (50–200%, default 100%)
separate neighboring routes at each end. Wider stance reserves room for the feet;
protected-center clearance can limit upper spacing at large Persona sizes. Routes reach the selected Persona placement, preserving its clear
center and glow. These stationary neutral layers change no layout, renderer,
tuning or touch target and preserve full bleed. Original retains a conservative
shared envelope, so unequal state sizes can leave a larger gap or no visible
routes when the envelope reaches the deck.
The portrait height/landscape width slider spans 160–1600 dp. Landscape height
fills shared top/bottom padding; width fits the visible viewport from the outer edge inward.
Portrait height includes the baseline 16 dp join. Push-to-talk
share spans 30–60% of that size basis. Extra join space changes total deck height
while preserving both button-face heights. Provisional portrait defaults use
387 dp and a 40.9% talk share; landscape retains 262 dp and `116 / 262 × 100`. **Reset button sizes** restores only those two dimensions,
keeping composition, light and Persona tuning. Control sizing preserves the Halo
diameter; button-style, preset and header selectors are removed.

**Halo** selects Original or Contained. Original preserves the current animation
and its separate state sizes. Contained keeps one common size (78% initially),
moves listening rings and pulse inward, and exposes Ring spread (35%), Listening
pulse (25%), Speaking motion (25%) and Idle breathing (25%), each from 0–100%.
Contained also offers Speaking/Listening/Idle color pickers initialized to the
existing violet/lime/warm-white palette. Switching variants retains both sets of
choices. Only Contained uses the patched in-memory asset. Theme colors are applied
after channel following and do not alter the underlying palette or animation asset.

The preview has no header. **Preview connection** selects synthetic Connected,
Connecting or Disconnected. A notice with a static glyph slides down from the
top and stays while Connecting or Disconnected, then slides away on Connected
without a success toast. Its 240 ms transition reserves no space and shifts
neither Halo nor the controls. Rehearsal connection selection is not saved in the profile and
does not change the actual ADB connection.

Choose Speaking, Listening or Idle and adjust that state's
size (35–120%); Original keeps independent state sizes and Contained shares one. The vertical position slider applies
to every state, from −200 to +200 dp in 1 dp steps. Portrait starts at −22 dp;
landscape starts at 0 dp. Negative
moves up; positive moves down. **Reset size** restores Contained's shared size
or only the current Original state's size. **Reset position** restores the active orientation’s default.
**Reset animation** affects only the four Contained motion fields; **Reset colors**
affects only its three colors. Each reset preserves all other choices and is autosaved in the working draft;
explicit Save updates the exported checkpoint.
The phone's synthetic channel and
Push to talk buttons still work, and changes appear in the browser.
Leave the host app and browser open through backgrounding, activity recreation
or temporary USB loss. The configurator waits for the same preview to return,
reconnects automatically and retains unsaved tuning and design. It never replays Save or
brings the app to the foreground. After a force-stop or dismissed task, opening AgentVoice Studio reconnects
the running host; a host restart prints a new browser URL.

```sh
# From the repository root, with the current debug APK installed:
bun run android:configure --device <adb-serial>
```

Explicit Save retains both orientations' design, sizes and position in a
version 20 app-private `files/persona-tuning.json` and a matching JSON copy on the
host, including the fixed Rockers, composition, dimensions and Halo
variant, motion, colors and spirit settings, plus nested trace choices. Preview protocol 24 carries those
choices plus transient connection and synthetic activity selections. Portrait
reserves a screen-width square; landscape places Persona beside the Rocker deck.
Size, placement and control geometry are independent. Appearance groups share
values until customized for an orientation. The browser targets only the orientation reported
by the connected phone, with epoch checks rejecting delayed rotation requests.
Version 20 stores portrait in the root fields and a separate `landscape` layout.
Side swapping is supported in the model; its selector stays hidden for now. Existing
version 1–19 phone profiles load without rewriting; retired button styles map to
Rockers and compositions to baseline Traces in memory. Version 9 preserves its
existing traces and adds only the two 100% spacing defaults. Versions 1–4 initially select Original; versions 5–10 keep
their Halo settings. Versions 1–3 use the control geometry baseline; versions
4–10 keep their dimensions. Versions 7–10 retain their spirit settings. Older profiles
become version 20 only on Save. Icons, theme, center indicator form/scope/tuning
and PTT visibility are also saved. The real client uses the explicitly adopted
shipping profile described above; later Studio saves do not change production
until another promotion.
Debug builds include a **Halo preview** launcher
icon; the former `PersonaTunerActivity` is replaced by `PersonaPreviewActivity`.
The preview and its narrowly scoped ADB bridge are absent from release builds.
They never load a grant, controller or voice media, or connect to the voice server.
Optional Studio switch cues are local sound effects, described below; production
uses the adopted family and level.

**Padding** links the deck's outer sides, bottom clearance and every button gap
with one 0–40 dp control. Adopted defaults and Reset padding use 17 dp. Existing
profiles preserve their different margins/gaps as Custom until Padding is moved;
loading never rewrites them. Portrait anchors the deck and bottom padding inside
the visible safe area without page scrolling. A requested deck larger than that
area fits its button faces proportionally while preserving the requested settings.
Persona's square, center, scale and manual offset remain unchanged; the deck may
use the square's empty lower area and stays in front of oversized Persona artwork.
Use Persona's vertical position to tune the space above the deck. Section separation
is retired from the controls; its old stored value has no layout effect.
Individual resets and Reset spacing update both orientations. All six spacing
fields are shared, with no orientation override; legacy landscape spacing adopts
portrait spacing in memory without rewriting saved bytes.

**Theme** compares Bright, Quiet and Grayscale. Bright preserves the
current palette exactly. Quiet reduces color and Halo intensity; Grayscale makes
all preview layers neutral and dims decorative light, while captions retain a
contrast floor. **Center indicator** compares Tide, Off, Words, Channel icons,
Icons + words and Contacts. Words names the effective gate combination; paired
icons use a strike for muted channels; Contacts is a tiny PCB switch pair with
joined terminals for live and lifted arms for muted (human left, agent right).
The four new styles can show always, when either channel is muted, or only when
both are muted. No label infers listening or thinking from an open microphone.
Tide shows lowercase
`muted` inside the ring only while connected with both effective audio gates
closed and no pending controls. Its Float motion follows a 14-second cycle by default, stays
still under reduced motion and disappears immediately for PTT or an open channel.
Measured text keeps an 8 dp clearance within a conservative inner aperture;
Tide is omitted if its selected text cannot fit. Status indicators (Words,
Channel icons, Icons + words, Contacts) fit down from the preferred size to a
minimum of 12 sp before hiding at impossible sizes. Words reserves its longest
two-line status so a gate change does not enlarge the type. **Indicator appearance** adds 12–32 sp text, brightness (−100–100%),
drift (0–300%), breathing (0–100%) and a 6–30 second cycle, plus Float/Ripple.
Ripple sends a quiet wave through the letters; breathing gently lifts brightness
and scale. Each value and the whole appearance group have independent resets.
Negative brightness dims the entire breathing cycle; −100 hides the text and
zero retains the original ink. The baseline remains 14 sp, brightness 0, drift 100, breathing 0, 14 seconds, Float.
Cycle changes preserve the current phase instead of jumping to a different pose.
Contained's aperture follows the selected motion's conservative hard-stroke bounds;
large text is admitted only when its measured shape, movement and clearance fit.
Diffuse glow may remain behind it. Style, visibility and appearance resets are independent. These session selections survive rotation and
activity restoration and are saved in profile 20.

The studio also offers a dim breathing **Background glow**, independent of the
trace routes, **Button light: Soft** and **Persona color:
Follow channels** experiments. Light drifts lazily within active button faces;
Contained colors softly reflect effective channel gates without replacing the
user palette. Strength affects only button light. **Synthetic voice** rehearses
level response without audio. **Reset light** and **Reset color behavior** affect
only their named settings. Versions 1–6 load with Still/Fixed behavior. The shared
clock stops in the background, disconnected or disabled; reduced motion removes
all added drift and level modulation. See the [studio guide](configurator/README.md).

## Remaining on-device acceptance

Use the handoff's full matrix for permission revocation during a call, audio focus
and Bluetooth changes, lock, Wi-Fi/cellular/Tailscale loss, silent half-open WSS,
grant revocation during negotiation, server redial/runtime restart and stale SDP
callbacks. The controller's delayed-response and stale-session cases are covered
with fake media; those do not establish native audio behavior. Background teardown
and active-call revocation were checked against desktop process identity and
saved voice JSONL. Finish with a human spoken command and an audible answer.

### Trace reach and fade

Each orientation has three independent controls: **Reach into Persona** (−40 to
120 dp, default 0), **Fade length** (0–80 dp, default 12), and **Tip opacity**
(0–100%, default 0). Positive reach extends the routes inward; negative reach
pulls them back. Fade length sets the distance over which ink returns to full
strength; tip opacity keeps ink visible at the inner edge. Zero fade is a hard
edge, so tip opacity has no fade span there. Each has its own reset, and Reset
traces includes all three while retaining ambient glow. Changes are autosaved in the working draft; Save exports them. Profiles through 13 gain only these defaults in memory.

The join and fade apply to trace ink, never to Persona pixels.
Defaults reproduce the previous soft underlap. This remains a nominal join,
not a mask following the Rive ellipse: strong positive reach can reveal lines
inside the ring and, when the join radius reaches zero, at its center.

### Shared appearance and orientation layout

The studio labels each scope instead of assigning scope by column:

- Theme, center indicator and its tuning apply to both orientations and are
  included in complete version 20 design profiles.
- Persona appearance (variant, animation, colors), Traces (including endpoint
  geometry and fade), Background glow, and Button lighting/color response each
  share a common value by default. **Customize this orientation** snapshots that
  group's current appearance for local editing. Turning customization off adopts
  shared values again; it does not publish the local choice as a new common value.
  Shared edits update both inheriting layouts; an overridden layout is untouched.
- Padding and all gaps are enforced shared values, including retained custom
  margins and landscape section separation.
- Persona size, position and control height/share always affect
  only the orientation reported by the phone. Portrait position moves up/down;
  landscape position moves left/right in screen coordinates. Previous landscape
  vertical offsets are retained in profiles but no longer applied in the scene.

Appearance resets use the common defaults and follow the displayed group scope.
Layout resets use the current orientation's defaults. All design edits persist in the working draft; Save exports a checkpoint. Profile 18 keeps common appearance and explicit per-orientation
overrides. Older profiles take shared appearance from portrait; untouched legacy
landscape appearance defaults inherit, while customized differing groups become
overrides. Size and control geometry are retained. The app never infers a setting
change from rotating scrcpy's display: Alt+R rotates Android itself.

## Switch sound auditions

The host studio offers **Off**, **Rocker 29** (longer recorded decay) and
**Rocker 13** (compact click), plus a shared Level slider and Reset sounds.
Selection is silent; use the phone's controls to audition. Both mute buttons use
the same distinct on/off pair, selected from the new persistent mute state.
Push to talk uses a related lower down cue and a shorter, quieter up
cue. The phone's media volume also controls the output. The adopted default is
Rocker 13/60; changing or saving an audition does not automatically promote it.

Sounds are shared across orientations and saved only by explicit Save, at the
profile root. Profiles through version 15 load as Off/70 without rewriting.
Normal accepted gestures trigger local cues, while cancellation, leaving the
app, rotation, loading/reconnection and settings changes do not. Touching Live now
keeps its subtle visual feedback without a PTT sound. Changing the family/level
or interrupting a hold discards its release cue; unloaded samples never queue
late playback. Accessibility's explicit Start/Stop actions use the same pair.

All eight audition WAVs are adapted from Kenney's UI SFX Set (CC0); see
[provenance, processing and license](third-party/switch-sounds/README.md). They
play through a preloaded SoundPool, request no audio focus, change no system
volume and never enter a voice track. This does not test acoustic pickup in a
real voice call. Release includes only the adopted four-file quartet and player;
the other family remains debug-only.

## Landscape columns and optional PTT

The debug landscape deck is two columns: HUMAN above AGENT nearest Persona,
with full-height Push to talk at the far edge. Opposite handedness mirrors the
columns without changing mute order. It fits the visible viewport without
scrolling. Push-to-talk share adjusts width here and height in portrait; sizes
and manual Persona placement remain orientation-local. Landscape routes reuse
the portrait trace engine with transposed axes, preserving stance, foot/contact
spacing, reach and fade.

Shared design control **Show push to talk** hides the button and its connector.
The mutes fill the selected deck height in portrait and full deck width in
landscape. Hiding cancels an active hold without playing a release sound;
reappearing never reacquires its pointer. The share value is retained while its
slider is disabled. With-PTT and without-PTT layouts retain independent deck
extents within each orientation. Visibility survives rotation/activity restoration and is saved in profile 20.
The shipping profile currently shows PTT.

Protocol 22 requires consistent current/other and saved/other spacing; profiles
18–20 require equal root/landscape spacing. Older effective layouts adopt portrait
spacing, and validated historical offshoot values are discarded. Neither
migration rewrites the operator's saved files before Save.

Landscape's **Controls width** slider uses the existing orientation-local extent
value; **Controls height** remains the portrait label. Landscape height is
automatic from the visible safe area minus shared padding at both ends. Width
changes preserve Persona placement and the far edge of the deck. Width fits
the visible viewport and shared padding; tuning values are never rewritten
to fit. Existing saved numbers remain intact and become widths in landscape.

### Independent extents with and without PTT

The active height/width slider edits one of four saved values: portrait with PTT,
portrait without PTT, landscape with PTT, or landscape without PTT. The visible
mode is labeled. Switching visibility retains both sizes. Reset button sizes
resets only the active extent, and resets share only when PTT is shown. Existing
profiles seed the new hidden extent from each orientation's existing extent in
memory; loading never rewrites the saved file. Profiles 18–20 store the additional
`controlsWithoutPttDp` field and protocol 24 carries both sizes.

Both extent fields span 160–1600 dp. Landscape has no reserved half-screen lane: a
large deck may overlap the independently positioned Persona in the foreground.
Only the visible viewport and shared padding constrain its rendered bounds.
Section separation is hidden and retained solely for older-profile compatibility;
manual Persona placement owns that gap. Very narrow faces stack their channel and
state captions; short faces reduce their glyph height to keep captions inside.


### Icon auditions

The studio compares matched HUMAN/AGENT pairs, with an independent PTT symbol.
Selections are shared session choices, preserved through rotation and reconnect;
they now participate in profile 20 Save/dirty state. The adopted shipping choice is i cons; Current remains
the baseline. The center uses effective open/closed channel state while Rockers
use persistent mute state; a PTT microphone always remains unslashed.

The launcher gallery saves its selection in profile 20. Selection changes the
Studio preview and dirty state; promotion generates the installed adaptive icon,
monochrome themed layer and legacy fallback. The adopted launcher is Relay
Aperture. A Studio selection alone does not change the installed package icon.
See [icon provenance and licenses](third-party/icons/README.md). **Credits on phone**
opens the authors, sources and license links in a dismissible native dialog.

## Returning to Studio after a release

Open **AgentVoice Studio** on the phone. Run
`bun run android:configure --device <serial>` and open its browser URL; an already
running host reconnects when Studio returns. The two apps have independent data.
Studio always resumes the last configured design across restarts, reinstalls and
production changes. Production seeds only a genuinely new Studio installation.
**Reset to production** is the only way to replace an existing draft with the
bundled shipped design, covering both layouts and all shared choices.

**Save profile** exports a checkpoint; `shipping.ts promote --profile <file>`
adopts that complete profile for a future release. Build/install both apps when
releasing a new design so Studio's reset target stays current, but preserve its
working draft. There is no automatic release-time refresh. See the
[working-draft contract](configurator/README.md#continue-from-production).
