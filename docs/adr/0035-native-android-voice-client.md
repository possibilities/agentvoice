# 0035: A native Android client is one voice instrument

Implemented 2026-09-08 for the operator's native Android UI request. Extends
ADRs 0033/0034. The existing terminal TUI keeps its static monochrome contract.

The Android app in `android/` implements the authenticated client API v2 directly.
The app owns microphone permission, audio routing, native WebRTC, mute gates and
WSS. The existing desktop server owns Codex, configuration, conversation identity,
renewal/restart, transcripts and work. It needs no Termux or browser bridge.

The first interface is one screen: YOU and AGENT mute controls, stable PTT,
a header connection indicator and end call. The original amplitude filament was replaced,
at the operator's request, by Vercel AI Elements Persona Halo, rendered through
native Rive. Saturation identifies voice direction. Setup consists of explicit private
grant import. There is no agent inventory, transcript, settings dashboard or
remote approval surface.

The operator prioritized the result over the toolkit and suggested Vercel Labs
Native SDK if suitable. Inspection of installed `@native-sdk/cli` 0.7.2 found a
working Android packaging path, but the toolkit-owned
`src/platform/android/NativeSdkActivity.java` presents the CPU reference renderer
through a SurfaceView, delays an undecided touch into tap/drag behavior, and
provides MediaPlayer playback rather than duplex WebRTC. Its comments at lines
9–25 and 47–59 describe those boundaries. Extending that host for immediate PTT,
Keystore, native microphone/WebRTC and Android accessibility would put custom
toolkit integration on the critical path. This version therefore uses Kotlin,
Compose and native WebRTC. Native SDK remains a viable future renderer;
it is not described as incapable of Android.

The visual research used the wiki's Signal Room principles (meaningful color,
restraint, quiet until active), Chuchu Apps' touch-first foreground presentation,
and their linked house design collection: `01-core-stance`, `02-design-taste-skill`
and `09-arthack-north-star`. This native surface follows the operator's explicit
neon brief with its own tokens; it does not change the canonical TUI palettes or
combine the Signal Room and fxnk shells.

The Persona adaptation bundles the unchanged `halo-2.0.riv` asset selected by
upstream AI Elements, plus `app.rive:rive-android:11.12.0`. The asset's legacy
boolean state-machine inputs require Rive's native `RiveAnimationView`; the new
Compose API does not expose them. This isolated adapter uses the GPU renderer
without the general Compose worker helper's audio-engine acquisition. No React,
WebView or runtime CDN load is involved. See
[asset provenance](../../android/third-party/persona-halo.md).

Speaking follows the enabled playback envelope with 180 ms release hysteresis;
listening follows the open capture gate. Idle animation is authored presence,
not evidence of thinking or work. Disconnected, reduced-motion and background
states settle to a still frame on the render thread. The operator asked for a
larger ring after viewing it on the S22. The adapter scales past the artboard's
internal padding using the full screen width. A small filled/outlined header
indicator replaces the dedicated status row; it retains an accessible phase and
transient connecting text. The operator explicitly requested full bleed at the
top and sides, including temporary overlap beneath the header and buttons. The
screen draws Persona first and its controls afterwards, giving them precedence
for both pixels and hit testing. No panel clipping or fading is applied. The
disconnected still uses a smaller scale to leave startup text clear. Persona
receives state and color only, never audio, credentials or transcripts.

Window and system splash backgrounds use the dark canvas. The renderer settles
its first pose before drawing, so the initial authored size ramp is not shown.
The debug test host also uses this theme and centers its isolated Halo fixture;
the test library's default light theme previously exposed a white corner preview.

The operator selected 78% Speaking/Idle, 58% Listening and a +35 dp offset. This is
the compiled baseline; vertical position stays fixed across all states. Listening's
wider authored ripples need separate size calibration, so the debug-only Halo tuner stores
independent Speaking, Listening and Idle sizes. Ordinary size changes ease over
300 ms without overshoot; reduced motion and inactive states snap instead.
Listening to Idle starts enlargement at the pinned asset's actual `listening_out`
state and uses its native one-second duration. Listening can finish its current
loop before starting its exit, so a timer from the gate change is insufficient.
Listening to Speaking waits for `listening_off` before its 300 ms enlargement;
overlapping that growth with the incoming speech animation magnifies the outgoing
rings. Speaking animation and color remain immediate; only growth waits.
Idle to Speaking has no outgoing listening rings and needs no hold. The transform
affects the whole Halo; it does not isolate the bright line.
Revision-fenced callbacks prevent a rapid reversal from releasing an old hold.
On entry, any reduction to Listening's scale completes before enabling its
native animation. Color follows the selected audio state immediately. Cancelling
that reduction cancels the pending native entry; controls and audio gates are
independent of this visual sequencing.
The original tuner's hideable overlay left layout geometry intact. Its states were
synthetic; there is no media or controller. Save writes all sizes in a private
version 2 placement JSON for explicit adoption into the compiled defaults. A
version 1 profile seeds every state from its original size and is not rewritten
on load. The real client does not load that file or gain a settings screen.
The on-phone tuning overlay is superseded by
[ADR 0041's host browser configurator](0041-host-persona-configurator.md), which
preserves this profile format and the native preview's layout and animations.

Security and lifecycle stay narrow: verified WSS, exact subprotocol and private
device grant; AES-GCM Keystore storage, backup exclusion and protected capture;
explicit Start; local close before network acknowledgement; no reconnect or
control replay. Per-call generations and per-press acknowledgement revisions
fence late completions. At most one live and one pending peer exist. A session
stop during runtime replacement does not close the retained owner connection.
Backgrounding and activity recreation end the call. No foreground service is
implied. The server's existing mute defaults remain authoritative.

Automated verification uses bounded protocol/TLS tests, shared server/Android
fixtures, fake media through the actual Android controller, and Compose touch
tests. The debug preview activity has no controller, grant or audio dependencies
and is absent from release builds. On the physical Galaxy S22, native WebRTC
connected over the existing authenticated Tailscale route; PTT, background
teardown and active-grant revocation were verified against desktop ownership.
Human audible-conversation acceptance, remaining hardware/failure cases and
release signing remain outstanding in the
[verification record](../../android/VERIFICATION.md).
