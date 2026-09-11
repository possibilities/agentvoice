# Android development build verification

Latest work: **Separate Studio app; manual-only production reset — September 10, 2026** (receipt at the end).
The user-locked S22 profile is now complete version 20 and supplies generated
production defaults. Studio protocol 23 persists all visual choices and retains
its full editing range. See [Status polish](#status-polish) for the current
build, tests, saved-copy/cold-reload checks and release packaging evidence. Earlier
sections retain their original results and limitations; they are not cumulative
verification of the current candidate. No verification started a voice call or
opened microphone/inference.

## Automated checks

- 650 repository tests, including twenty-one configurator tests; root and configurator
  TypeScript and Biome checks passed.
- 24 Android JVM tests passed: strict shared protocol fixtures, request/liveness
  bounds, server-authoritative mute gates, truthful Persona state, TLS trust,
  headers and redirect rejection, plus checksum-guarded Contained asset patches.
- The original eight instrumentation tests passed on both the disposable emulator and
  S22: Compose touch release/cancellation/multitouch, fixed PTT placement,
  accessible labels, delayed acknowledgements, runtime replacement and stale
  sessions through the real controller with fake media.
- All thirteen instrumentation tests passed on the S22 with native Persona Halo:
  real GPU pixels, animation, boolean/color bindings, reduced-motion stillness,
  independent state tuning and profile migration/reload, plus listening-entry
  and exit regressions. The Idle exit check requires growth readiness during
  `listening_out`, with the asset's one-second duration, and ordinary slider
  timing after `listening_off`. It rejects the previous wait-until-off behavior.
  The Speaking exit check instead requires `listening_off` before its 300 ms
  enlargement, while the native Speaking input remains responsive. It fails
  when Speaking shares Idle's early growth and passes with the separate timing.
  Persona tests use no controller or media. The suite also caught a double release
  introduced by the timing metadata read; Rive's artboard owns that instance,
  and the corrected view now survives the suite's repeated teardown.
- The entry regression fails with concurrent resizing and native ripple entry.
  It passes when the view reaches Listening's smaller scale first, and verifies
  that cancelling the transition never triggers a delayed native listening entry.
  It drives the Compose clock while observing actual Rive inputs and rendered frames.
  Before/after S22 recordings also confirmed that the first ripple now grows
  from the smaller scale without the initial oversize flash.
- Debug and unsigned release APK builds and Android lint passed. Release manifest
  excludes the preview activity and disables backup and cleartext traffic.
- Synthetic previews inspected at S22 dimensions, 360 × 640 dp with 1.5× text,
  and shallow landscape. The preview image is not evidence of a live call.
- The expanded Halo was checked on the S22 in speaking and listening previews.
  It uses the full screen width with a base artboard scale of 1.9 during a call,
  and 1.5 while disconnected, multiplied by the selected state size. A small header indicator
  replaces the status row, with the phase retained for TalkBack. Active ripples
  bleed at the top and sides, beneath the header and buttons, without a panel
  crop or fade. Foreground ordering gives controls priority over the native
  renderer; the real-touch tests exercise both channel controls, PTT and End call.
  Earlier checks also verified disconnected stillness and reduced motion.
- The debug-only Halo tuner preserves the operator's 78% Speaking, 58% Listening
  and 78% Idle choices, with +35 dp fixed in every state. The original version 1
  profile initialized every size at its saved 78%; Save checkpointed the operator's
  current slider positions into version 2 before reinstalling. Reopening restored
  them. Tests never write this private profile. These sizes are now compiled defaults.
  Listening to Idle grows throughout the native one-second
  exit, confirmed by a phone recording. This scales the whole Halo, including
  the outgoing rings; the bright line is not independently scaled.
  Listening to Speaking keeps the smaller transform until those rings collapse.
  Before/after recordings confirm that its enlargement no longer magnifies them;
  the same recording checks Idle to Speaking. The saved profile survived this
  update byte-for-byte.
  The native state callback is revision-fenced, and reduced motion settles the
  authored exit before pausing. The release manifest excludes tuner and preview.
- The white corner preview came from the test dependency's explicit
  `Theme.Material.Light.NoActionBar` and a small isolated fixture. The debug
  host now uses the app theme and centers that fixture on the dark canvas.
  Window and Android splash backgrounds are explicitly dark. A cold-start
  recording of the synthetic tuner exposed the asset's tiny introductory ring;
  settling the first native pose before drawing removes that ramp. The final
  recording shows its first visible Halo at the intended size and position.
  No production `FLAG_SECURE` capture was bypassed.

## Host browser configurator

The installed debug build replaces the on-phone tuner with `PersonaPreviewActivity`.
The separate Bun app in `android/configurator/` serves host browser controls and
uses an authenticated ADB forward to the preview's abstract Unix socket. The
native Halo adapter, compiled defaults and release activity are unchanged.

- All fifteen S22 instrumentation tests passed. The extracted preview keeps the
  native channel and PTT controls and has no tuning overlay. New bridge checks
  cover invalid admission, state/scale commands, invalid scales, stale saves,
  the exact atomically saved receipt and socket teardown. Saves use a unique
  cache fixture, never the operator's profile. The first shutdown check caught
  a blocked Android socket read surviving `close`; explicit socket shutdown now
  wakes it and the regression passes. The existing Halo transition tests pass.
- All 22 Android JVM tests, debug/release builds and Android lint passed. The
  release manifest still contains only `MainActivity`; no debug bridge or
  cleartext exception is shipped there.
- Eight host tests cover device selection, strict bounds, independent sizes,
  exact private host persistence, Host/Origin restrictions, stale-save refusal,
  partial save failure, fragmented responses and disconnect/oversize handling.
- Chrome displayed the host controls and selected Listening on the S22. The
  dark layout and native phone preview were visually inspected. An ADB-only
  exercise verified five state transitions and a temporary Listening resize
  to 52%, then restored 78 / 58 / 78% with +35 dp. The connection stayed live;
  the phone profile remained byte-for-byte identical to its pre-install copy.
- Closing the host process removed its exact forward. A fresh run established
  a new session; scrcpy is optional and is not part of the configurator transport.

The subsequent reconnect update supersedes the initial disconnect behavior:

- All seventeen S22 instrumentation tests passed. Successive peers authenticate
  independently; a wrong token is refused even after a valid peer disconnects.
  Background/return, launcher re-entry without binding extras and
  `ActivityScenario.recreate()` retain the same binding and unsaved 69 / 49 / 72%
  sizes. Restoring a held preview releases the hold. No activity test saves to
  the operator's profile.
- Twelve host tests cover reconnect, retained last state, fresh phone observation,
  failed dial retries, one-shot Save, old browser-generation refusal, and shutdown
  during a dial including a late candidate. The full 641-test repository suite,
  both TypeScript checks, Biome, debug/release builds, 22 JVM tests and lint passed.
- A local headless Chrome check verified disabled controls while waiting,
  automatic recovery with the same unsaved size, and preservation of an
  unconfirmed Save notice after recovery and later successful edits. Save was
  attempted exactly once against a synthetic fixture.
- A browser-to-S22 check set Listening to an unsaved 52%, backgrounded the
  preview with Home, and observed Waiting for phone. While disconnected it
  removed only that host run's ADB forward, then returned to the activity without
  new admission extras. The same browser page recovered, the host allocated a
  different port for its own socket, and Listening remained 52%. The check restored
  78 / 58 / 78% without Save. The existing private profile remained byte-for-byte
  identical before installation, after instrumentation and after reconnection.
  This exercises lost forwarding; physically unplugging USB was not automated.

Force-stop and task dismissal discard the activity binding and require a new
host launch. Retry never foregrounds the app or replays a mutation.

The restored vertical position slider was also checked on the same S22:

- One shared −200…+200 dp control previews immediately in every state. It uses
  the existing translation in the native Halo renderer; production still defaults
  to +35 dp. Preview protocol 2 carries the current, saved and default positions.
- All seventeen instrumentation tests passed, including a −24 dp profile save
  and reload, rejection of 201 dp without mutation, successive peer observation,
  background return and activity recreation with the unsaved position retained.
  Saves used cache fixtures. All 22 JVM tests, debug/release builds and lint passed.
- The 642-test repository suite, root/configurator typechecks and Biome passed.
  Host tests verify signed integer bounds and refusal of a mismatched offset
  receipt. Headless Chrome verified shared position across state/size changes,
  exact host persistence, reload and Reset for both sizes and position. A queued
  slider edit at disconnect is dropped so it cannot stall polling or be replayed.
  Both 1100 px desktop and 390 px narrow layouts were inspected.
- A browser-to-S22 check moved the native Halo to −40 and +80 dp and captured
  only the synthetic preview, confirming movement while controls stayed fixed.
  Listening and Idle kept the shared +80 dp position; background/return reconnected
  with it intact. The operator's unsaved 48 / 58 / 78% sizes were carried through
  APK installation and restored afterward at +35 dp. The phone profile remained
  byte-for-byte unchanged; the live check never sent Save.

Production voice acceptance limits below remain unchanged. This configurator
check opened no media, inference, grants or voice-server connection.

## Interactive design studio

The initial debug preview offered Current, Signal, Field radio and Ghost terminal,
plus independent header, mute-control and hold-surface selection. The production
screen, bundled Halo renderer and compiled placement defaults are unchanged.

- All twenty S22 instrumentation tests passed on the final APK. New checks cover
  independent mute toggles across all three directions and a custom mix, stable
  talk targets, original/studio switching, and release on outside movement,
  cancellation and a second pointer for every talk surface. Momentary capture
  leaves the persistent microphone mute switch off. Disabled holds do not start.
- Opening and closing the drawer shifts Halo's center by half the measured
  header-height change without changing its dimensions or the talk target. The
  test reads the layer's translated bounds, with Android measurement and Compose
  animation frames synchronized. All existing native Halo entry/exit regressions
  passed against the unchanged renderer.
- All 645 repository tests, root/configurator typechecks, Biome, 22 Android JVM
  tests, debug/release builds and Android lint passed. Protocol 3 bounds design
  choices, and new Save requires the exact version 3 design-and-geometry receipt.
  Version 1/2 phone profiles load without rewriting. Save tests use disposable
  phone cache and host fixtures.
- Local headless Chrome exercised every preset and a custom mix, preserved size
  and position across selections, saved and reloaded a version 3 fixture, and
  checked Reset tuning leaves the design intact. A queued edit at disconnect was
  dropped; reconnection retained the phone's design. Desktop and narrow layouts
  were visually inspected without using the operator's browser profile.
- Browser-to-S22 checks exercised each direction's actual mute and hold targets,
  then a custom mix. The drawer expanded, hid after inactivity, and stayed open
  when pinned. Idle, Listening and Speaking previews were visually inspected;
  capture was limited to the synthetic activity. After Home/return, the same
  browser recovered the unsaved mixed design and geometry. The operator's
  48 / 58 / 78% sizes and +35 dp position survived installation and were restored
  with Signal selected. The private saved profile remained byte-for-byte
  identical; the live-device checks sent no Save.

### Controls sizing and connection notices

The September 9 update supersedes those preset and header choices. The preview
now has Rockers/Keycaps, a fixed Trigger labeled Push to talk, and no header.
Controls height and Push-to-talk share retain the exact previous 130 + 16 + 116 dp
baseline. A top notice appears only for Connecting or Disconnected. The native
Halo adapter and transition sequencing remain unchanged; production layout and
defaults remain compiled, with the shared Push to talk label updated there too.

- All 27 S22 instrumentation tests passed on the final APK, including the existing
  Halo transition regressions. New coverage verifies exact default geometry,
  64 combinations of dimensions/style/font scale/availability, release during
  resize, a dark active Trigger face from actual pixels, notice entry/exit and
  interruption, and connection changes that cannot resume a held microphone.
  The geometry matrix verifies target containment; physical screenshots verify
  the layouts at the phone's normal font size.
- Notice visibility reserves no height and moves neither Persona nor controls.
  Increasing controls height moves Persona's center while retaining its diameter.
  Debug/release builds, all 22 Android JVM tests and Android lint passed.
- Local headless Chrome verified the narrowed options, baseline slider values,
  independent Controls/Persona resets, a version 4 Save/reload fixture, transient
  connection previews and reconnect without queued-edit replay. Desktop and
  390 px layouts had no overflow or JavaScript errors. All 646 repository tests,
  both TypeScript checks and Biome passed.
- Browser-to-S22 checks measured 130/16/116 dp at the defaults and exercised both
  mute styles at 350 dp and the 240/480 dp extremes. Labels and glyphs remained
  contained, the deck's bottom stayed fixed, and its active Trigger retained a
  dark face with lime accents. Connecting/Disconnected notices appeared without
  phone interaction and disappeared on Connected without shifting the buttons.
- Changing the synthetic connection during a held Trigger released it; returning
  to Connected did not resume capture. Home/return recovered the same browser
  with unsaved 336 dp / 48% controls intact. The operator's latest 78 / 56 / 78%
  sizes, −6 dp offset and Rockers choice survived installation and were restored
  with the new baseline dimensions. The phone profile stayed byte-for-byte
  identical; device checks sent no Save. All captures were restricted to the
  synthetic preview, with its focused activity verified before each screenshot.

### Contained Halo and per-state colors

The next September 9 preview adds Original/Contained selection. Contained has
one common size, inward listening rings/pulse, adjustable speaking motion and
idle breathing, and three color pickers. Original retains its independent sizes
and renderer. These choices are debug-only; the bundled original asset remains
byte-identical with SHA-256 recorded in [its provenance file](third-party/persona-halo.md).

- All 29 S22 instrumentation tests passed, including both new native Contained
  tests and the existing Original entry/exit regressions. Actual GPU readback
  verifies smaller listening bounds at equal native size, the same state/color
  contract, moving frames, reduced-motion stillness and native-instance reuse
  across state/color changes. Transparent PNG evidence must be composited over
  the app background: low-alpha RGB otherwise exaggerates the faint exterior.
- All 24 JVM tests, debug/test/release APK builds and Android lint passed. The
  release DEX excludes the Compact renderer/patcher and preview classes; the
  release manifest contains only MainActivity and still disables backup and
  cleartext traffic. All four attribution/license files are packaged in both
  APKs. Their notices distinguish component/runtime licenses from the external
  asset's unspecified current license.
- All 649 repository tests (7,353 assertions), including twenty configurator
  tests, both TypeScript checks and Biome passed. Profile/protocol 5 validates
  variant, shared size, four bounded motion amounts and three opaque RGB colors.
  Save verifies the exact Halo receipt. Version 1–4 phone profiles load as
  Original without rewriting; their prior geometry is retained or migrated
  using the existing version rules.
- Headless Chrome verified variant isolation, motion/colors, active-variant
  Reset Persona, version 5 Save/reload in disposable fixtures, reconnect without
  edit replay, and desktop/narrow layouts. Native Chrome then displayed the
  live phone-linked studio with Contained selected and unsaved changes.
- Browser-to-S22 checks exercised all four motion controls at 0%, 100% and their
  defaults, and all three color changes visibly reached the native Halo. Shared
  size remained consistent across states; switching Original/Contained retained
  both configurations. Real Push to talk released correctly, and connection
  notices did not move the controls. Home/return recovered unsaved Contained
  size, motion and color settings in the same browser.
- An 18-second phone recording covers normal and rapid state reversals plus
  switching Original/Contained. Reviewed frames show inward rings resolving
  into the bright boundary without the previous state-dependent enlargement.
  All 869 recorded frames were checked for oversized/white flashes: visible
  Halo bounds stayed within 129–142 pixels at 180-pixel analysis width; no white
  screen occurred. Each explicit variant switch briefly hid the Persona for
  two recorded frames while its native view was replaced, keeping the dark
  background visible. This is evidence for the exercised sequence, not every
  possible setting combination.
- The operator's Rockers choice, 262 dp controls, 44.2748% talk share, −6 dp
  position and Original 78 / 56 / 78% sizes were restored. Contained was left
  selected at 78%, with 35% spread, 25% pulse/motion/breathing and the native
  violet/lime/warm-white palette. Phone and host saved profiles remained
  byte-for-byte identical. Live device checks never sent Save.

All captures were limited to the synthetic preview after verifying its focused
activity. These checks opened no voice call, microphone, playback or inference.

## Desktop backend viewer

`agentvoice --attach` now composes just the voice transcript and stock Codex TUI,
without a voice owner or media. `--host smolbird` observes a Termux backend through
verified SSH, never through the voice WSS gateway. Exact call, workspace, thread
and runtime identity are pinned; backend loss or replacement ends the view.

A real desktop PTY fixture verified both panes, typed steering, and that closing
the view leaves the fake phone owner connected. Fake protocol tests cover native
attachment readiness before media, generation revocation, bounded transcript
framing and private temporary copies. The cross-compiled Android helper was
temporarily staged and produced valid read-only waiting frames over the existing
strict SSH connection; the staging directory was then removed. A stock TUI
attached to a real active phone-hosted call remains unverified. The new CLI is
available in this checkout; global desktop/Termux CLI installation is not part
of this APK verification.

## Physical phone checks

| Check | Observed result |
| --- | --- |
| Private provisioning | A dedicated validation grant transferred over the existing trusted SSH connection. Imported from Termux's private DocumentsProvider using Android SAF; encrypted app-private file was mode 0600. Plaintext transfer copies were removed after import. |
| Persistence | Force-stop and reopen retained the encrypted grant and showed Ready without connecting. |
| Permission denial | Denying microphone access showed an actionable message; desktop stayed idle. |
| Optional Bluetooth permission | Native speaker route connected with nearby-device permission denied. Bluetooth hardware itself was not tested. |
| Native connection | The phone and desktop both reached live WebRTC. Desktop owned the matching native thread, runtime and Codex child. No browser or Termux bridge participated in the call. |
| PTT | Real touch hold changed server `effectiveMuted` from true to false; release restored true. Phone showed Talking / Release to mute only during the hold. |
| Background | Home ended the call. Reopening showed the foreground-exit message and required Start. Desktop returned to idle, owned runtime/Codex PIDs exited, and the matching private voice JSONL had an end marker. |
| New call | Explicit Start created a new call and native thread. One attempt hit the server's `mcpServerStatus/list` five-second startup timeout; End followed by one explicit new Start connected. No client retry or server reconfiguration occurred. |
| Active revocation | Revoking only the validation grant closed the live call within two seconds of the observed pre-revocation state. Desktop passed through closing to idle, both owned PIDs exited, and recording ended. |
| Revoked retry | Explicit Start using the revoked grant failed before call admission; desktop remained idle. The app displayed the replacement-grant message. |

Successful native calls used thread IDs `01a08364-f4e4-7c53-bdf1-3843a2bf4e59`
(PTT/background) and `01a08366-f09e-7393-9f7e-2cf48a03b166` (revocation).
These identify desktop-owned transcript evidence; no transcript contents,
credentials, SDP or audio samples are included here.

The checks found and fixed a stale UI message after successful grant replacement.
On the reinstalled final build, an intentionally invalid test grant failed before
admission; importing the normal grant cleared the prior error to Ready. That
normal grant then reached live native WebRTC. Plaintext transfer copies were
removed from both machines. The existing phone-browser grant remains unchanged.
Device grants expire after 30 days.

## Remaining acceptance

A human spoken request with an audible answer is still unconfirmed. Live
connection, server mute state and transcript boundaries do not establish what a
person heard or microphone/playback fidelity.

Still needed on hardware: active permission revocation, Bluetooth/audio-focus and
route changes, lock, Wi-Fi/cellular/Tailscale loss, silent half-open transport,
revocation during negotiation and native behavior through server redial/runtime
restart. Some corresponding protocol/controller cases have automated coverage;
that coverage is not a hardware claim. Release signing/distribution is not configured.


## Rocker Push to talk, composition and scoped resets

The 2026-09-09 physical-phone update adds independent mute Rockers/Keycaps and
Push to talk Trigger/Rocker selections. Trigger remains the compiled default.
Open (default), Dock and Yoke add optional static neutral material or a fine fork
behind the Persona and controls. They preserve renderer identity, geometry and
input ownership. No Persona asset or main renderer source changed.

- All 33 S22 instrumentation tests passed. The controls matrix covers 128
  combinations of size, share, font scale, availability and both button styles.
  Rocker and Trigger stay dark on acknowledged capture. Pointer up, cancellation,
  moving out, second pointer, disposal, resizing and style changes release an
  owned hold; accessibility uses explicit start/stop. Profile fixtures validate
  version 6 and retain version 4/5 dimensions/Trigger and version 5 Halo settings.
- Native screen tests verify all twelve style/composition combinations, fixed
  targets and independent mute behavior. Original and Contained keep their native
  Rive instance across composition changes; existing Persona transition tests pass.
  Lifecycle tests retain unsaved Rocker/Yoke choices through background/recreation.
- All 650 repository tests (7,384 assertions), 24 JVM tests, both TypeScript
  checks, Biome, debug/unsigned-release builds and Android lint passed. The
  release APK contains no debug preview, composition or Contained renderer symbols
  or Contained layout. An initial instrumentation compilation error used the
  wrong Compose semantics key; corrected to `SemanticsActions.CustomActions`
  before the successful build and device run.
- A Chrome fixture exercised the twelve independent combinations, five granular
  resets, a single atomic animation reset, exact version 6 Save/reload and
  reconnect without mutation replay. Desktop and 390 px layouts were inspected;
  the fixture reported zero page errors. Reset size affects only the current
  Original state or shared Contained size; position, animation, colors and button
  dimensions each have separate scopes. Resets never save.
- Browser-to-phone checks covered all button choices and all three compositions
  in Idle and Listening, physical rocker press/release, control size extremes,
  simulated connection states and actual background/return reconnect. Animation
  reset changed only the four motion values. The operator's current sizes,
  position, geometry, colors and motion were restored afterward; saved phone and
  host profile bytes remained identical. Rocker/Dock were left selected unsaved.
  The current studio was opened and verified in headful Google Chrome. Existing
  physical-phone scrcpy was left running; no emulator was recreated.

Evidence for this run is in `/tmp/agentvoice-rocker-*.log`, the
`/tmp/agentvoice-rocker-phone-*.png` captures and
`/tmp/agentvoice-rocker-browser-{desktop,narrow}.png`. These are synthetic preview
checks; no production call, microphone, inference or grant was opened.


### Yoke intersection and rocker depth refinements

The Persona specialist's native-resolution review found the Yoke stem visible
inside Halo's transparent center. Shortening its stationary rise from 84 to
56 dp and extending its fade removes that intersection at the operator's current
70% Contained size and −12 dp offset. Idle/Listening native crops were reviewed
by both owners. Four focused composition/studio instrumentation tests and
build/lint passed. The general transparency lesson is in the shared Agentwiki
playbook, alongside native renderer continuity guidance.

The subsequent PTT refinement reduces Rocker's resting recess from a 12 dp base
(8–17 dp after height scaling) to 7 dp (5–10 dp), and halves its lower bevel.
It keeps the mechanical pivot, pressure response and restrained live color.
Seven focused control/geometry instrumentation tests passed, including the
128-combination size/share/text matrix and hold release cases. Build/lint passed.
Native before/after resting and acknowledged-press captures confirm the shallower
appearance. Both refinements preserved the operator's full unsaved preview and
byte-identical phone/host profiles. No Save or production call was issued.

Review artifacts: `/tmp/agentvoice-yoke-refined-comparison.png` and
`/tmp/agentvoice-rocker-depth-comparison.png`. Logs use the
`/tmp/agentvoice-yoke-refine-*` and `/tmp/agentvoice-rocker-depth-*` prefixes.


### Shared light, channel color and mechanical body experiments

Protocol/profile 7 adds independent Still/Soft surface light, surface strength,
and Fixed/Follow channels Persona color behavior. Socket and Traces add two
stationary mechanical compositions; existing compositions remain available.
The open-microphone PTT status reads Live now, with unchanged eligibility and
release semantics. Synthetic voice activity is transient and never saved.

- `bun run test`: 655 passing repository tests. Configurator fixtures account for
  26 tests, including strict v2–6 migration, v7 receipts, independent resets,
  and transient-activity rejection in profiles. Root/configurator typecheck and
  lint pass.
- Android debug/release assembly and debug lint pass. 36 JVM tests pass,
  including color/gate policy and lazy envelopes with immediate closed-gate
  fences. Debug APK SHA-256:
  `43a895f56a5052b04b1c9aca2eaca7f4205fc8693bacc79135b5e3bda826f431`.
  Release DEX inspection excludes the preview activity/bridge and new spirit
  helpers; the original asset and production source remain unchanged.
- 36 instrumentation tests passed on the physical Samsung S22 in 82 seconds.
  Paused recoloring changes pixels while preserving exact alpha silhouette and
  the same state machine; animated recoloring retains advancing geometry.
  Scene ticks retain a held pointer and every control's bounds. Motion disable
  stops phase and energy modulation. All five compositions preserve both native
  renderer variants. Existing cancellation, large-text/extreme-size, dark active
  face, lifecycle and bridge/profile tests also pass.
- Headless Chrome with a disposable fake phone exercised 20 independent
  mute/PTT/composition combinations, all seven scoped resets, independent light
  and color behavior, exact v7 Save/reload, no activity in the profile, and no
  edit/Save replay on reconnect. Desktop and narrow layouts have no horizontal
  overflow or browser errors.

Build/test logs and browser captures use `/tmp/agentvoice-spirit-*`.
The physical-phone visual review completed after USB returned. Native captures
cover Yoke, Socket and Traces in Idle, Listening and Speaking at the operator's
then-current Contained 70%, −12 dp placement and 387 dp deck. Both owners reviewed
the composition and native-resolution lower-arc crops: the supports stay outside
the clear center, with no ring clipping in those samples. Still versus Soft100
captures confirm active face lighting is present but very faint: temporal motion
changes average roughly 0.7 RGB levels out of 255, with a maximum of 3. No light
calibration change was included. The exact latest preview was restored, and phone
and host saved profile bytes remained identical; no Save was issued.

Review evidence: `/tmp/agentvoice-spirit-review-body-sheet.png`,
`/tmp/agentvoice-spirit-review-{speaking,listening}-light-crops.png`,
`/tmp/agentvoice-spirit-review-pixels.json` and
`/tmp/agentvoice-spirit-specialist-lower-arc-review.png`.


### Rockers-only studio convergence

Protocol/profile 8 removes the non-Rocker debug renderers and both browser style
selectors. Mute and Push to talk now use fixed Rockers; composition, dimensions,
light, Persona controls and scoped resets remain independent.

- All 657 repository tests pass (8,282 assertions), including 28 configurator
  tests with legacy-style migration, strict current design validation and exact
  v8 Save receipts. Both TypeScript checks and Biome pass.
- Android debug/test/release assembly and debug lint pass; all 36 JVM tests pass.
  All 37 physical S22 instrumentation tests pass in 58 seconds. The retained
  controls tests cover 32 size/share/state/font configurations, pointer disposal
  and re-entry, resizing, accessibility, native hold confirmation and dark
  capture styling. Saved-instance migration changes only the retired styles.
  All five compositions retain both native Halo renderers; clock and recoloring
  regressions pass without Persona source changes.
- A disposable Chrome fixture verifies absent style selectors, all five
  compositions, seven scoped resets, exact v8 Save/reload and reconnect without
  replay. Desktop and 390 px layouts were inspected with no overflow or browser
  errors.
- The real phone's saved profile loaded with only its button styles migrated in
  memory. Browser-to-phone checks exercised Socket/Traces, a real Rocker hold and
  release, and actual background/return reconnection. The operator's fresh
  Contained 78%, −22 dp, Traces, 387 dp / 40.9% deck, default motion and
  Still35/Follow choices were restored in Listening with both channels open.
  Phone and host saved files remain byte-identical to the pre-install snapshots;
  no Save was sent. Current phone captures retain the clear center and restrained
  live face. The live host page was opened and verified in headful Google Chrome.
- Debug APK SHA-256:
  `9c7ded11c356961cd2bf50fd450c9b5d45e2c65d81c282b6572a6252d52134db`.
  Release APK is byte-identical to the previous build:
  `6c19aa351345146b3490f02e91464bfb395e6e97d6431e877e8eefff6af2bf16`.
  Release DEX/layout inspection confirms debug studio, Contained and Spirit
  classes/layout are absent. No production media, grant or inference was opened.

Logs, preserved snapshots and captures use `/tmp/agentvoice-rockers-only-*`.
Key visual evidence: `agentvoice-rockers-only-phone-restored.png`,
`agentvoice-rockers-only-phone-rocker-live.png`,
`agentvoice-rockers-only-studio-live.png` and
`agentvoice-rockers-only-browser-{desktop,narrow}.png` in that directory.

### Traces composition variations

Protocol/profile 9 fixes Traces as the composition and removes the other debug
bodies. Parallel, Splayed and Circuit share independent stance, weight and
offshoot controls. A separate Background glow uses the existing slow scene
clock; the former Surface light legend is now Button light. Defaults preserve
the baseline route weight/stance and leave offshoots/glow off.

- All 661 repository tests pass, including 32 configurator tests. A subsequent
  audit strengthened literal wire bounds and nested-state adoption on reconnect;
  all 32 configurator tests passed again with 1,493 assertions. Root and
  configurator TypeScript/Biome checks pass. Android debug/test/
  release assembly and debug lint pass; all 48 JVM tests pass.
- All 38 instrumentation tests pass on the physical S22 in 53.212 seconds.
  Direct Compose route changes and active ambient frames preserve both native
  Halo instances, control bounds and a held pointer. Host preview commands retain
  their existing intentional hold-release behavior; that path is distinct. Ambient-only operation, reduced motion,
  background removal, exact-off button light, strict current receipts and
  v1–8 profile migration are covered. The first run caught one stale Dock
  assertion, two tests waiting for an intentionally continuous scene clock,
  and a nonzero phase in the off button-light output. The corrected tests use
  explicit clock advancement; off light now emits the exact zero frame.
- The disposable Chrome fixture passes all three routes, slider endpoints,
  nine scoped resets, exact profile 9 Save/reload and reconnect without replay.
  Desktop and 390 px layouts have no overflow or browser errors. On the real
  phone, controls and isolated Reset traces/Reset glow updates round-trip
  correctly, a real Push-to-talk press/release works while glow is active, and
  background/return reconnect preserves the latest settings.
  The final ADB check observes bounded state publication rather than assuming
  a fixed delay after input injection: hold was observed after 156 ms and
  release within 155 ms of ADB completion. It sends one gesture, with no retry.
- Native captures cover all routes, wide stance, thick traces and offshoots.
  Contained at 35%/−80 dp extends toward the lower glow in both zero/full-motion
  samples, with a soft visible separation from the bright rim. At 120%/0 and
  +150 dp, overlapping routes collapse rather than invert. At +150 dp the
  Persona overflows the screen edges and sits behind the Rockers; this verifies
  foreground occlusion, not full ring visibility. The design team and
  Persona specialist reviewed the full-screen composition and native pixels;
  no support enters the transparent center in these samples.
- Original deliberately uses one conservative envelope for its independently
  sized states. At Speaking/Listening/Idle sizes 100/35/60, the smaller current
  ring can sit above the deck while that envelope collapses the routes, making
  no connecting routes visible in both sampled Idle and Listening states.
  This limitation is documented in the
  studio notes and ADR; exact contact in every unequal state needs a deliberate
  transition hook aligned to the original renderer's settlement.
- Glow was measured on 871,857 pixels that were exact ground color in the Off
  capture. At 100%, average RGB lift is 6.9–7.3 code levels; two frames six
  seconds apart differ by 2.62 levels on average (maximum 11), with 86.8% of
  sampled pixels changing. At 45%, average lift is 3.22. Native visual review
  finds a visible restrained backdrop, with Persona and controls still dominant.
  These are screenshot measurements, not a claim about every display/brightness.
- The initial glow was inside safe-area padding and exposed a straight top
  cutoff. Only the ambient layer now covers the full viewport; foreground
  geometry retains its original safe padding. The native top-edge comparison
  removes the 5-level boundary step (remaining adjacent-pixel variation is at
  most 1 level), and the restored lower control region differs by at most one
  RGB level, with no visible placement drift. The final 38-test run includes
  this layer change.
- The latest operator settings are restored: Contained 78%, −22 dp,
  387 dp / 40.9% deck, default motion/colors, Still35/Follow, Listening with
  both channels open. New trace fields retain Parallel/100/100/0/0. Phone and
  host saved files are byte-identical to the fresh pre-install snapshots; no
  Save was sent. The live host page is visibly linked in headful Google Chrome.
- Final debug APK SHA-256:
  `8a2eee7fb4baa98c542d68c913fedf51bc23c1cd1d5fb54119aec2f68ea2401f`.
  Release remains byte-identical:
  `6c19aa351345146b3490f02e91464bfb395e6e97d6431e877e8eefff6af2bf16`.
  Packaging inspection confirms retired composition helpers are absent and
  Traces/Ambient/Studio/Contained/Spirit helpers remain debug-only. No Persona
  asset or renderer source changed, and no media, grant or inference was opened.

Evidence uses `/tmp/agentvoice-traces-*`: `instrumentation-edge.log`,
`phone-final-check.log`, `packaging-final.log`, `glow-measurements.json`,
`routes-review.png`, `geometry-review.png`, `original-review.png`,
`glow-review.png`, `top-edge-review.png`, `phone-restored.png` and `studio-live.png`.

### Human label and readable Rocker status (September 9)

The debug studio now labels the microphone HUMAN. Status captions use 14–18 sp
semibold type, with measured compact footer sizing and a fixed slot for
on/off/live/wait; system text scaling remains enabled and status is never hidden.
The release UI is unchanged. Debug/test assembly and lint passed. Eleven focused
phone tests passed in 35.435 seconds, including 64 actual text-layout combinations
at 1×/1.5× system text, 137 dp button width and all minimum/maximum deck splits.
Assertions cover overflow, caption bounds, stable state slots, preserved glyph
sizes and existing control/PTT behavior. Minimum-height fit at 2× is not claimed.
Native captures at current and minimum geometry were reviewed. The latest live
choices were restored and saved phone/host profiles remained byte-identical;
no Save was sent. Evidence: `/tmp/agentvoice-labels-final-build.log`,
`/tmp/agentvoice-labels-instrumentation.log`, `/tmp/agentvoice-labels-phone.log`
and `/tmp/agentvoice-labels-{restored,minimum-idle,minimum-listening}.png`.


### Independent Traces end spacing

Protocol/profile 10 adds Persona contact spacing and Button foot spacing, each
50–200% with defaults of 100%. Stance preserves the requested foot spacing by
reserving room at each button edge. Large apertures can cap upper contact spacing
under the existing outward-only clearance rule. Profile 9 preserves all five
previous trace settings and adds only default spacing; older migrations remain
covered. Reset traces includes both new fields and preserves glow.

- All 663 repository tests pass (8,768 assertions), including 34 configurator
  tests. Root/configurator typecheck and Biome pass. All 50 Android JVM tests
  pass, with explicit checks for independent spacing, stance-invariant foot gaps,
  opposite spacing extremes, clear-center protection and route intersections.
  Debug/test builds and debug lint pass.
- The final test APK passed all 39 physical-phone tests in 80.252 seconds.
  This includes version 9 saved/live migration, version 10 bounds and Save,
  repeated spacing extremes with both native renderers and a held pointer,
  64 typography layouts, lifecycle/reconnect and existing PTT regressions.
  The first 39-test run also passed, but two test edits overlapped its compile;
  an incremental source check rebuilt the test APK and the complete suite was
  rerun. The final log is `/tmp/agentvoice-spacing-instrumentation-final.log`.
- The disposable Chrome fixture exercised both slider endpoints, nine scoped
  resets, exact profile 10 Save/reload and reconnect without replay. Desktop
  and 390 px layouts show no overflow or browser errors.
- Physical-phone browser updates and Reset traces round-trip both fields.
  Six native comparisons cover Splayed baseline/wide feet/wide contacts/tight
  spacing plus Parallel/Circuit with opposite endpoint spreads. Native crops
  show distinct endpoint changes without obvious crossings or intrusion into
  the clear center in these samples; the design team reviewed the same captures.
  This is sampled visual evidence, not a guarantee of every animation frame.
- The latest live choices were restored after the final test run, including
  both 100% spacing defaults. Saved phone and host profiles are byte-identical
  to fresh snapshots; no Save was sent. Headful Chrome shows the final live
  studio. Installed and local debug APK hashes match the hash at this page's top.
  No production source, Persona renderer or asset changes were made.

Evidence: `/tmp/agentvoice-spacing-{build,tests,typecheck,lint}.log`,
`/tmp/agentvoice-spacing-test-source-check.log`,
`/tmp/agentvoice-spacing-browser-check.log`,
`/tmp/agentvoice-spacing-phone-check.log`,
`/tmp/agentvoice-spacing-route-comparison.png`, and
`/tmp/agentvoice-spacing-final-before-restored.json`.


### Live microphone touch response

The debug Live now surface acknowledges a finger on an already-open microphone
with a 2.5% lime face wash, a quiet edge and a slight caption/glyph tint. It does
not rock, acquire PTT, invoke control callbacks or change microphone state.
Release, cancellation, leaving the target, a second pointer or loss of the live
gate clears the response; returning gates cannot revive an old touch. It adds no
animation clock, saved setting or protocol field.

Debug/test assembly and lint pass. Nine focused phone tests pass in 33.03 seconds,
including native pixel comparison against rest and stronger confirmed PTT,
unchanged state/callbacks/bounds, cancellation and gate transitions, and existing
PTT/geometry/renderer-continuity tests. A physical ADB touch/release produces the
expected subtle response while the full preview state and revision remain equal.
A sampled empty-face pixel changes from RGB(16,19,17) to (21,25,19), then returns
to (16,19,17). Native rest/touch/released crops were visually reviewed.

Latest choices are restored and phone/host saved profiles remain byte-identical;
no Save or voice call was sent. Evidence: `/tmp/agentvoice-touch-build.log`,
`/tmp/agentvoice-touch-instrumentation.log`,
`/tmp/agentvoice-touch-phone-check.log`, `/tmp/agentvoice-touch-comparison.png`.

### Square portrait stage

Portrait reserves a screen-width square for Persona regardless of control height.
The deck stays bottom-aligned when there is room; overflow scrolls instead of
shrinking the square. Trace geometry uses the square center and actual deck top.
Landscape composition is deferred. Profiles, protocol and renderers are unchanged.

Debug/test APK assembly and lint passed. Eight focused physical-phone tests
passed in 28.087 seconds: a 320 × 600 dp portrait fixture retains a 320 × 320 dp
stage across 240/380/480 dp decks, scrolls to a working PTT hold/release, and
preserves placement settings. Existing connection, channel, native-view continuity
and Rocker touch/cancellation tests passed in the same run.

The restored native capture was visually reviewed at the operator's Contained
78%, −22 dp offset and 387 dp deck. This geometry has slight scroll overflow;
the Persona remains above the controls with traces between them. Installed APK
bytes match the local hash above. Latest live choices and both saved profile
files match fresh pre-install snapshots; no Save or call was sent.

Evidence: `/tmp/agentvoice-square-build.log`,
`/tmp/agentvoice-square-instrumentation.log`,
`/tmp/agentvoice-square-phone-check.log`,
`/tmp/agentvoice-square-phone-restored.png`.

### Independent landscape studio

Landscape places Persona beside the Rocker deck; a hidden side selection swaps
the lanes without mirroring icons or HUMAN/AGENT ordering. Portrait remains a
screen-width square. Geometry relocates over 320 ms, with gesture cancellation,
reduced-motion snapping and traces fading into the destination arrangement.
The native renderer remains the same instance when its selected variant remains
the same. Different per-orientation Halo variants intentionally select different
renderers. Portrait and landscape settings are independent under protocol/profile
11; device-observed orientation epochs fence edits and Save on both host and phone.

- Debug/test assembly and lint passed; 54 JVM tests passed.
- 669 repository tests / 8,840 assertions passed, including 40 configurator tests /
  1,718 assertions. Root/configurator typechecking and scoped Biome passed.
- The final complete physical-phone instrumentation run passed all 43 tests in
  86.949 seconds. A prior paused-clock scrolling test was corrected to use a
  nonoverflowing fixture; overflow remains separately tested. A subsequent run
  had three initial-touch failures and one missing-hierarchy failure. The affected
  group then passed unchanged (7 tests), followed by the complete passing run.
  The intermittent run is retained in the evidence rather than counted as passing.
- Headless Chrome against an isolated fake phone verified that two queued portrait
  edits are discarded when the first response returns a new landscape epoch.
  Active controls/reset follow landscape while the inactive portrait stays exact.
  No orientation or handedness selector is rendered; no Save was sent.
- Actual phone rotations report the visible orientation. A portrait request with
  its old epoch is refused after a portrait/landscape/portrait round trip without
  changing the phone revision. Temporary landscape settings and side comparisons
  were restored exactly. Both Contained landscape arrangements and the restored
  portrait were visually reviewed. A recorded portrait-to-landscape transition
  was sampled; Android also applies its own window-rotation animation. These
  samples do not establish every-frame visibility at all settings.
- Installed APK bytes match the hash above. Latest observed portrait choices,
  fully muted channel state, free system rotation mode and both exact saved files
  were restored. The host was rebound and the existing Chrome tab reconnected.
  No profile Save, voice call, production layout or Persona asset change occurred.

The existing conservative Original attachment envelope remains a limitation:
unequal state sizes can leave routes absent. This round does not solve it.

Evidence: `/tmp/agentvoice-orientation-{build,rebuild,tests,typecheck,lint}.log`,
`/tmp/agentvoice-orientation-instrumentation-confirm.log` (final complete run),
`/tmp/agentvoice-orientation-instrumentation-final.log` (earlier intermittent run),
`/tmp/agentvoice-orientation-focused.log`,
`/tmp/agentvoice-orientation-phone-check.log`,
`/tmp/agentvoice-orientation-browser.lYdHOv/evidence.json`,
`/tmp/agentvoice-orientation-landscape-{baseline,left,right}.png`,
`/tmp/agentvoice-orientation-transition.mp4`, and
`/tmp/agentvoice-orientation-restored.png`.


### Tide, themes and independent spacing

Protocol/profile 12 adds five independently resettable spacing values per
orientation. Only the deck and connecting routes use them; Persona's square,
size and manual offset retain their baseline geometry. PTT join spacing adds to
the deck's extent without rescaling its button faces. Impossible margins are
bounded by usable control width without rewriting requested values.

Tide places a measured lowercase `muted` inside a conservative clear aperture,
with a shared 14-second clock, 450 ms entrance and immediate removal when either
effective audio gate opens. Reduced motion is static; background/pending state
suppresses it. At sizes or font scales that cannot fit the word plus clearance,
the optional layer is omitted. Bright, Quiet and Grayscale theme both native Halo
variants and scene colors after channel following. Theme and Tide are session-only
experiments, shared across rotation and excluded from saved layout profiles.
Portrait reset/factory defaults adopt the operator's explicitly captured choices;
landscape keeps its independent baseline and existing profiles keep their values.

- 675 repository tests / 9,140 assertions passed, including 46 configurator tests /
  2,018 assertions. Root/configurator TypeScript and scoped Biome passed.
- 75 JVM tests passed with zero failures, errors or skips. Debug/test APK assembly,
  Android lint and unsigned release assembly passed. The release manifest excludes
  the preview activities; the theme/presence selectors remain debug-only. Original's
  optional color input keeps its production default palette unchanged.
- Final complete emulator instrumentation: **51 tests passed in 92.5 seconds**.
  Coverage includes native Original recoloring with unchanged paused silhouette,
  held pointer and native-view continuity, Tide motion/removal/reduced motion,
  background clock fencing, independent orientation profiles and stale-epoch
  rejection, reset/migration boundaries, geometry, real gestures and overflow scroll.
- Earlier failures are retained: the initial theme test used an incorrect 8-bit
  rounding tolerance; Tide's test tag was hidden by semantics clearing; a resumed
  clock frame could overwrite background reset. Those were corrected. Continuous
  animation also prevented automatic-clock tests reaching idle; the shared clock
  now uses Compose's infinite-animation API, while motion tests explicitly use a
  manual clock. A subsequent full run completed 51 tests with one fixture failure:
  changing traces also replaced the new tall default deck. The fixture now keeps
  its explicit fitting deck and changes only traces. The final complete run above
  uses that correction; aborted and failing runs are not counted as passing.
- Headless Chrome against an isolated phone fixture verified all five sliders,
  individual/group resets, session-only appearance across rotation, preservation
  of the inactive layout and rejection of queued stale-orientation edits. No Save.
- Actual native emulator screenshots were reviewed by the integration owner and
  three design reviewers. Bright retains lime/violet hierarchy; Quiet softens it;
  Grayscale keeps glyphs and captions stronger than Halo. Every RGB pixel in the
  Grayscale listening, speaking and muted captures has equal channel values,
  including maximum ambient glow. These captures do not establish OLED brightness
  or subjective comfort on the physical phone.
- At Contained 78%, Tide is readable with ample clear-center space; at 35%, it is
  omitted. Stills verify this sampled composition, not universal animation bounds.
  Maximum spacing/Splayed stance/foot spread keeps feet on their button tops in
  portrait and both landscape sides. Zero join adds no connector over the faces.
  The tall portrait deck intentionally scrolls below the screenshots; separate
  native gesture tests verify reachability. The conservative Original attachment
  limitation recorded above remains unresolved.
- Emulator comparisons were returned to provisional portrait and baseline landscape
  choices. No profile Save or phone operation occurred. The standalone emulator
  studio uses port 4318 and a disposable /tmp profile destination, separate from
  the disconnected physical-phone studio on port 4317. Physical-phone installation,
  fresh state preservation and final display review remain the delivery follow-up.

Evidence: `/tmp/agentvoice-round12-final-build.log`,
`/tmp/agentvoice-round12-fixture-build.log`,
`/tmp/agentvoice-round12-build-final.log` (release build),
`/tmp/agentvoice-round12-native-confirm.log` (final complete run),
`/tmp/agentvoice-round12-native-final.log` (one fixture failure),
`/tmp/agentvoice-round12-{tests,typecheck,lint}.log`,
`/tmp/agentvoice-studio12-browser.Kx52d9/evidence.json`,
`/tmp/agentvoice-round12-install-receipt.txt`, and
`/tmp/agentvoice-round12-visuals/` (native PNGs with state JSON, theme sheet and
Grayscale pixel measurements).


### S22 delivery of Tide, themes and spacing

After reconnection, the existing preview was brought forward without replacing
its session. Fresh snapshots captured both live orientation layouts, channel gates
and exact native/host saved bytes before installation. The installed S22 APK
matches SHA-256 `7ce2f79adae68f8b72b997267165ecb60fc94d0558f1167bc7fc017f4c5e4a8e`.
That phone host uses protocol 12.

Eleven focused physical-phone tests passed in 12.995 seconds: Tide/theme native
rendering and lifecycle, profile 12 migration and orientation fences, plus studio
trace/control independence, connection notices and square-stage overflow scrolling.
Actual S22 captures of all three themes in Listening and fully muted Idle were
reviewed, together with a Splayed spacing comparison. The word remains subordinate
and readable; spacing changes preserve manual Persona placement. These screenshots
establish rendered composition, not a user's subjective OLED brightness preference.

The original live mode and both open channel preferences were restored, together
with the exact portrait/landscape selections, adding only baseline spacing.
Bright/Tide are the new transient defaults. Native and host saved files remained
byte-identical; no Save or call occurred. System rotation settings were unchanged.
The new studio URL was opened in Chrome and the phone was left on its restored
native preview, ready for continued configuration.

Evidence: `/tmp/agentvoice-round12-phone-native.log`,
`/tmp/agentvoice-round12-phone-before-{state,phone,host}.json`,
`/tmp/agentvoice-round12-phone-restore.log`,
`/tmp/agentvoice-round12-phone-installed-sha.txt`, and
`/tmp/agentvoice-round12-phone/` (native captures and exact state JSON).


### Adjustable muted presence

Protocol 13 adds session-only text size, brightness, drift, breathing, cycle and
Float/Ripple controls. Saved profiles remain version 12. Defaults reproduce the
previous 14 sp Float treatment; individual and group resets preserve unrelated
choices. Contained's nominal aperture now follows its selected motion parameters,
with separate retained size/shape minima during deferred native updates. A geometry
review checked the bound against the pinned asset's hard strokes, including its
four-second listening loop and exits. Diffuse feathered glow can remain underneath.

- Debug/test assembly and lint passed. 86 JVM tests passed with no failures,
  errors or skips. 679 repository tests / 9,330 assertions passed, including
  50 configurator tests / 2,208 assertions; TypeScript and Biome passed.
- Complete API 35 emulator instrumentation passed **53 tests in 97.112 seconds**.
  New rendered-pixel checks establish that larger text draws more glyph pixels,
  brightness visibly increases, Ripple changes the word and reduced motion stays
  still. Full-scene edits retain the native Halo and manual stage bounds, while
  PTT removes the word immediately. Native protocol fixtures verify session
  restoration across rotation, profile exclusion and strict invalid-request refusal.
- A pure clock check verifies that changing the cycle preserves current phase and
  affects only future muted-motion increments, leaving other scene speeds alone.
  Geometry checks reserve combined drift, glyph wave and breathing before reducing
  motion, and never shrink the selected text size.
- An isolated browser fixture verified all five sliders, Float/Ripple, all six
  individual resets, group reset, disabled-but-retained controls when Off, and
  unchanged theme/layout/save state. The live Chrome accessibility tree also
  confirmed the emulator's acknowledged Ripple/24/65/200/70/10 selection.
- Native emulator comparisons cover baseline, larger Float, two Ripple phases,
  maximum 32 sp/brightness 100/drift 300/breathing 100/cycle 6, Quiet/Grayscale,
  and small/compressed placements where the optional text is omitted. The component
  designer reviewed the actual captures: complete glyphs, no observed slice seams
  or truncated strokes, readable wave and generous hard-ring clearance in these
  samples. Stills do not establish every possible transition frame.
- The isolated emulator is visible through scrcpy, with a temporary 24 sp Ripple
  example in the host studio on port 4318. Reset muted appearance returns the old
  baseline. No Save or phone operation occurred in this round; the phone was
  disconnected. Its protocol 12 studio remains separate on port 4317. Fresh phone
  state capture, protocol 13 installation and physical display review remain a
  follow-up when it reconnects. Bundled Rive bytes and production sources are unchanged.

Evidence: `/tmp/agentvoice-muted-tuning-{build,tests,typecheck,lint,native}.log`,
`/tmp/agentvoice-studio13-browser.2kvOs3/evidence.json`,
`/tmp/agentvoice-muted-tuning-visuals/` (raw captures, state JSON and comparison),
and `/tmp/agentvoice-muted-tuning-scrcpy.log`.


### S22 delivery of adjustable muted presence

On September 9 the operator reconnected and unlocked the S22. The owned
`agentvoice_round12_checks` emulator, its scrcpy window and port 4318 studio
were stopped at the operator's request; only the physical phone remained in ADB.
Fresh protocol 12 revision 502 captured both live layouts and exact saved files
before installing the protocol 13 debug APK, SHA-256
`8f94d5ffab5327db77b71dfbc9b830dc0f25969b68c24a71fb399c95f2f0d9e0`.

Ten focused physical-phone tests passed in **10.539 seconds**: muted typography
and motion rendering, profile 12/session restoration, Tide/theme lifecycle and
native-instance/manual-placement preservation. This is separate from the earlier
53-test emulator run. Native baseline and larger/brighter Ripple screenshots show
complete readable glyphs within the ring at the operator's geometry. A pre-existing
picture-in-picture window covers part of PTT in these captures; these images do
not establish unobstructed full-deck appearance. The unrelated overlay was left alone.

Restoration checks passed for both layouts, Splayed routing and its unsaved trace
values, theme, Tide, manual placement, motion/colors, and both muted channel gates.
Only the new muted-appearance defaults were added. Native and host saved files
remained byte-identical; no Save or voice call occurred. System rotation settings
were unchanged. The updated physical-phone studio was opened in Chrome.

Evidence: `/tmp/agentvoice-muted-tuning-phone-native.log`,
`/tmp/agentvoice-muted-tuning-phone-before-{state,phone,host}.json`,
`/tmp/agentvoice-muted-tuning-phone-restore.log`,
`/tmp/agentvoice-muted-tuning-phone/` (native captures and state JSON), and
`/tmp/agentvoice-muted-tuning-phone-studio.log`.


### Linked padding and muted-text dimming

Protocol 14/profile 13 was built and installed on the S22, debug APK SHA-256
`d162a1d13c19a3dc32d419b2676845efa2766ba59390ed15f5d4043fe7976b18`.
88 JVM tests and 682 repository tests / 9,404 assertions passed, including
53 configurator tests / 2,282 assertions. Debug/test assembly, Android lint,
TypeScript and Biome passed. An isolated browser fixture verified Custom without
an unsolicited edit, linked Padding/reset, unchanged section separation,
orientation fencing and negative brightness/reset.

The complete physical-phone run executed 54 tests: 53 passed and one historical
session fixture failed because it constructed a fresh landscape with linked padding
while simulating a pre-landscape session. The fixture now explicitly uses the
historical layout; all three lifecycle tests passed on rerun in 2.822 seconds.
The app APK did not change for this test-only correction. The complete run also
passed native negative-brightness pixel checks, profile 12 migration of unequal
layouts without file changes, protocol 13 live restoration, renderer identity,
manual stage and pointer/lifecycle checks.

Actual S22 captures compared Padding 8/16/32 and muted brightness 0/−50/−85.
The 16 dp scene shows consistent side and button-join spacing; the more negative
brightness visibly dims the word while retaining its complete glyphs. The Persona
stage and tuned values remain fixed; tall scenes retain scroll access to the padded
bottom. Section separation keeps its original range and semantics.

Fresh revision 1153 was captured before installation. Both layouts, custom
48% side / 200% edge / 18 dp button gaps, −6 dp Persona position, 29 sp muted
text with 166% drift, theme, mode and channel gates were restored. Both saved
files remained byte-identical; no Save, call or emulator operation occurred.
Trace fade behavior is unchanged in this round; its stronger-continuation request
is separately queued.

Evidence: `/tmp/agentvoice-padding-build-final.log`,
`/tmp/agentvoice-padding-{tests,typecheck,lint,native}.log`,
`/tmp/agentvoice-padding-lifecycle-confirm.log`,
`/tmp/agentvoice-studio14-browser.QHVKfY/evidence.json`,
`/tmp/agentvoice-padding-phone-before-{state,phone,host}.json`,
`/tmp/agentvoice-padding-restore.log`, and `/tmp/agentvoice-padding-phone/`.


### Stronger feeds and closer Contained body contact

Final installed debug APK SHA-256:
`82b0c06620034322f534f5e6c6647240b59654aa705447ff0547edf746469122`.
Debug/test assembly and lint passed. The preceding geometry build also passed
88 JVM tests; the final source change retained maxima unconditionally to cover
reduced-motion source debounce. The physical composition test passed in 13.459
seconds, exercising both variants, all route patterns and endpoint spacing extremes,
native-view identity, held controls, fixed stage and target bounds. Its first attempt
lost the Compose activity; the operator confirmed accidentally closing the app,
and the unchanged test passed on rerun.

The design reviewer inspected baseline, Idle, Listening, Speaking, speaking motion
0/100 with full idle motion, and shared size 35/120 native captures. Baseline and
Speaking now read as traces tucked under the lower arc; no trace intrusion into
the center was observed in these samples. Idle/Listening and some extremes retain
small standoff. Size 120 overlaps the control deck and its routes disappear rather
than painting through the center or buttons. No claim of every-frame contour
contact or universal Original attachment is made. Bundled asset and native
renderer sources remain unchanged.

Fresh live choices were captured again before the final install and restored after
comparison, including transient muted appearance and both orientation layouts.
Native and host saved profile bytes are unchanged. No Save, voice call or emulator
operation occurred.

Evidence: `/tmp/agentvoice-trace-contact-geometry-final-build.log`,
`/tmp/agentvoice-trace-contact-geometry-native-confirm.log`,
`/tmp/agentvoice-trace-contact-final-phone/`,
`/tmp/agentvoice-trace-contact-final-phone-before-{state,phone,host}.json`, and
`/tmp/agentvoice-trace-contact-final-restore.log`.


### Persona center indicators

Protocol 15 adds Words, Channel icons, Icons + words and Contacts beside unchanged
Tide/Off. Visibility is independently Both muted, Either muted (default), or Always.
These controls and appearance remain session-only; saved profile version stays 13.
Gate truth uses micOpen/speakerOpen, including held PTT. The layer adds no native
renderer changes, control targets, clock, audio or inferred attention state.

Build, both debug APKs and lint pass. **96 JVM tests** pass, including eight new
indicator-model tests. **684 repository tests / 9,496 assertions** pass, including
**55 host tests / 2,374 assertions**. Typecheck and Biome pass. A headless browser
checked every style/scope, conditional Show visibility, retained scope and isolated
appearance resets. Evidence: `/tmp/agentvoice-indicators-{build,tests,typecheck,lint}.log`
and `/tmp/agentvoice-studio15-browser.zJrf64/`.

The complete physical-phone suite now passes: **61 tests in 106.808 seconds**,
including actual glyph/contact pixels, scopes/PTT, retained Halo identity and held
pointer, strict session validation, lifecycle restoration and Save exclusion. The
first attempt was interrupted by the user's unplug; a second ADB output stream
also ended early after one Halo settling timeout. The clean run stored its output
on the phone and passed unchanged. This final result is
`/tmp/agentvoice-indicators-native-durable.log`; incomplete host streams remain
as diagnostic history rather than passing evidence.

Before installation, revision 495's current layouts and session choices were
captured in `/tmp/agentvoice-indicators-phone-before-state.json`, alongside exact
phone/host saved bytes in the same prefix's `-phone.json` and `-host.json` files.
These include 32 sp/−19 brightness/196 drift/65 breathing/13 s Float, Contained84%,
−6 dp placement and both muted gates. No Save was issued. The protocol 15 host is running again. Both visible and
inactive layouts, manual placement, palette/motion, Tide, session appearance and
both muted gates were restored exactly; phone and host saved files are byte-identical.
Restoration evidence: `/tmp/agentvoice-indicators-phone-check.log` and
`/tmp/agentvoice-indicators-phone/restored.{png,json}`.

The actual phone comparison covers all four styles and all four effective-gate
combinations, after rerunning captures interrupted by user interaction and checking
intended gates before every capture. At the operator's 32 sp/Contained84%, the
Words and Labeled blocks fit without clipping; Labeled also fits 29 sp/78% and is
omitted at35%. The sampled Original at14 sp fits. Quiet/Grayscale Labeled and a
mixed-gate Grayscale Contacts comparison retain shape differences. The native
renderer designer found no visual blockers in those samples. The independent
Contacts designer confirmed joined/lifted gaps remain legible in Grayscale and
recommended Channels for immediate clarity or Contacts for quiet character. Static captures
establish the sampled composition and readability, not every animation frame.
Screenshots and matching state JSON are in `/tmp/agentvoice-indicators-phone/`;
`full-options-sheet.png` and `center-options-sheet.png` assemble the comparison.


### Visible portrait layout and trace underlap

Portrait now anchors the deck and padding inside the safe viewport, with no page
scrolling. Requested deck dimensions fit proportionally only if the deck itself
exceeds that viewport; Persona's square/manual placement is unchanged. The square
may overlap foreground controls at large settings. Section separation is hidden
for portrait and stored unchanged. The Contained trace join uses a soft peripheral
underlap instead of reserving maximum speaking expansion; Persona-side end tabs
are gone. This is nominal attachment, not exact per-frame occlusion; short feeds
can remain visible just inside an expanding outer ring, while the core stays clear.
Original's prior unequal-state attachment limitation remains unchanged.

Build, both debug APKs and lint pass; **99 JVM tests** and the entire **61-test
phone suite in113.173seconds** pass. Native checks exercise full visible PTT,
max-height/padding, unchanged square bounds after swipe, native/gesture retention,
all existing indicator contracts and lifecycle behavior. **55 host tests /2,374
assertions**, typecheck and Biome pass. The isolated browser verified portrait
section hiding, landscape restoration and unchanged stored separation.

Actual phone captures at the operator's85%/M68/I69 and motion0/100 compare Idle,
Listening and Speaking. The lower-arc sheet shows the feeds meeting the peripheral
ring area instead of the earlier17–23dp standoff. At480dp controls, padding0/16/40
all leave PTT's full face/bottom border within the visible safe area. The layout
reviewer confirmed the expected foreground overlap with the lower ring at those
extremes; that is not scrolling or top-edge clipping. Manual placement and settings
remain unchanged. No native Persona assets or renderer code changed.

The fresh preinstall snapshot, including373dp controls, offset−17, selected Words,
85% size,80/68/68/69 motion and both open gates, was restored exactly. Both layouts
and session settings match; host/phone saved files are byte-identical. No Save,
voice call or audio. Evidence: `/tmp/agentvoice-visible-layout-{build,native}.log`,
`/tmp/agentvoice-visible-layout-phone-check.log`, snapshot prefix
`/tmp/agentvoice-visible-layout-before-`, captures/state JSON in
`/tmp/agentvoice-visible-layout-phone/`, and browser evidence
`/tmp/agentvoice-portrait-safe-browser.1C6hFv/`.


## Trace reach and fade controls

Protocol 16/profile 14 adds orientation-local reach −40..120 dp, fade length
0..80 dp and tip opacity 0..100%, baseline 0/12/0. Historical schema fixtures
validate the original shapes before adding only these defaults in memory.

- 105 JVM tests pass; debug app/test builds and lint pass. Root checks report
  687 tests, 0 failures, plus TypeScript and Biome. Included host tests report
  58 tests / 2,589 assertions. No production/main/release source changed.
- The complete corrected S22 instrumentation suite passes **65 tests / 108.152 s**
  against APK `b60ee4fe3fca55bbd08b65a735f6f05448219cc1272732522928391d8fd7e6b4`. Initial run had one test
  expectation at a duplicate gradient stop; the corrected test samples one pixel
  outside it. Renderer unchanged. New native tests verify byte-exact default
  brush pixels, partial/full tip opacity, hard edges and untouched underlying
  pixels inside a positive-radius disk. At radius zero, ink deliberately reaches
  the center. Existing gesture coverage now changes reach/fade/tip while PTT is
  held, retaining the native Halo instance and scene geometry.
- Native profile/session tests cover strict rejection, no partial mutation,
  independent portrait/landscape values, historical profile/session migration,
  restoration, explicit Save receipt and the 8 KiB reply bound. Save tests use
  isolated cache files; the operator's profiles are not their fixtures.
- Headless host UI evidence verifies all three controls/units, per-field and
  group reset, retained ambient glow, inactive layout and unrelated tuning,
  with no Save. Evidence: `/tmp/agentvoice-studio16-browser.PmTlTv/evidence.json`.
- Actual S22 captures compare reach −40/0/40/120, fade 0/80 and tip 0/50/100,
  plus offshoots and listening/speaking samples. One-variable pairs retain
  identical Persona/deck settings. Visual review confirms distinct route reach
  and opacity effects with stable button placement. Animated Halo frames differ;
  these stills do not establish exact moving-ellipse occlusion. Positive reach
  intentionally exposes more interior traces.

Evidence: `/tmp/agentvoice-trace-controls-{build,recheck-build,root-test,native-final}.log`,
`/tmp/agentvoice-trace-controls-phone/`, and
`/tmp/agentvoice-trace-controls-comparison.png`.

The actual phone was also rotated to landscape: baseline routes were absent
under that retained Original envelope, while reach80/fade32/tip70 exposed routes
and offshoots toward the ring. This verifies the landscape control path, not
automatic baseline attachment. Both orientation layouts, session appearance,
mode, mute gates and phone rotation lock were restored. Fresh operator choices
(78/56/78 sizes, −30 dp offset, 396 dp deck, 36.4% PTT, 17 dp padding and
Splayed/101 stance/250 weight/89 contact/200 feet) were retained. Phone and host
saved profile bytes compare exactly with the pre-install snapshot; no Save.
Final restoration receipt: `/tmp/agentvoice-trace-controls-phone-check.log`.


## Center status text fitting

Words was eligible under the operator's any-muted scope, but its selected 32 sp
block did not fit the conservative aperture at Contained 79 / spread 80 / pulse 68 /
speaking 68 / idle 69. Status indicators now fit down to a 12 sp minimum, preserving
the selected preferred size and 8 dp clearance. Words reserves the longest
two-line label to avoid enlargement when switching to “live”. Tide unchanged.

The installed APK at the top passes debug/test builds, Android lint and 105 JVM
tests. Targeted S22 instrumentation reports **7 tests / 27.036 s**: all center
indicator tests plus held-control/native-instance composition coverage. The new
pixel regression uses the operator’s 32 sp / −19 brightness / 196 drift / 65 breathing
values, tests tight aperture rendering at Android font scales 1 and 1.5, checks
all sampled motion phases stay inside the aperture, and retains the preferred
size. This round did not rerun the full phone suite. Root Biome passes.

Actual restored-phone capture shows “human muted” inside the ring, where the
previous build showed no text. Both layouts, latest live choices and gates are
restored; host/phone saved files compare byte-identical, no Save. Evidence:
`/tmp/agentvoice-words-fit-{build,native,phone-check}.log` and
`/tmp/agentvoice-words-fit-phone/restored.png`.

## Shared appearance and orientation layout

Protocol 17/profile 15 separates shared appearance from local geometry. Traces,
glow, Halo appearance and lighting each support explicit orientation overrides;
Persona size/position and control spacing/dimensions stay orientation-local.
Landscape uses a horizontal position control; portrait retains vertical position.
Legacy profiles migrate in memory, without an implicit Save.

- 111 JVM tests, Android debug/test builds and lint passed.
- 694 repository tests passed; repository and configurator typecheck/Biome passed.
  Host-specific coverage: 65 tests / 2706 assertions, including scope toggles
  followed by queued edits, migration, reset and stale-orientation handling.
- Corrected full physical S22 instrumentation: **69 tests / 119.802 seconds**,
  `/tmp/agentvoice-shared-native-final.log`. Three new session tests exercise
  shared/local edits, override snapshots/rejoining, strict receipts and migration.
- Actual phone comparisons at horizontal offsets -55/+55 dp show the Persona,
  indicator and trace contact moving together while the control deck stays fixed.
  Shared glow edits reached portrait; a landscape-only override left portrait
  unchanged; removing it rejoined the common value. Native stills are under
  `/tmp/agentvoice-shared-phone/`; browser scope/axis/narrow evidence is under
  `/tmp/agentvoice-studio17-browser/`. These are sampled synthetic compositions,
  not proof of every transition or universal trace contact.
- Restored both orientations' pre-install unsaved tuning, shared session choices
  and mute gates, including the inactive landscape geometry. Phone and host saved
  profile bytes match their pre-install snapshots exactly. No Save. Original
  accelerometer/user-rotation settings restored to 1/0.
- No production media, transport or Persona asset/renderer changes in this round.

## Coordinated switch sounds

Protocol 18/profile 16 adds shared Off/Rocker29/Rocker13 and level settings,
with Reset sounds and explicit Save. Debug-only local SoundPool playback uses
the same mute click for both controls and distinct PTT down/normal-up cues.
Original/Contained rendering, appearance inheritance and layout are unchanged.

- **115 JVM tests passed**, debug/test builds and lint passed; release built.
  `/tmp/agentvoice-sounds-build.log`, `/tmp/agentvoice-sounds-test-build.log`,
  `/tmp/agentvoice-sounds-release-lint.log`.
- **698 repository tests passed**, root TypeScript/Biome passed. The host subset
  has **69 tests / 2854 assertions**, covering legacy Off/70 migration, strict
  receipts, shared scope, save/dirty/reset and rotation/reconnection retention.
  Browser evidence: `/tmp/agentvoice-studio18-browser/evidence.json`. No browser
  audio or audio asset requests; user gestures on the phone own audition.
- Eight focused S22 sound tests passed; final full phone suite: **77 tests /
  140.425 seconds**, `/tmp/agentvoice-sounds-native-final.log`. Native tests load
  all six samples and verify nonzero SoundPool stream allocation at low gain;
  injected-output gesture tests check same mute cues, paired PTT down/up, and
  silent cancellation/outside/second-pointer/disposal/live-mic touch. Pure tests
  cover Off/zero/background, stale settings, unavailable samples and orphan-up
  prevention. These checks establish decoding and dispatch, not perceived
  loudness, speaker quality or real-call acoustic pickup.
- The first full run had one `No compose hierarchies found` failure midway
  through the existing composition-held-pointer test. It passed in isolation
  (16.569 seconds) and in the subsequent complete run, without source changes.
  That initial run is retained at `/tmp/agentvoice-sounds-native-full.log`;
  do not count it as passing or claim an identified root cause.
- All six APK WAVs match the specialist's cleared SHA-256 receipt. CC0 license
  and provenance are packaged alongside them. Release contains no switch-sound
  assets; native player source exists only in debug. Receipt:
  `/tmp/agentvoice-sounds-asset-check.json`.
- Physical phone taps and a 350 ms PTT press/release exercised each family,
  then restored every prior design field, both unsaved layouts, session choices
  and gates. Saved phone/host files remained byte-identical. Rocker29/70 is left
  selected only as an unsaved audition. Rotation settings restored to1/0.
  `/tmp/agentvoice-sounds-phone-check.json` records the comparisons; reviewed
  final native screenshot: `/tmp/agentvoice-sounds-phone/ready.png`.
- Noizey received exclusive phone use after verification/restoration through
  `/tmp/noizey-phone-handoff.txt`. AgentVoice's transport-only reconnect loop
  does not relaunch the app or replay settings while another app is foreground.

### Shared spacing, landscape columns, optional PTT and directional sounds

Protocol 19/profile 17 implements shared spacing without orientation overrides,
removes offshoots, adds session-only PTT visibility, and uses mute on/off plus
PTT down/up for both cleared sound families. Landscape stacks HUMAN/AGENT in
the near column with full-height PTT at the outer edge; routing transposes the
portrait engine. These remain debug studio experiments.

Final debug APK SHA256:
`5ce5dd8871026dfedcce44c2e9b4ac5f104d7aa1d72ecbaff2e3dc02333bdb80`.

- Android debug/test APKs build, lint passes; 119 JVM tests pass. Release builds.
- Final physical S22 instrumentation: **80 tests pass**, 144.191 seconds. The
  initial targeted run found a portrait fixture running in landscape, a
  subpixel width tolerance and old independent-spacing expectations. Fixtures
  now explicitly cover their intended layout/normalized spacing. An initial
  full run also lost a Compose hierarchy during operator interaction (causation
  not established), plus one more stale migration expectation. After fixture
  correction and an undisturbed rerun, the full suite is green.
- Root: 704 tests / 10,061 assertions, typecheck and lint pass. Configurator:
  75 tests / 2,939 assertions; host typecheck/Biome pass. Browser fixture covers
  shared edits/resets both directions, local geometry, rotation fences,
  reconnect without replay, visibility retention and disabled share controls,
  no offshoot UI/requests, and no Save/audio/overflow/page errors.
- Native screenshots reviewed at operator geometry: portrait shown/hidden,
  landscape shown/hidden, mirrored landscape and shared padding after rotation.
  Stacked mutes stay nearest Persona and the PTT column stays at the far edge.
  Captured routes meet the side of the ring without crossing its clear center;
  this is evidence for sampled poses, not every possible animated setting.
  Hidden portrait intentionally uses the full selected deck height for mutes.
- Real phone taps exercised both directions on both mute switches for each
  family, followed by ordinary PTT press/release. Instrumentation verifies cue
  direction/order, cancellation and all eight native streams. No subjective
  phone-speaker or voice-call acoustic-pickup claim.
- All eight debug WAVs match the specialist receipt and APK bytes. Previous
  PTT bytes and the renamed on cues are unchanged. Release APK contains neither
  switch-sound assets nor checked preview classes.
- Fresh pre-install snapshot restored in both orientations, including sizes,
  manual offsets, appearance overrides, center indicator, theme, mute gates,
  Rocker29/70 and activity. Only retired offshoots are dropped and landscape
  spacing adopts portrait's exact object (linked Padding 17). PTT is left shown;
  the checkbox is available for experimentation. Phone and host saved files
  remain byte-identical. No Save. Original rotation settings restored
  (`accelerometer_rotation=1`, `user_rotation=0`). Phone access released and
  completion notice saved to AgentNotify; optional system banners were off.

Evidence: `/tmp/agentvoice-columns-final-build.log`,
`/tmp/agentvoice-columns-test-rebuild2.log`,
`/tmp/agentvoice-columns-instrumentation-final.log`,
`/tmp/agentvoice-columns-release.log`, `/tmp/agentvoice-columns-assets.log`,
`/tmp/agentvoice-columns-root-tests.log`,
`/tmp/agentvoice-columns-configurator-tests.log`,
`/tmp/agentvoice-studio19-spacing-browser/evidence.json`,
`/tmp/agentvoice-columns-phone-check.log`, and the native PNG/JSON pairs under
`/tmp/agentvoice-columns-phone/`. The live host was restarted on the new protocol
and its current URL opened in Chrome; saved URL handoff files were refreshed.

### Landscape width with automatic height

Landscape now interprets the orientation-local deck extent as width; portrait
continues to use height. Landscape fills the safe vertical viewport inside
shared padding, anchors at its outer edge, and fits requested width within the
existing lane/section separation. Persona placement is unchanged. The studio
labels the dimension on rotation; stored numbers and protocol/profile stay intact.

Debug APK SHA256:
`baabe2c210602c3a6520b4dc0c86d18131c4a0bae14effd382ea32f5f901ff48`.

- Debug/test builds and lint pass; 120 JVM tests pass. Two old geometry fixtures
  assumed a fixed 262 dp height or a hard-coded overlap offset; they now use the
  actual fitted deck bounds/contact position. A new test checks widths 240/320,
  padding 0/16/40, both sides, fixed Persona and equal vertical/outer clearances.
- 13 targeted physical S22 tests pass in 46.394 seconds: visibility, controls,
  orientation/native-instance continuity, composition, sound gestures and trace
  join painting. The landscape controls test deliberately requests 240 while
  providing 300 vertical dp and verifies the height fills all 300 dp.
- Configurator: 75 tests/2,939 assertions, typecheck and Biome pass. Browser
  fixture confirms Controls width plus padding help in landscape, Controls
  height in portrait, and existing scope/rotation/reset/visibility behavior.
- Native captures reviewed at requested widths 240, 300 and 480 (the latter
  fitted to the available lane), padding32, mirrored landscape and portrait.
  Top/bottom padding controls height independently of width; visible captions,
  PTT and traces remain coherent in these samples.
- Both latest layouts, session values and mute gates restored exactly. Phone
  and host saved files remain byte-identical; no Save. Original system rotation
  values restored (accelerometer_rotation1/user_rotation1). Phone released.

Evidence: `/tmp/agentvoice-width-build-final.log`,
`/tmp/agentvoice-width-instrumentation.log`,
`/tmp/agentvoice-width-host-tests.log`, `/tmp/agentvoice-width-browser/`,
`/tmp/agentvoice-width-phone-check.log`, and PNG/JSON pairs under
`/tmp/agentvoice-width-phone/`. Current studio URL handoffs were refreshed and
opened in Chrome.

## Independent control extents

Protocol 20/profile 18 retain separate shown/hidden PTT deck extents within each
orientation. Legacy profiles seed the added field from their own orientation's
existing size in memory. Current fields accept 160–1600 dp; historical profiles
retain strict 240–480 validation. The active slider and reset affect only the
visible mode. Hidden reset preserves PTT share. Shared padding stays common.

Landscape no longer reserves a half-screen lane. The deck can overlap Persona
in the foreground and is fitted only to the viewport minus shared padding.
Persona's square and manual placement remain unchanged. Narrow mute faces stack
labels; shallow mute/PTT faces reduce type and glyph size. Ordinary-size caption
checks remain in the regression suite.

Validation:

- Debug/test APK assembly and lint passed; latest build log:
  `/tmp/agentvoice-independent-caption-build.log`. 122 JVM tests passed with no
  failures (`/tmp/agentvoice-independent-delivery-build.log`). Later changes
  affected only Compose caption layout and its instrumentation tests.
- The final installed APK passed all **84 phone tests in 141.13 seconds**:
  `/tmp/agentvoice-independent-delivery-instrumentation.log`. Tests include four
  retained extents, strict profile migration, legacy live-state restoration,
  width beyond the midpoint in both handedness settings, fixed Persona bounds,
  hold cancellation/reentry, native instance continuity and 1.5× text at narrow
  and shallow extremes.
- **80 studio tests / 3051 assertions**, TypeScript and Biome checks passed.
  Browser fixture evidence in `/tmp/agentvoice-studio20-extents-browser/` records
  47 preview requests, no Save, four extents, active-only resets, orientation
  fences, reconnect behavior and no page overflow/errors.
- Earlier runs exposed a historical fixture leaking the new field and compact
  caption layout/fit problems; these were corrected before the final suite.
  Transient missing Compose hierarchy/presence failures from an earlier run
  did not recur in the final suite; no Persona renderer change was made.

The extent range permits intentional overlap and very small text at extreme
settings; these checks do not establish optimal readability for every combination
of padding, split, device size and system text scale. Live-call behavior and
subjective switch-sound quality are outside this synthetic layout round.

Live exercise/restoration passed (`/tmp/agentvoice-independent-phone-check.log`).
Native captures in `/tmp/agentvoice-independent-phone/` were reviewed for shown/
hidden portrait and landscape, 600 dp width, mirrored width, 160 dp minimums
at both split endpoints and the 1600 dp viewport limit. Wide controls correctly
occlude Persona; compact captions remain inside their sampled faces. Both
orientation layouts, unsaved session values and mute gates were restored, followed
by exact original rotation settings. Phone and host saved files remained byte-for-byte
unchanged. Host profile SHA-256:
`f6a1d6fd6ee0cca1b319a176327b81beb4e7fe6d30d5b14a4ba34c2ddf97a951`.
No Save was issued.


## Icon auditions

Protocol 21 adds session-only channel and PTT icon choices; saved profile 18 is
unchanged. The pair choices are Current, Engraved, Phosphor Bold/Fill, Boatman and
i cons. PTT independently selects Current press, Contact or Matching microphone.
The central indicator follows the same family using effective channel gates;
Rockers retain persistent mute truth. The renderer instance, geometry, input
semantics, labels, Halo assets and production source are unchanged. Launcher
studies remain browser-only; the installed launcher is unchanged.

- Combined debug build, Android lint and 122 JVM tests passed. Log:
  `/tmp/agentvoice-icons-polish-build.log`.
- Before the final one-asset Boatman mute cleanup, all 88 instrumentation tests passed on the temporary 540×960 / 240 dpi API 35
  ARM64 emulator in 144.361 seconds. Log:
  `/tmp/agentvoice-icons-emulator-full.log`. The four focused icon tests separately
  passed in 23.632 seconds. They verify strict session/rotation/restore and Save
  exclusion, real Compose transparency under uniform tint on a nonblack surface,
  readable/dismissible credits, and native Persona/pointer/bounds continuity while
  changing every family/PTT combination during a local held gesture. Remote
  preview commands retain their existing intentional hold cancellation.
- 715 repository tests passed; the subsequent final studio suite passed 87 tests
  / 3,581 assertions after SVG accessibility metadata was added. Root and studio
  TypeScript checks and full root Biome passed. Logs:
  `/tmp/agentvoice-icons-root-tests.log`, `/tmp/agentvoice-icons-final-studio-tests.log`,
  `/tmp/agentvoice-icons-root-typecheck.log`, `/tmp/agentvoice-icons-final-studio-typecheck.log`,
  `/tmp/agentvoice-icons-root-lint.log`.
- Browser fixture checks cover all six families, PTT independence, named previews,
  source/license links, rotation/reconnect/hidden retention, scoped resets,
  one-shot Credits guards, no Save dirty effect, no remote image/audio requests,
  narrow layout and browser-only launcher isolation. Evidence:
  `/tmp/agentvoice-studio21-icons-browser/evidence.json`.
- All original Phosphor and Noun assets are preserved with hashes/licenses.
  The portable Noun normalization helper regenerated all 16 SVG/XML files
  byte-for-byte. Its 40 size comparisons and 20 clipping comparisons verify
  vector conversion, not display quality. The debug APK contains byte-exact
  packaged icon notices and full license texts. Host Phosphor/Engraved SVG copies
  have additional accessible metadata; parity tests confirm unchanged geometry
  and paint. Noun host copies match the final revision 3 normalized receipt exactly.

The initial phone release was honored and a separate emulator controller was used.
After the phone returned, a fresh live snapshot and both saved byte copies were
captured at `/tmp/agentvoice-icons-phone-before-{state,host,phone,rotation}.json`.
The host profile and phone saved profile both retain SHA-256
`f6a1d6fd6ee0cca1b319a176327b81beb4e7fe6d30d5b14a4ba34c2ddf97a951`.
Current focused physical-phone evidence is `/tmp/agentvoice-icons-phone-focused.log`.
The incomplete run in `/tmp/agentvoice-icons-phone-full.log` lost its ADB transport;
its on-device log has missing Compose hierarchies after the interruption. The
subsequent keyguard-blocked attempt is also excluded. No implementation assertions
were weakened; the subsequent unlocked run passed all 88 tests in 173.906 seconds
(`/tmp/agentvoice-icons-phone-unlocked-full.log`).
No icon choice has been adopted as a production default or written by Save.

Final physical-phone captures in `/tmp/agentvoice-icons-phone/` cover all six
families live/muted, Contact, quiet/grayscale themes and landscape/mirrored/hidden
layouts. Two designers reviewed the supplied S22 screenshots without finding a
fit blocker. Revision 3 removes Boatman's detached muted wave fragments; i cons
offers simpler silhouettes and Engraved the closest mechanical styling match.
These are screenshot reviews, not an operator preference or direct display judgment.
The actual host Credits command opened the native linked dialog, and Android Back
dismissed it. The final `restored.png` was inspected after both layouts, unsaved
session choices, gates and Current/current icons were restored exactly. The phone
and host saved bytes remained identical; no Save occurred. Rotation values were
restored to accelerometer_rotation 0 / user_rotation 0, and stay-awake to its
original value 7. `/tmp/agentvoice-icons-phone-check.log` records the exercise and
restoration. The temporary emulator is destroyed; the physical preview and live
studio remain available, and phone access is released.


## Shipping adoption

The complete canonical profile is `design/shipping-profile.json` (SHA-256
`aade6ae0df2e336dd618512efd62c6477dae1ae3c49c3779793ad97581fe6c1d`).
`design/shipping-provenance.json` preserves the original version 18 source bytes
and captured visual-choice provenance. Effective portrait/landscape layouts and
sounds matched that original saved source before promotion. Icons, theme, center
form/scope/tuning and PTT visibility were added from the user's explicitly adopted
live session, rather than falling back to the earlier unsaved defaults.

- Combined debug/release builds, 122 JVM tests and Android lint passed in
  `/tmp/agentvoice-shipping-final-build.log`. A subsequent notice-only APK rebuild
  corrected Contained's shipping attribution (`/tmp/agentvoice-shipping-notice-build.log`).
- The 95-case phone run in `/tmp/agentvoice-shipping-phone-final.log` passed 92.
  Three historical fixture expectations still mixed newly adopted defaults or
  omitted the newly file-owned savedAppearance argument. Fixed historical fixtures
  now pin their original values. The final 18-test run in
  `/tmp/agentvoice-shipping-phone-verified.log` passed in 9.246 seconds and includes
  all three previously failing cases, complete-profile persistence/reload/reset,
  and production setup, Credits, acknowledged mute sounds and PTT ownership.
  No failing product assertion was removed. The preceding initial run also
  exposed old hardcoded defaults and an aperture test that needed its original
  explicit motion fixture; those checks passed in the 95-case rerun.
- Final installed debug APK SHA-256:
  `e254372d729448b88ae4472cff9b00988300e19741b4d190069d299fc9d499f5`.
  Its DEX files are byte-identical to the APK used by the 95-case run
  (`c9c5863023118ac7a845744862884892ec50de27fa1c4fcac865eb76b38a6646`);
  the final 18-test run used the notice-corrected installed APK.
- 727 root tests, 98 studio tests / 3,694 assertions, root/studio typechecks and
  Biome passed. Root logs: `/tmp/agentvoice-shipping-root-tests.log`,
  `/tmp/agentvoice-shipping-root-typecheck.log`, `/tmp/agentvoice-shipping-final-lint.log`.
  Browser Save/dirty/adopted-default/reconnect checks passed at
  `/tmp/agentvoice-profile19-browser/evidence.json`.
- Deterministic promotion and `generate --check` passed. Gradle now checks this
  before builds. `scripts/verify-shipping-apk.py` found only the selected four
  Rocker 13 WAVs, selected four channel glyph resources, and exact selected
  notices/licenses; no Studio bridge/session/activity, profile JSON or alternate
  icon resources. R8 usage confirms removal of DesignProfileSupportKt,
  PreviewOrientationKt and PreviewSharedAppearanceKt. Small shared presentation
  branches remain; universal elimination of every unselected code branch is not claimed.
- Release APK is 47,350,973 bytes (both supported ABIs), SHA-256
  `97e6cfcb1a872bf993f6542a1424af99dc3f87bac4955b24e34e92e2adea060d`.
  Receipt: `/tmp/agentvoice-shipping-apk-audit.json`. It remains unsigned; no
  release-signing or distribution configuration was changed.

Actual native+host Save upgraded the user's requested profile and phone copy to
version 19. Both copies are byte-identical, SHA-256
`0bc3410da7e931c0e90867b3c199b0e4e43e4436f8ff8eb4a28b30f26455c53c`.
Every effective layout, sound and visual field matches the canonical shipping
profile; only Save metadata/serialization differs. The app was then force-stopped
with no call active and reopened through a fresh Studio binding. All choices
reloaded from disk before any restoration command. Logs:
`/tmp/agentvoice-shipping-save-check.log` and `/tmp/agentvoice-shipping-cold-reload.log`.

Physical production-composable fixtures were inspected in portrait and landscape
at `/tmp/agentvoice-shipping-captures/production-{portrait,landscape}.png`.
The real protected MainActivity exposes explicit Start/import and Credits, verified
through UI semantics without bypassing screenshot protection or starting a call.
`restored.png` records the retained Studio with adopted values and original
synthetic gate choices. Original system rotation (user_rotation 1,
accelerometer_rotation 0) and stay-awake 7 were restored. No emulator was created.
Phone access is released. Real spoken-call/audio routing acceptance remains a
separate pre-existing limitation; rendered fixtures do not establish acoustic quality.


## Relay Aperture follow-up

The operator selected Relay Aperture explicitly. Protocol 23 / profile 20 now
captures launcher selection in Save/dirty/reset/reload and generates only the
selected adaptive foreground, Android themed monochrome layer and legacy fallback.
The previous waveform drawable was removed. All existing design tuning is retained.
The failure presentation also shows an explicit End attempt action when the server
reports failed/stopped, instead of displaying Connecting indefinitely.

- Combined debug/release builds, 122 JVM tests and Android lint passed. A subsequent
  packaging rebuild removed the obsolete waveform resource. Logs are under
  `/tmp/agentvoice-relay-adoption/{build,package-final}.log`.
- The first targeted phone run lost its Compose foreground hierarchy; inspection
  found Recents foregrounded. It was stopped, not counted as passing. The clean
  rerun passed all 47 selected tests in 43.759 seconds, including native launcher
  pixels/themed layer, full profile Save/reload/legacy19 handling, failure UI,
  icons, orientation, sounds, extents and lifecycle checks. See `phone-tests-rerun.log`.
  A final test-only refinement allows future launcher promotion without requiring
  Relay forever; its Relay pixel assertions are unchanged, and compilation passed.
- 102 Studio tests / 3,823 assertions, root/studio typechecks and Biome passed.
  Browser Save/dirty/reset/reconnect evidence is
  `/tmp/agentvoice-launcher-profile20-browser/evidence.json`.
- Installed debug APK SHA-256 is
  `94c003fad4d1f3f64909e020189e0bf0877de8a0ce34637819105fb33f38ad01`.
  Release audit passed: SHA-256
  `a164422020618df58bbdb8514bba0707e4cddf3663af8da45079d035bc495e1d`,
  47,352,673 bytes, selected launcher/resources and sound quartet, no Studio
  entrypoints/profile JSON/alternate icon assets. Audit: `apk-audit.json`.
- The native package-manager launcher drawable was rendered and visually inspected
  in `/tmp/agentvoice-relay-adoption/launcher.png`; this is installed resource
  evidence, not a screenshot of the Samsung home-screen icon cache.
- Real native+host Save upgraded both copies byte-identically to profile20, SHA-256
  `fa90da13aee5d0282945f11639290083cde58dcb5075ec48854411f7c8ec1b42`.
  A structural comparison with the preserved operator profile19 found changes only
  to version, launcher and Save timestamp. Both layouts and all seven shared
  visual fields match the canonical shipping profile. See `save-check.log`.
  Rotation1/auto0/stay-awake7 were restored. Studio remains available; the real
  MainActivity was reopened at Start voice, with its existing device grant retained.

The user's failed attempt reached the tailnet backend; server discovery reported
failed with no loaded threads. Sanitized startup observations showed mandatory
AgentVoice control ready before `mcpServerStatus/list`, but the catalog RPC exceeded
its five-second deadline while other MCP startup remained outstanding. The separate
server commit `74ec414` increases the total bounded readiness allowance to60 seconds,
keeping exact auth/catalog checks and the enclosing90-second activation cap.
Focused server/runtime/frontend tests passed29 cases/245 assertions; typecheck and
scoped lint passed. Only that fix was cherry-picked to the clean installed main
checkout as `6759151`, and the idle default service was restarted successfully.
No config, role or grant changes were made. A successful subsequent real voice call
was not established by these automated/installation checks; user retry remains
the end-to-end confirmation.


## Status polish

The PTT face no longer substitutes Updating controls/Updating during a mute
acknowledgement. It retains Push/to talk while the microphone is closed and
Live now while the effective microphone gate is open. Gesture acceptance,
acknowledged gate ownership, cancellation and held-PTT feedback are unchanged.
The top notice follows the displayed Persona stage center, including landscape
side, horizontal tuning and existing geometry interpolation; its container is
clamped to the visible safe viewport. Portrait stays centered.

Debug/release builds and Android lint passed (`/tmp/agentvoice-status-polish-build-final.log`).
All 15 targeted physical S22 tests passed in 20.52 seconds, covering both text layouts
with pending acknowledgements, both landscape sides and offsets, touch/hold
ownership, notice lifecycle and production controls. Test log:
`/tmp/agentvoice-status-polish-phone.log`. Native portrait/landscape connecting
captures were visually inspected at `/tmp/agentvoice-status-{portrait,landscape}.png`.
These screenshots use Studio simulation; no new real call was started.

Installed debug APK was read back and matched SHA-256
`5b0e632b8b9b67e9d2f7325f4131dc3f693e799eb21db4c5b0c410a7abab1b8e`.
Release SHA-256 is `3ccdf980748c2bd35cd7e229639993b5b241331216e646856e739494be7946cb`;
selected-only resource/notice audit passed (`/tmp/agentvoice-status-polish-apk.json`).
The phone and host saved profiles remain byte-identical to their pretest copies;
no Save occurred. Studio state and rotation 1 / auto 0 / stay-awake 7 were restored,
and real MainActivity reopened ready for an explicit call. No emulator was used.

## Durable Studio drafts and Reset to production — September 10, 2026

Protocol24/profile20: every acknowledged design edit persists atomically in a
separate debug working draft. Full production reset covers both layouts, shared
appearance, exact override flags, all seven visual choices and sounds. Explicit
phone/host Save checkpoints remain independent. Explicit promotion and the new
code-only `shipping.ts release` advance the Studio generation; ordinary builds
and same-generation reinstall preserve it. The preceding-generation draft is
retained separately for recovery.

Verification:

- Debug/release/test APK builds, 122 JVM tests (zero failures/errors/skips), and
  Android lint passed: `/tmp/agentvoice-studio-draft-build-final.log`.
- 105 host tests / 3,844 assertions passed, including promotion versus regeneration,
  code-only release isolation and fenced reset/checkpoint preservation:
  `/tmp/agentvoice-studio-draft-host-final.log`. Root/host TypeScript checks and
  scoped Biome checks passed.
- Physical S22 instrumentation: 20 tests passed in 3.242 seconds, including six new
  draft tests plus Save, activity lifecycle, orientation and shared appearance:
  `/tmp/agentvoice-studio-draft-instrumentation.log`. Tests isolate their files;
  the activity fixture preserves/restores the operator draft.
- Actual phone bridge checks exercised different portrait/landscape sizes, a local
  Halo override, side/offset, hidden PTT extents, theme/indicator/icons/launcher and
  sounds. Force-stop/relaunch and same-production APK reinstall retained them;
  full reset and another force-stop/relaunch restored production exactly:
  `/tmp/agentvoice-studio-draft-phone.log`. The initial scratch harness used the
  wrong connection-wrapper accessor and exited before edits; the corrected run
  above passed. New-generation behavior was tested with isolated draft-store and
  promotion fixtures, not by changing the operator's production receipt.
- A local isolated Chrome/Playwright check verified actual checkbox edit, draft
  feedback, browser reload and Reset to production. Desktop/narrow screenshots
  and zero page errors: `/tmp/agentvoice-studio-draft-browser.log` and
  `/tmp/agentvoice-studio-draft-evidence/browser-{desktop,narrow}.png`.
  The remote browser provider could not reach this host's loopback service; its
  disposable session was closed before the local browser check.

Installed debug build SHA-256:
`2361b13cedaea87ff84200ac1326d4955fea5eb40649fc80c0ee951754a5790b`.
Release remains byte-identical to the prior artifact:
`3ccdf980748c2bd35cd7e229639993b5b241331216e646856e739494be7946cb`.
Selected-resource/license audit passed and now also checks `StudioDraft` and
`StudioProduction` absent from release:
`/tmp/agentvoice-studio-draft-apk-audit.json`.

Both exported checkpoint copies remain unchanged at SHA-256
`fa90da13aee5d0282945f11639290083cde58dcb5075ec48854411f7c8ec1b42`.
Final phone capture was inspected at
`/tmp/agentvoice-studio-draft-evidence/phone-final.png`. Studio was left open at
production settings, system user rotation0/auto1 restored to the values observed
before testing, and desktop Studio opened for the operator. No real call or
emulator was used. Phone access was released and a completion notification stored
in AgentNotify (optional macOS banners disabled).

## Separate Studio app; manual-only production reset — September 10, 2026

The operator superseded automatic refresh on production promotion. Existing
Studio drafts now always win; only an explicit Reset to production changes them
to the bundled production design. Draft2 removes the generation marker; draft1
ignores its old marker without rewriting the file on load. The release-reset
command and generated generation constant are removed. New installations still
need an initial seed; they use production only when no draft exists.

Two apps are installed on the S22:

- **AgentVoice**: local signed, optimized `production` APK, package
  `com.arthack.agentvoice.dev`. Existing application identity, Android Keystore
  and permissions are retained. Its only launcher is MainActivity. A cold launch
  displayed **Start voice**, confirming the encrypted grant still loads; no call
  was started.
- **AgentVoice Studio**: `studio` APK, package `com.arthack.agentvoice.studio`,
  separate private data and a tuning-ring launcher. Its only launcher opens
  PersonaPreviewActivity. Packaged manifest has no Internet, network-state,
  microphone or Bluetooth-connect permissions and no real MainActivity.

The latest old-app draft and explicit checkpoint were copied byte-for-byte into
Studio before replacing the combined .dev build. No grant was copied. Old draft
values were verified against the migrated profile, including both layouts,
overrides, sounds, launcher and visual settings. Both launcher activities were
resolved independently through PackageManager.

Studio persists its private, synthetic-only browser binding separately from the
design profile. Actual phone checks edited the draft, force-stopped Studio and
opened its launcher without extras: the same running host reconnected and kept
the edit. Reinstalling Studio did the same. The exact original design was then
restored; host and Studio exported checkpoints remained unchanged. No Reset or
Save was used on the operator's design during these checks. Evidence:
`/tmp/agentvoice-separate-studio-phone.log`; final native capture inspected at
`/tmp/agentvoice-separate-studio/studio-phone-final.png`.

Checks passed:

- Studio/production/release/test APK builds, lintStudio/lintProduction and all
  122 Studio JVM tests: `/tmp/agentvoice-separate-studio-build.log`.
- 20 targeted Studio-package native tests / 3.766 seconds, including retained
  drafts across different production defaults, historical draft markers, full
  reset, Save, lifecycle, shared appearance and orientation:
  `/tmp/agentvoice-separate-studio-instrumentation.log`.
- 105 host tests / 3,840 assertions, host typecheck and scoped Biome checks:
  `/tmp/agentvoice-separate-studio-host-final.log`.
- New `verify-design-apps.py` checks distinct app labels/identities, one launcher
  each and Studio capability isolation. Existing selected-only release audits
  passed for production and distribution release:
  `/tmp/agentvoice-separate-studio-{packaging,production-audit,release-audit}.json`.

Installed production SHA-256:
`2655dd7d52c9f39e8e850e7b4d645ccd91f6ba6d2a37645575d19347ab12161b`.
Installed Studio SHA-256:
`ee43ad0d87b532283af0fd5760eac94a8e552752f05deaca0a6424a950a59ae8`.
System rotation settings were restored to their observed values; Studio/browser
were left open with the exact migrated design. Phone access was released and a
notification stored in AgentNotify. No emulator or new real voice call was used.


## Paid icon UI and scanner rehearsals — September 10, 2026

Two one-time i cons icon purchases were verified from paid invoices. The local
license-holder opt-in removes the app's Credits action; default public builds
retain attribution and Studio keeps its complete icon credits. No invoice or
billing data is committed. Packaged/source CC BY notices remain intact.

The Relay Aperture scanner prototype is available in Studio's Connection setup
section. Only Live camera opens hardware; other scenes are deterministic. No
QR decoding, granting or server calls are implemented in this prototype. Closing
or backgrounding releases the camera; a native camera-service read observed no
Studio client after backgrounding. Browser generation/orientation fences apply.
The full design draft and explicit profile retained their exact pre-test hashes.
Portrait and landscape captures were reviewed; the final close action stays
outside scrolling copy and scanning status clears the lower brackets.

Validation: 738 root tests, 122 Studio JVM tests, 106 host tests passed; root/host
TypeScript checks passed. Initial native checks passed 21 tests, then final overlay
and paid-license checks passed 9 tests in 13.857s after the UI refinements.
Studio/production builds and lints passed. Production APK inventory and the two
app identity/permission audits passed; production was installed and its startup
Credits action was absent. No real call was started for this slice.

Production APK SHA256: `3aff0af785e6c64e12a7ec60fe4af068630ad9f9334465ded5e30a34c957261a`.
Final Studio APK SHA256: `f9b35b6e21ff12aa72e530ff1020b2b9af1073853d2682d63869a0299f37c406`.
Evidence: `/tmp/agentvoice-qr-flow/`; retained Studio draft SHA256
`ae14523168bcae482e8315ddabd75739c091835758b3592b3eba7492588ee0a5`;
explicit host profile SHA256
`fa90da13aee5d0282945f11639290083cde58dcb5075ec48854411f7c8ec1b42`.
System orientation restored to accelerometer_rotation1/user_rotation0.

Next authorized slice: implement `agentvoice network qr --name <device>` and
real scan/validate/encrypted-save/auto-connect, preserving one stored grant and
manual removal/replacement for now. Multi-server management remains later work.


## QR enrollment and complete Studio setup rehearsals — September 10, 2026

Production now scans `agentvoice network qr --name phone`, validates the strict
bounded profile, checks authenticated WSS without starting a call, and saves new
access with Keystore encryption before ordinary voice startup. Existing stored
access auto-connects once per foreground visit; invalid existing access is retained
for manual repair. The old Start/import/replace popup is removed. Studio remains
preview-only, with protocol 26 setup scenes and unchanged profile 20/draft 2.

Evidence root: `/tmp/agentvoice-qr-enrollment/`.

- Root suite: 763 tests / 11,179 assertions (`root-tests.log`). Two later QR
  output-boundary cases are included in the final focused 15-test / 148-assertion
  run. Root typecheck and scoped lint passed.
- Studio host: 106 tests / 3,854 assertions; host typecheck passed.
- Android JVM: 134 tests, no failures, including CLI fixture decoding and
  authenticated-upgrade/lifecycle policy cases. Studio/production builds and
  lints passed; final UI build is `build-actions.log` (5m 47s).
- Emulator native: 34 tests / 113.682s before the final permission-button layout
  fix (`instrumentation.log`). After the fix, all three overlay tests passed in
  portrait (11.655s) and explicitly fixed landscape (16.408s). This is a targeted
  post-fix rerun, not a claim of a new full 34-test run.
- Native landscape review found the permission action clipped by scrolling copy.
  The action now stays outside that copy; tests require readable text and at
  least 48dp height. `landscape-permission-fixed.png` is the final landscape shot.
- Final real CameraX-to-decoder emulator check used the CLI-generated,
  explicitly noncredential `fixture.invalid` QR. After calibrating the emulator's
  image-camera crop, all three finder corners were visible in
  `calibrated-studio-camera.png`. Production decoded it and reached the expected
  “Couldn’t reach the server” screen (`production-camera-check.xml`). Camera
  service then reported no active clients (`camera-after-decode.txt`). This proves
  the camera/decoder/error path; no real server grant or successful enrollment,
  persistence-to-live-call sequence, microphone or audio was exercised.
- APK audits passed: production excludes Studio entrypoints, profile JSON and
  unselected audition assets; Studio has no Internet, microphone or Bluetooth
  permissions. Selected assets and packaged notices are byte-exact.

Final production APK: 48,436,957 bytes, SHA-256
`14f95be3cdbf80d605e30dcf0f3eaa8522b361ec39bcab1e2452a57e4620e597`.
Final Studio APK: 96,934,415 bytes, SHA-256
`440d4b2fb8155a8589f9bfcd175c5338901b8cd0460a12fbcccca76716709ee9`.
Both were installed only on the disposable emulator. The S22 was reserved for
operator Studio use: no phone operations or installation occurred in this slice.
Its existing Studio host stayed running. No default/trial service was restarted.

The temporary Studio host was stopped; emulator `emulator-5580` was shut down
and owned AVD `agentvoice_qr_enrollment_20260910` deleted, with its process and
AVD files verified absent. No other emulator was removed. Protected saved design
`configurator/profiles/R5CT91TW4RP.json` remains SHA-256
`fa90da13aee5d0282945f11639290083cde58dcb5075ec48854411f7c8ec1b42`.
No Save/reset or phone draft read was used during this round.

Physical installation and real QR enrollment await a phone handoff. Next queued
work: enrich Persona state from real playback/capture, effective channel/PTT gates
and available server activity; Speaking must not mean merely speaker-unmuted.


## Four physical layouts and comparison capture — 2026-09-10

Protocol27/profile21/draft3 retain independent Portrait, Landscape, Reverse
portrait and Reverse landscape slots. Shared spacing and inherited appearance
stay shared. Legacy reverse slots clone their matching axis only in memory;
explicit Save exports all four. The adopted profile20 and provenance1 are unchanged.
Production and Studio both select layouts from display rotation, including 180°.

Evidence is under `/tmp/agentvoice-four-layouts/`. The native artifacts were built
and tested before the operator retired emulator use; no emulator was started
again afterward. `build.log`: Studio/production assembly, Studio test APK, JVM
suite and both lints passed (5m46s). JVM results: 136 tests, zero failures/errors.
`instrumentation.log`: 27 tests / 94.933s, including four-slot persistence,
legacy migration, shared spacing/appearance and existing pointer/draft ownership.

The native capture endpoint returned four PNGs and restored rotation lock0;
`capture-response.json` records success. The samples are 720×1560 portrait and
1560×720 landscape, with a synthetic cutout on a natural-portrait target.
The browser gallery and comparison download were exercised against a static
fixture serving these native PNGs, with no device connection. Capture rejects
held pointers, setup overlays, changed settings and reconnects; failure/cancellation
restores rotation and publishes no partial result. Screenshots sample successive
animation frames and do not prove every-frame geometry or physical OLED quality.

Package audits passed. Production SHA-256:
`b6fc17882bccfbfd65d21c56f0fb281958e79692a607f529cf5677efa1b23e07`
(48,436,985 bytes); Studio:
`eb3197e3ac2af4698e46bd06766ea1e3bd7d5dc1bb1e1a92c9fd812c9fab4c50`
(96,934,415 bytes). Production contains only selected audition resources and no
Studio entrypoints/profile JSON; packaged notices are exact.

The owned `agentvoice_four_layouts_20260910` AVD and emulator were stopped/deleted.
The physical phone, its running Studio host, saved design, grants and rotation
were untouched. Installation and physical cutout/reverse-rotation acceptance
remain pending an AgentNotify request and explicit operator handoff. Natural-
landscape tablets are not covered by this phone orientation mapping.

Host checks: configurator-local TypeScript passes, as does the root typecheck.
The combined configurator/shipping/reconnect/capture suite passed 111 tests;
the subsequent free-rotation restoration regression passed with all eight capture
tests (39 assertions). Scoped Biome and diff checks pass; shipping generation is
current. The protected S22 profile retains SHA-256
`fa90da13aee5d0282945f11639290083cde58dcb5075ec48854411f7c8ec1b42`.
The comparison export gained labels and narrower columns after the initial
browser download review; that final presentation refinement awaits browser/phone
acceptance, while original PNGs remain unchanged.


## Studio device picker — 2026-09-10

The host starts without a serial or selected phone. A bounded ADB read discovers
only authorized online targets with Studio foreground. Explicit linking reads
that app's private binding; no activity launch, binding replacement or design
write occurs. Another local host's matching forward is busy. Switching targets
requires release and fences old requests; exports stay in each serial's own path.
A custom `--save-to` requires pinned `--device`. This is local ADB-host coordination,
not a distributed lease between separately authorized computers.

Host suite: 119 tests / 3,929 assertions; host and root TypeScript pass. Five new
fake-ADB/loopback tests cover enumeration without launch, busy/racing forwards,
authenticated read-only attachment, exact forward cleanup, per-target paths and
HTTP origin/selection-epoch fences. No real ADB command was used for these checks.
Native binding tests cover first creation, byte-exact reuse and malformed-file
preservation; their instrumentation execution awaits explicit phone access.

To limit system-disk use, this worktree's existing generated `android/app/build`
directory was moved intact to `/Volumes/Scratch/agentvoice-green-river-build-20260910`
and locally symlinked back. This freed about 1.1 GB; the symlink is ignored and
not shipped. No shared cache or unrelated VM was removed. Incremental build uses
one worker, a 768 MB Gradle heap, in-process Kotlin and offline dependencies.
No phone operation, operator-host restart or default/trial service change occurred.

`/tmp/agentvoice-picker-build.log`: Studio APK, instrumentation APK and Studio lint
passed in 2m37s (18 executed tasks, 62 up-to-date). The installed-app/package audit
is `/tmp/agentvoice-picker-packages.json`. No claim of native execution or phone
UI acceptance is made for this binding change before the requested handoff.


## Compact comparison and measured inset guides — 2026-09-10

Studio `get` replies optionally include measured decor dimensions, visible
system-bar insets and display-cutout bounding rectangles. This metadata is
outside strict state/profile/draft data. The host bounds it and includes it only
when its dimensions match the native PNG. Missing or incompatible measurements
remain unavailable. The guide overlay does not change raw PNGs or design settings.

The comparison uses one scale for both portraits beside stacked landscapes.
Caption space is reserved outside the images, protecting cutout visibility.
Capture is near the page title; the gallery is below the device picker. Original
PNG links retain native resolution. Guide availability is explicit, and the
comparison download follows the same optional-guide/compact-layout settings.

Verification: all 123 host tests / 3,962 assertions pass (`/tmp/agentvoice-insets-host-tests.log`),
including layout ordering/sizing, metadata validation and capture dimension
matching. Host and root TypeScript, scoped Biome, generated-shipping drift and
diff checks pass. Studio APK/test APK/lint build passed in 2m57s with one worker
and the reduced 768MB Gradle heap (`/tmp/agentvoice-insets-build.log`).
Package audit passes (`/tmp/agentvoice-insets-packages.json`); Studio SHA-256 is
`cdfc9d945420746b9229fc26b5a1e074e3ada63a1229d9c13b32c022531ee622`.

`/tmp/agentvoice-four-layouts/compact-comparison-review.png` renders the actual
layout-helper placements using the earlier raw native captures, through
ImageMagick. It visually confirms the compact arrangement with external labels;
it is not a browser screenshot or a new phone capture. Those old captures lack
viewport metadata, so the review artifact invents no inset guides.
Physical cutout alignment, current browser gallery interaction, installation,
and new binding/viewport instrumentation remain pending explicit phone handoff.
The AgentNotify request is saved; optional macOS banners are off. No approval
has been inferred from delivery or lack of response. The phone, existing host,
latest draft and protected saved JSON are untouched. No VM or Gradle process
remains running from this task.


## S22 four-layout acceptance and draft balancing — 2026-09-10

The operator explicitly handed over R5CT91TW4RP. Installed the Studio APK with
SHA-256 `cdfc9d945420746b9229fc26b5a1e074e3ada63a1229d9c13b32c022531ee622`
and its test APK using `install -r`. The focused binding, viewport, four-layout
session and draft instrumentation passed: **16 tests / 0.933s**. This is the new
focused execution, not a rerun of every prior native test. No production install,
grant operation, voice call, microphone or emulator was used.

The replacement host starts without a serial, discovers the foreground Studio,
links, releases and relinks successfully. A stale selection receives HTTP409.
The existing binding remains byte-identical; linking does not recreate it.
Four sequential native captures succeed and return matching viewport dimensions:
1080×2340 portraits and 2340×1080 landscapes. The cutout bounds rotate from
(512,0)–(568,81) to the left, bottom and right edges as expected. Visible system
bar insets are zero in this immersive scene. These are Android-reported bounds,
not an optical measurement of the camera hole.

The live Chrome gallery was visually inspected: both portraits and both stacked
landscapes fit together at one scale, with captions outside the images and guides
on all four. The first screenshots included an unrelated YouTube picture-in-picture
window. It was dismissed through the system gesture and clean captures were
repeated; the covered shots are not evidence of unobscured controls. The final
balanced contact sheet uses native PNGs arranged by ImageMagick; it is not a
browser screenshot. No claim of a tested browser download is made here.

The user then requested draft-only balancing. Exactly seven existing layout values
changed: both landscape control widths 365→396dp and PTT shares 42.2→36.4%;
landscape horizontal offset −16→−44dp, reverse landscape −16→−17dp, and reverse
portrait vertical offset −30→−3dp. The widths/shares reproduce portrait's rotated
control proportions. Opposite-edge offsets compensate for the S22's 27dp cutout
safe-area displacement; cutout-side controls retain their safe padding, so the
reverse trace corridor is shorter. Persona size, animation, colors, shared
appearance/padding and independent hidden-PTT extents remain unchanged. Normal
portrait remains the reference. Captures sample live animation at different times;
small differences in instantaneous Halo shape are expected.

The revised draft is durably stored as draft3. The explicit phone checkpoint and
protected host JSON remain byte-identical (SHA-256
`fa90da13aee5d0282945f11639290083cde58dcb5075ec48854411f7c8ec1b42`);
no Save, promotion or production-default change occurred. Capture restored free
rotation; acceptance also restored the original stored user-rotation value1,
auto-rotation1 and font-scale1.0. Studio remains foreground with the linked host
running. Phone access was released with an AgentNotify completion notification.

Private local evidence: `/tmp/agentvoice-phone-four-layouts-acceptance/`, including
`instrumentation.log`, `clean-before/`, `balanced-final/`, `final-state.json`, and
the original/final draft backups. The directory also contains a private Studio
binding backup and must not be published wholesale. No active Gradle or VM
resource remains from this work.


## Cutout-aware padding and adopted four-layout spacing — 2026-09-10

The operator approved another phone pass and explicitly requested adoption and
installation of production plus Studio. The shared scene now credits a display
cutout toward outer button padding after `safeDrawingPadding` reserves it. Extra
space on that edge is `max(0, padding - cutoutInset)`. Button gaps retain the full
padding; no Persona size, pose, renderer, manual placement rule or saved schema
is changed by this geometry fix. Both landscape handedness choices and portrait
bottom cutouts use the same rule.

The adopted profile is the complete profile21 exported from live Studio draft3, including all four
physical layouts, hidden-PTT extents, override flags, launcher, icons, sounds,
colors and motion. Shared padding changes 17→21 dp. With PTT visible the tuned
control extents are 415/409/421/427 dp for portrait/landscape/reverse portrait/reverse
landscape; all retain 36.4% PTT share. Portrait offsets are −43/−28 dp and landscape
horizontal offsets are −44/−42 dp. The normal landscape Persona stays where the
operator liked it. Its reverse counterpart uses the free left margin; portrait
moves toward the camera and reverse portrait uses the free top margin.

At the S22's measured viewport, a nominal circular body radius of
`diameter × 1.9 × containedSize × 0.25` gives approximately 42–43 dp between body and
deck in all four orientations, versus about 57 dp in the prior portrait reference.
This is a calibration for the layout comparison, not a runtime renderer bound or
an assertion that every animated edge has an identical gap. The existing trace
reach/fade and native animation remain unchanged. Clean native four-up captures
were inspected at `/tmp/agentvoice-cutout-spacing/candidate/`; no camera mask was
painted over Persona. Reverse-landscape PTT reaches the cutout-safe boundary
without additional padding.

The code build before adoption passed 138 JVM tests (including two new cutout
geometry cases) and Studio APK/test APK/lint in 3m24s. Ten shipping promotion tests
pass with 62 assertions. The original explicit phone checkpoint, host profile and
private binding are preserved; adoption uses a complete private draft export and
commits its canonical shipping snapshot/provenance. It does not press Save over
the operator's earlier checkpoint. Final build/install results follow below.

Final adoption build passed in **5m05s**: production and Studio APKs, both lint
checks, and **138 JVM tests / zero failures**. Generated shipping drift and diff
checks pass. Release package audit confirms the selected Rocker13 quartet and
Relay Aperture launcher, byte-exact notices, no Studio entrypoints and no profile
JSON. Installed both APKs with `install -r` and verified device APK hashes:

- Production: `dc8d0302e57c7e32ccea5ecc5aef6e30755cabfd5bc64a5cdd23e8a9cf9631e5` (48,436,985 bytes).
- Studio: `18eb90cbd15e78e092fafa941db8e840cf2fae0491ee8e8703ba08d64606ab70`.

The final installed Studio completed another four-layout capture; its contact
sheet is `/tmp/agentvoice-cutout-spacing/installed-final/sheet.png`. Draft, explicit
checkpoint and binding remain byte-exact across both installations. This handoff's
original rotation settings (user_rotation0, accelerometer_rotation0) and font
scale1.0 were restored exactly. Production was installed without launching a new
voice call; physical visual evidence is from the shared renderer in Studio, not
a claim of live production audio validation. Production grants/data were not
cleared or rewritten.

The previous browser host had exited during the session transition, leaving its
owned ADB forward. Removed that exact orphan forward and restarted Studio on an
automatically allocated loopback port, preserving the unrelated application now
using4317. The linked host remains running for the operator. Phone access was
released with AgentNotify; no emulator or Gradle task remains running.


## Production WebRTC JNI initialization repair — 2026-09-10

The operator reported a crash while the real app connected and handed over the
phone. The crash log identifies `ClassNotFoundException: org.jni_zero.JniZero`
during WebRTC `JNI_OnLoad`, followed by `GetStaticMethodID` with a null class and
SIGABRT. Existing release rules kept `org.webrtc`, but the pinned WebRTC
150.7871.01 AAR also contains JNI Zero callbacks outside that package and carries
no consumer ProGuard rules. R8 removed them. This is a native packaging failure,
not evidence of a revoked or malformed grant. No lease was deleted or replaced.

The release rules now retain JNI Zero classes with `@CalledByNative` methods and
the annotated methods/descriptors. This preserves `JniZero.init`, its diagnostic
callback and `CommonApis` without retaining the unused class-loader setter that
references an absent generated `JniZeroJni` helper. A broad all-member keep
correctly failed R8's missing-class check; no warning suppression was added.

The shipping APK audit now reads DEX class definitions and requires the original
JNI Zero and PeerConnectionFactory class descriptors. The previously installed
APK fails this regression check with the exact missing `JniZero` descriptor.
This avoids mistaking incidental DEX strings for a retained class. Studio's
synthetic capture checks did not initialize production WebRTC and could not
establish this path; production native-load acceptance is required below.

Rebuilt production APK and production lint passed in **2m33s**. The repaired APK
passes the full packaging audit, including actual retained DEX definitions.
R8 mapping also confirms original `JniZero.init`, diagnostic callback, and
`CommonApis` callback names. Installed with `install -r`; device hash matches
`b370d5a17a79cb88a891a3cb4d34bebf02f5293f08151c44dff5751566116683`.
APK size remains48,436,985 bytes at ZIP alignment granularity.

The real production app loaded `libjingle_peerconnection_so.so` successfully,
created WebRTC media/offer state, and retained the same live PID13965 instead of
SIGABRT. The operator reported accidental interaction during the initial attempt;
a clean subsequent attempt was made after their renewed handoff. Voice startup
then failed visibly without an app crash. The default server reports the native
Codex account usage limit, with reset September14,2026 at9:26PM. This prevents
completed live audio acceptance; replacing enrollment cannot solve that quota.
No credential/account/profile changes or server restarts were attempted.

Ended the test attempt and reopened Studio. Its draft/checkpoint/binding hashes
and phone font/rotation settings match the beginning of this handoff. Grant
data was not deleted, read out or rewritten. Phone released with AgentNotify.
The retained grant admitted the attempted connection, so no QR enrollment reset
was needed. Local private evidence is `/tmp/agentvoice-jni-crash/`; the exact
regression failure is `/tmp/agentvoice-jni-before-audit.log` and build log is
`/tmp/agentvoice-jni-production-build.log`.

## Landscape handedness and balanced starting points — 2026-09-10

Studio exposes Controls side for each landscape rotation. The selector mirrors
manual horizontal position without replacing tuning. An explicit Use balanced
production layout action seeds Persona size/position, both control widths and
PTT share from promoted geometry. The opposite rotation supplies the mirrored
geometry when changing hands; shared appearance/padding and other layouts remain
unchanged. This retains four physical layout records, not separate per-hand banks.

Native S22 comparisons at the current operator draft showed compressed traces
with a naive mirror of reverse landscape. Reviewed balanced left-handed samples
use landscape 427dp/+42dp and reverse landscape 409dp/+44dp (deck width/Persona
horizontal offset), both at Contained81%. These mirror the opposite production
rotation. HUMAN remains above AGENT; PTT stays outside. The sampled routes stay
outside the Persona center with useful separation from the controls. No renderer,
asset, APK or production-default changes were needed.

Evidence: `/tmp/agentvoice-handedness-review/balanced-comparison.png`, raw
`baseline-*.png` / `balanced-left-*.png` and their capture JSON include all four
physical orientations. Captures use native animation at different instants;
these stills do not establish every-frame symmetry or every-device cutout fit.
The original draft/checkpoint/binding were restored byte-for-byte, and original
accelerometer_rotation=1/user_rotation=0/free rotation were verified. No Save,
grant change, service restart or production call was performed.

Validation:125 configurator tests,784 root tests, configurator TypeScript,
scoped Biome and diff checks passed. The refreshed host serves the new controls
and compiled bundle and reconnects to Studio in portrait. Browser automation had
no local browser / could not reach the loopback host; no browser-click validation
is claimed. Native geometry was exercised through the same fenced preview API.

## Bluetooth switch-sound diagnosis — 2026-09-10

The installed-build artifacts contain byte-identical Rocker13 toggle-on,
toggle-off, PTT-down and PTT-up WAVs in Studio and production. The captured Studio
draft and adopted production both select Rocker13/60%; their shared SoundPool
uses playback rate1 and USAGE_MEDIA/CONTENT_TYPE_SONIFICATION.

An authorized physical S22/headset check observed MODE_NORMAL and inactive SCO
before the call. Production then owned MODE_IN_COMMUNICATION with active SCO,
Bluetooth SCO capture and playback. Crucially, AudioPolicy STRATEGY_MEDIA changed
from AUDIO_DEVICE_OUT_BLUETOOTH_A2DP to AUDIO_DEVICE_OUT_BLUETOOTH_SCO_HEADSET
during the call, covering the UI sound stream too. No connected LE audio route
was exposed. After Back ended the attempt, mode returned to NORMAL, SCO became
inactive and STRATEGY_MEDIA returned to A2DP. This establishes a different audio
path, not a measured codec bandwidth or subjective listening comparison.

Private raw dumps are under `/tmp/agentvoice-bluetooth-sound`; they contain device
identifiers and unrelated audio state and must not be committed. The test used a
brief Studio mute pair and production mute/PTT interactions. Production passed
the connecting overlay and no failure panel was observed; no spoken exchange
was performed, so this is not end-to-end voice quality verification. Older usage
limit messages in retained server stderr are not attributed to this attempt.

Draft/checkpoint/binding were byte-identical afterward; rotation/font settings
were unchanged, the previous VNC activity was restored, and phone release was
notified. No grant, system-volume, service or production-code changes were made.
The remaining product choice is a realistic Studio call-route audition and/or
sound tuning that works through the call channel; no audio-routing workaround or
replacement sound was silently adopted.

### Communication-category comparison

The operator reports that ChatGPT's internal search cue remains clear through the
same headset. This is a useful counterexample to the earlier hardware-only
interpretation: the measured route change does not prove that all perceived
degradation is unavoidable. The captured Android dumps show different call/media
volume paths and no ducked players; they do not reveal ChatGPT's implementation.

The comparison build assigns production SoundPool output
USAGE_VOICE_COMMUNICATION/CONTENT_TYPE_SONIFICATION; Studio retains USAGE_MEDIA.
Only the output category changes: WAV bytes, rate1, configured gain, cue triggers,
VoicePeer, microphone selection, focus and call processing stay unchanged.
Production cues now follow call-volume policy. This is a routing-policy
comparison, not a claim of restored Bluetooth bandwidth or verified better sound.
Installed on the authorized S22 with an exact on-device APK hash match. Android's
AudioPlaybackConfiguration for the new production PID8805 reports SoundPool
USAGE_VOICE_COMMUNICATION and CONTENT_TYPE_SONIFICATION. The connecting overlay
cleared, a brief speaker toggle pair was exercised, and Back ended the test call.
SCO remained the headset route during the call; afterward MODE_NORMAL and inactive
SCO were verified. Studio draft/checkpoint/binding were byte-identical, rotation/font
unchanged and the previous VNC activity restored. Phone release was notified.
Private runtime evidence is under `/tmp/agentvoice-call-cue-comparison/phone`.
The operator subsequently confirmed: "The sound works great now btw."
This closes the subjective Bluetooth cue comparison for this headset.
All 138 Studio JVM tests, production/Studio assembly and both lint checks passed
with a full Kotlin compilation (3m 28s). The initial incremental compilation
reported unresolved existing top-level functions; disabling incremental compilation
resolved it without unrelated source changes.

Production comparison APK SHA256:
`212ef542238940723b80230cf03e483fd77b7767fec9843835c5cb3e6fcd3b4f`.
The selected-resource/JNI audit passes with the exact quartet and no Studio
entrypoints/profile payload. The temporary original-APK rollback copy was removed
after operator acceptance to reclaim disk space.

## Stable pending PTT labels — 2026-09-10

Pending holds retain Push/to talk in both button orientations. Opening, Wait and
waiting-for-microphone wording is removed; accessibility describes the pending
hold as Pressed. Live now still requires the effective microphone gate to be open.
Touch depression, gesture ownership, gate acknowledgements and sound triggers are
unchanged. The existing native control regression now covers pending hold and
unmute states in both orientations, including no premature Live now label.

All 138 Studio JVM tests, production/Studio and instrumentation assembly, and
production/Studio lint passed with full Kotlin compilation. The production
selected-resource/JNI audit passed for APK SHA256
`d2e16418453779f02e4c0a109a1dc0762306bc9ddf775dde41e25d441f80fb77`.
On the authorized S22, all five PreviewControlsTest instrumentation tests passed
in 8.352s, covering pending labels in both orientations, touch feedback,
release/cancel/exit/second-pointer handling, disposal and accessibility start/stop.
Production and Studio were installed with exact on-device APK hash matches.
Studio APK SHA256:
`cbcc8af19bfcc70389c95f1cab179c06b771fd530a87d44a3814acf3bbe2e8ae`.
Studio was reopened in its prior foreground; draft, checkpoint and binding stayed
byte-identical before and after reopening. Rotation and font settings were
unchanged. No production call was started. Phone access was released and notified.
Private device evidence: `/tmp/agentvoice-stable-ptt/phone/`.

## Disconnected Persona motion — 2026-09-10

Original and Contained now run the authored idle loop while disconnected and
foregrounded. Disconnected color and smaller scale remain; no Rive bytes, saved
tuning, controls, sound or audio state changed. Backgrounding still pauses the
native animation. Persona observers read the global animator-duration setting
directly: the previous ValueAnimator cached flag could lag its change notification.
The full Studio check reproduced continued motion after disabling system
animations before this correction; the final build stops and resumes correctly.

Validation:
- 138 Studio JVM tests, production/Studio/instrumentation assembly, both lint
  checks and the selected-resource/JNI APK audit pass. Final build: 3m 12s.
- Nine native Persona tests pass in 23.106s, including visible disconnected
  animation, lifecycle pause/resume, live system-animation changes with exact
  restoration, and retained view/machine identity for both variants. Existing
  transition, recolor and paused-texture regressions remain green.
- Full native Studio screenshots show changing disconnected ring geometry.
  The same Persona crop has zero RGB difference across the two disabled-animation
  captures. This is sampled still-frame evidence, not every-frame review.
- Final Production and Studio APK hashes match the installed S22 packages:
  `0a05cd41e79986ec1df318ef04bd07d65106c1384b30c9ebcd8296e73066677e`
  and `67646c920b09924dcb1cf9c940a59d623b27715247eee4dfecb0d7557f1f4716`.
- Draft/checkpoint/binding stayed byte-identical; simulation and Studio foreground
  were restored, as were rotation, font and animator-duration settings. No real
  call was started. Phone access was released with an operator notification.

An initial instrumentation run was interrupted by ADB transport loss; completed
retries and final evidence are under `/tmp/agentvoice-disconnected-presence/`.
The Thinking follow-up is queued separately: server thread/turn events exist,
but an authoritative coding-work aggregate is not yet projected to Android.

## Coding-work Thinking — 2026-09-10

The implementation projects content-free coding activity from the root
and verified direct children through frontend API 3. Android selects Thinking
for known work when audible agent playback, detected human input and active PTT
do not take precedence. Blocked, idle and unknown activity do not imply Thinking.
Studio protocol 28 adds a transient Thinking audition using Idle size/color;
saved profile 21 and the operator's checkpoint remain unchanged. Rive assets
are unchanged. This round does not change disconnected Persona size.

Completed host checks:
- Combined root suite: 791 tests, zero failures, 11,410 assertions in 64.87s.
- Studio suite: 126 tests, zero failures; root and Studio typechecks and root
  lint pass.
- Android: 140 JVM tests, zero failures; Production, Studio and instrumentation
  assembly plus both application lint checks pass (final build 1m 42s).
- Production selected-resource/JNI audit passes for APK SHA256
  `d116f86a2d724c939a7cecca30c9496e94c1889190d1966f4ed8c9b6c5ec2598`.

On the authorized S22, 21 native tests pass in 40.612s: Thinking on both Persona
variants, speech/PTT transitions, blocked/idle/unknown/disconnect clearing, retained
native instance, controller protocol and existing animation/lifecycle regressions.
Full Studio samples show the authored sweeping arcs with a clear center on both
variants. Original retains its existing conservative trace standoff; these sampled
stills do not establish every-frame geometry or universal trace attachment.
Draft, checkpoint and binding remain byte-identical after audition/restoration.

Production and Studio were installed with exact on-device APK hash matches.
Studio SHA256: `2197a5eb09c82b2edf9e4979e955b22076705b08d74a32e76a7e3fe1e208d405`.
After an idle admission check and coordinated restart, the default server answered
a frontend3 observation with idle/busy=false. No live voice call was started;
real coding activity during a user call remains ordinary-use validation.
Studio foreground/simulation and rotation, font and animator settings were restored;
phone access was released with an operator notification. Network transport,
heartbeat and grants remain v2; frontend API 3 requires a coordinated app/server
upgrade, without replacing the device grant. Private check logs are under
`/tmp/agentvoice-thinking/`.


## Normal disconnected Idle size — 2026-09-10

Original and Contained no longer reduce artboard scale from 1.9 to 1.5 on
connection loss. Original retains its selected Idle multiplier; Contained retains
its shared multiplier. Color, native idle motion, listening-exit settlement and
lifecycle/reduced-motion rules remain. Button geometry and every operator-selected
design value are unchanged. The adopted profile changes only disconnected scale
metadata; fresh exports record 1.9, while readers preserve legacy 1.5 receipts.
The private device checkpoint is byte-identical to its pre-change version.

Studio's 126 tests, typecheck and scoped lint pass; 140 Android JVM tests pass.
Production/Studio/instrumentation assembly and both Android lint checks pass
(6m 34s). The selected-resource/JNI audit passes. Six native tests pass in 16.054s,
including visible ring size across connection changes for both variants, animation
pause/resume and export migration. The first pixel-bound assertion was too strict
for differing authored poses; the final test uses centered placement and an 8%
size tolerance, below the old 21% disconnected reduction. Full Studio samples
show matching overall Idle/disconnected size; they are not identical poses.

Installed APK hashes match the built files:
- Production: `7513b95619008b912b50ca99231da8a7217d1fb60aa3f32cf961a274e568d202`.
- Studio: `827f64a55027dbffc427cf65e2c535bd5f68ecfa344c730abfec6f5173c02b5e`.

Twelve portrait speaking samples yielded a largest contiguous bright top stroke
of 16px (5.33dp at density 3), a starting estimate for the queued cutout adjustment,
not a universal animation maximum. Four speaking layouts were captured with native
viewport metadata; rotation restoration succeeded. The follow-up preview restore
initially used a stale orientation epoch and was rejected; a fresh state restored
the original connected-Idle simulation. Autosave had updated only the draft's
renderer-scale metadata; the exact original draft bytes were restored afterward.
Draft/checkpoint/binding, rotation, font and animator settings were verified equal
to the handoff backup. Studio remained foreground; phone release was notified.
No live call or server operation occurred in this round. Private evidence:
`/tmp/agentvoice-disconnected-size/`.

## Persona outer clearance — 2026-09-10

Adopted a 6dp inward movement in all four physical layouts, rounding the prior
5.33dp sampled speaking-stroke estimate upward. Persona size and animation are
unchanged. Each control block becomes 6dp shorter along the same axis, for both
PTT-present and hidden modes, preserving the Persona-to-deck trace corridor and
the buttons' outer edge. Shared padding, button gaps and cutout subtraction are
unchanged. Landscape handedness continues to mirror placement and use the
opposite physical production slot for its balanced baseline.

Studio's 126 tests pass; 141 Android JVM tests pass, including corridor/outer-edge
invariants across portrait/landscape, cutout sides, handedness and PTT visibility.
Production and Studio builds and both lint checks pass (5m 10s); the final JVM
regression run passes in 29s. The selected-resource/JNI APK audit passes.
No renderer or runtime code changes required a new native instrumentation run.

On the authorized S22, captured speaking before/after in all four orientations,
all four hidden-PTT layouts, and both mirrored landscape sides with/without PTT.
Visual review found the intended additional outer clearance, retained connecting
routes and unchanged outer button alignment. These are sequential native poses;
they do not establish a universal maximum animation envelope or every-frame
camera avoidance. Thinking's lateral-arm shaping remains a separate queued task.

Installed APKs were hash-verified on device:
- Production: `7ec1e8b691c03b87e0198b20dca94ae8da322b5c5c3066357d7bd788977fe6a9`.
- Studio: `983daaa19a1f331c10ad90a0176110ff542c874994ba1494e231a35180eb3dee`.

The latest working draft matched the previous adopted profile at handoff. Only
the intended twelve geometry values changed; the final draft matches the newly
adopted profile. The explicit checkpoint and bridge binding remain byte-identical.
Original portrait/Thinking simulation, PTT visibility, font and animator scale
were restored. Final verification caught auto-rotate disabled after the review;
it was explicitly restored and rechecked with the original user rotation before
phone release. Studio remained foreground and linked at port 4317. Phone release
was notified. No live voice call, grant mutation or server operation occurred.
Private screenshots, viewport records and delivery receipt are under
`/tmp/agentvoice-wake-clearance/phone/`.
