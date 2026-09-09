# AgentVoice for Android

A native, foreground voice client for the existing AgentVoice server. One screen:
YOU and AGENT mute controls, a fixed hold-to-talk surface, and Vercel AI Elements'
Persona Halo. Kotlin/Compose and native Rive draw the interface; native WebRTC owns audio. Android
12 / API 31 or newer, ARM64 phones and x86-64 emulators.

This development build is installed on a Samsung Galaxy S22 running Android 16.
Native WSS/WebRTC connected to the desktop over Tailscale. Real-device checks
verified permission denial, PTT hold/release, background teardown, grant
revocation and rejection of the revoked grant. A human spoken request with an
audible answer and the remaining route/failure cases still require acceptance.
See [verification evidence](VERIFICATION.md). A preview's Connected label is synthetic.

![AgentVoice Android design preview: agent audio and push to talk](design/voice-preview.png)

## Build and verify

Use JDK 17 and Android SDK platform/build-tools 36. The Gradle 8.13 wrapper is
checksum-pinned. Set `ANDROID_HOME` to your installed SDK or configure an untracked
`local.properties` file.

```sh
cd android
./gradlew :app:assembleDebug :app:assembleRelease
./gradlew :app:testDebugUnitTest :app:lintDebug
./gradlew :app:assembleDebugAndroidTest
```

The installable development APK is
`app/build/outputs/apk/debug/app-debug.apk`, package
`com.arthack.agentvoice.dev`. It is separate from the unsigned release package
`com.arthack.agentvoice`. Release signing/distribution is not configured.
The desktop/Termux CLI's `bun run android:build` remains a different artifact.

Root `bun run test`, `bun run typecheck`, and `bun run lint` include the shared
contract fixtures. Both Kotlin and the server Zod schemas validate
`contract/server-frames.json`.

On an explicitly selected disposable emulator, with microphone/audio disabled:

```sh
adb -s <emulator-id> install -r app/build/outputs/apk/debug/app-debug.apk
adb -s <emulator-id> install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s <emulator-id> shell am instrument -w -r \
  com.arthack.agentvoice.dev.test/androidx.test.runner.AndroidJUnitRunner
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

YOU toggles the persistent microphone mute; AGENT toggles playback mute. While
YOU is muted and media is connected, hold the bottom surface to talk. Release,
pointer cancellation, a second pointer or focus loss closes the local hold
immediately. A delayed acknowledgement cannot reopen it. TalkBack exposes explicit
Start talking / Stop talking actions with the same gates.

The screen stays awake during a call. System bars can be revealed by swiping.
End call, Back, backgrounding, lock, transport loss, failed heartbeat, audio focus
loss or removal of the selected audio device tears down locally. Reopening the
app requires an explicit Start. Activity recreation, including a configuration
change that recreates it, also ends the call in this version. This can interrupt
server-owned agent work; it is the existing frontend ownership contract.
Portrait is the primary layout; shallow landscape screens scroll to keep every
control reachable. Connection is a small filled green indicator beside the name;
disconnected is an outlined indicator. TalkBack announces the actual phase, and
connecting phases remain readable in the header. Errors appear only when needed.

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
[Persona asset and Rive provenance](third-party/persona-halo.md) records pinned
versions and licenses; their notices ship in the APK's `assets/notices`.

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
on-phone tuner panel and compares four directions: Current shows the existing
screen; Signal combines a quiet header, glyph mutes and a beam hold surface;
Field radio combines a slide-away header, rockers and a trigger; Ghost terminal
combines hidden chrome with oversized keycaps. Mix the three header, mute and
hold variants independently. Changing a preset or variant keeps the Halo tuning
values. In the studio layouts, header disclosure moves only Halo's center;
the mute and hold targets stay anchored and the Halo diameter stays unchanged.

Choose Speaking, Listening or Idle and adjust that state's
size (35–120%); the other sizes stay intact. The vertical position slider applies
to every state, from −200 to +200 dp in 1 dp steps, initially +35 dp. Negative
moves up; positive moves down. Reset tuning restores the current compiled sizes
and position while keeping the selected design and state.
The phone's synthetic channel and
hold-to-talk buttons still work, and changes appear in the browser.
Leave the host app and browser open through backgrounding, activity recreation
or temporary USB loss. The configurator waits for the same preview to return,
reconnects automatically and retains unsaved tuning and design. It never replays Save or
brings the app to the foreground. A force-stop or dismissed task requires a
fresh host launch.

```sh
# From the repository root, with the current debug APK installed:
bun run android:configure --device <adb-serial>
```

Explicit Save retains the design, all three sizes and shared position in a
version 3 app-private `files/persona-tuning.json` and a matching JSON copy on the
host. Preview protocol 3 carries those choices between the host and debug app.
Existing version 1 and 2 phone profiles load without rewriting and select the
Current design; they become version 3 only on Save. The real client and release
APK keep their existing UI and compiled defaults until the operator chooses a
design for explicit adoption in code. Debug builds include a **Halo preview** launcher
icon; the former `PersonaTunerActivity` is replaced by `PersonaPreviewActivity`.
The preview and its narrowly scoped ADB bridge are absent from release builds.
They never load a grant, controller or audio, or connect to the voice server.

## Remaining on-device acceptance

Use the handoff's full matrix for permission revocation during a call, audio focus
and Bluetooth changes, lock, Wi-Fi/cellular/Tailscale loss, silent half-open WSS,
grant revocation during negotiation, server redial/runtime restart and stale SDP
callbacks. The controller's delayed-response and stale-session cases are covered
with fake media; those do not establish native audio behavior. Background teardown
and active-call revocation were checked against desktop process identity and
saved voice JSONL. Finish with a human spoken command and an audible answer.
