# Android development build verification

2026-09-08. Samsung Galaxy S22 (SM-S901U), Android 16 / API 36,
1080 × 2340 at density 480. Native development package `com.arthack.agentvoice.dev`.
The desktop used its existing waiting AgentVoice service and Tailscale TLS route,
with an owned stock Codex 0.153.4 child. No service configuration was changed.

Final debug APK SHA-256:
`89a2310e1ae49cd9298424c6c954c9d4032cf8f19baeb886e416bd36c846c83c`.

## Automated checks

- 629 repository tests; root TypeScript and Biome checks passed.
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
