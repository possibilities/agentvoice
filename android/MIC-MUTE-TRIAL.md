# Microphone continuity acceptance and test procedure

The accepted change updates one Android media predicate: the active local audio track stays enabled while microphone mute supplies zero samples through the Java audio device module. Inactive peers and closed sessions remain disabled. Speaker controls are unchanged. Local microphone capture can remain active while muted, including Android's microphone indicator.

Accepted September 14, 2026: candidate `fcaf35e` was installed on the Galaxy S22. The human muted the microphone while a read-only worker ran, watched it finish at 21:05:02Z, and heard the root deliver the four-project result while still muted. The operator reported “that seemed to work well” and authorized landing and closure.

The cached dependency is proven to stop recording on track mute. The successful trial establishes the requested observable behavior; it does not prove the private remote scheduler's mechanism. The procedure below is retained for regression checks and recovery. The additional controls were not all claimed as executed.

## Human-run test

The supplied candidate APK replaces **AgentVoice** (`com.arthack.agentvoice.dev`), preserving its app data with an ordinary update. It does not update Studio. Finish the current phone call before updating the APK: replacing an active client can end its call. No server restart is needed. Never uninstall the app or clear its storage for this test. If Android refuses the update, stop and report the message.

## Primary end-to-end acceptance

After the candidate is available and you reconnect, choose a filename and ask the root to send a bounded, read-only worker to scan directories under `~/code` for that exact filename. The root should record the assignment in HUD. No scan or worker starts until you supply the filename and request the test.

Mute your microphone after dispatch, watch the worker complete in HUD, and **leave the mic muted**. The root should process the result and speak it while the mic is still muted. Hearing that result without unmuting is the acceptance check. If it finishes before you mute, repeat; that run does not test muted completion. Record the mute time; the root should preserve worker completion, root-final and first voice-event timestamps, and passive mic-state observations if available. HUD completion alone is not proof of root processing or audible delivery. If delivery stalls, record the interval first; unmute only as a recovery/failure observation, never as a condition of passing.

## Additional controls

Keep speaker open and the same audio route throughout. Record whether each answer begins promptly, and the approximate mute/unmute times. The working agent can correlate its final output and first voice-event timestamps afterward.

1. **Baseline:** With mic open, ask “Run a ten-second timer, then say BASELINE COMPLETE.” Stay quiet. Confirm the answer arrives after the timer without another utterance.
2. **Mute before the result:** Ask the same task using “MUTED COMPLETE.” After the agent acknowledges, mute the microphone. Leave it muted for the entire timer and response. Confirm the answer arrives while still muted. Repeat once.
3. **Mute before the task:** Leave mic muted and send the timer request as typed text in the existing agent conversation. Use “TYPED COMPLETE.” Confirm the spoken result arrives without unmuting. Skip only if typed input is unavailable; report that omission.
4. **Mute during speech:** With mic open, ask “Count slowly from one through twenty.” After it begins, mute the microphone and leave it muted. Confirm speech continues through twenty.
5. **Muted input and recovery:** While muted, say an otherwise harmless distinctive phrase, such as “purple otter forty-two.” Wait several seconds. Unmute in silence, then ask “Can you hear me now?” Confirm normal new input works and no stale phrase is replayed. If any part of the muted phrase appears in the transcript, stop and report it.
6. **Longer mute:** Leave the mic muted for two minutes, then repeat the typed timer request. This checks sustained use; it does not guarantee an automatic peer renewal occurred. Renewal acceptance requires observed session identity/timestamps.

Failure: an answer waits for unmute, speech pauses when mic is muted, the app reports audio failure, the speaker changes unexpectedly, or muted input appears. Preserve the approximate time and which step failed. Do not repeatedly toggle or restart before recording the symptom.

A lack of audible/transcribed reaction does **not** prove the muted phrase was never transmitted. Automated gate and dependency PCM checks supply separate evidence. The live trial establishes user-visible behavior; it cannot alone prove every encoded sample or network packet.

## Recovery

A separately labelled baseline APK, built from the same pre-candidate revision, is supplied with the test artifacts. End the phone call and update-install that APK to remove the candidate; preserve app data. Do not uninstall. Source rollback is the candidate commit's revert; it requires no server change.

## Automated evidence and limits

`VoicePeerGateTest` executes the actual production gate method with real Java ADM mute setters and fake native-track sinks. It checks repeated mute cycles, privacy-before-track-enable ordering, pending/retired peer isolation, gate-level successor selection, combined muted gates, speaker independence and closed-session fencing. `AudioGateTest` checks acknowledgement and stale-state privacy fences. Neither test loads native media, opens a microphone, or measures RTP.

The investigation's exact cached-library disassembly proves the recording-stop branch and Android StopOnMute default. The separate exact-dependency PCM fixture and its report travel with the trial artifacts. Read its stated instrumentation and limitations before interpreting it as live-device coverage.

Additional media coverage not established by this trial: actual installed binary identity, muted PCM at the encoding boundary, RTP/codec behavior (including DTX), and active/pending peer renewal with the real shared ADM. Do not claim a two-minute wait alone verifies renewal. If the candidate fails despite verified input continuity, inspect the installed Codex desktop bundle's audio/realtime behavior next; do not change its scheduling modes as part of this trial.
