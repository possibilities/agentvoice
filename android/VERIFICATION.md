# Android development build verification

Latest synthetic UI checks: 2026-09-09 on the physical S22 and disposable API 35 ARM64 emulator
`agentvoice_round12_checks`, 480 × 1040 at density 213. Native development package
`com.arthack.agentvoice.dev`. The emulator round ran while the S22 was unplugged. The subsequent physical-phone
installation and restoration are recorded at the end of this document.
Earlier physical-phone and live-call evidence remains below. No current check
started a voice call, microphone, speaker or inference.

Latest debug APK SHA-256:
`8f94d5ffab5327db77b71dfbc9b830dc0f25969b68c24a71fb399c95f2f0d9e0`.
This build is installed on the emulator; the phone retains the previous round.
Latest checks are under [Adjustable muted presence](#adjustable-muted-presence);
earlier sections retain their original verification history.

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
