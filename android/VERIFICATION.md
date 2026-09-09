# Android development build verification

Latest synthetic UI checks: 2026-09-09. Samsung Galaxy S22 (SM-S901U), Android 16 / API 36,
1080 × 2340 at density 480. Native development package `com.arthack.agentvoice.dev`.
Earlier live-call checks used the desktop's existing waiting AgentVoice service
and Tailscale TLS route, with an owned stock Codex 0.153.4 child. No service
configuration was changed. The latest configurator checks opened no voice call.

Final debug APK SHA-256:
`a6fbb472e93b3ba447bd08c8b32fb891317701fe0fff0e4f05eac736b82e25a3`.

## Automated checks

- 646 repository tests, including seventeen configurator tests; root and configurator
  TypeScript and Biome checks passed.
- 22 Android JVM tests passed: strict shared protocol fixtures, request/liveness
  bounds, server-authoritative mute gates, truthful Persona state, TLS trust,
  headers and redirect rejection.
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
