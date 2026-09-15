# Bluetooth hot-routing acceptance procedure

This trial checks that an active AgentVoice call follows a Bluetooth communication
headset for both playback and capture, then falls back without reconnecting. The
candidate updates **AgentVoice** (`com.arthack.agentvoice.dev`) in place and keeps
its saved pairing data. It does not update Studio or require a server restart.

Finish any current phone call before installing the candidate. Update with `-r`;
never uninstall the app or clear its storage. Grant Nearby devices when Android
asks so AgentVoice can select Bluetooth routes. Keep a known pre-candidate APK for
recovery.

## Primary acceptance

1. Leave the Bluetooth headset powered off or disconnected. Open AgentVoice and
   establish a call on the phone speaker with HUMAN and AGENT open. Ask, “Say
   SPEAKER BASELINE,” and confirm the answer is audible from the phone.
2. Without hanging up, leaving the call screen, or touching either audio control,
   power on or connect the headset. Allow up to 30 seconds for Android to activate
   its communication profile. The call must remain Connected throughout.
3. Confirm playback has moved to the headset: ask, “Say HEADSET OUTPUT,” and hear
   the answer only through the headset.
4. Confirm capture has moved too. Hold the phone at arm's length, speak the unique
   phrase “headset microphone blue seven” into the headset microphone, and verify
   that phrase appears as the new human utterance. Do not use a result heard only
   through acoustic leakage as microphone evidence.
5. Disconnect or power off the headset without hanging up. Allow up to 30 seconds
   for fallback. The app must remain Connected and the ongoing notification's
   elapsed time must not restart.
6. Ask, “Say SPEAKER FALLBACK,” using the phone microphone. Confirm the new phrase
   is received and the answer plays from the phone speaker.
7. Reconnect the same headset once more and repeat steps 3–4. This checks that the
   callback lifecycle was retained after the first fallback.

Pass requires all three transitions—speaker to headset, headset to phone, and
phone back to headset—to preserve one call while moving both directions of audio.
A Connected label alone is insufficient. Failure includes a Disconnected state,
a new call attempt, notification timer reset, output remaining on the wrong device,
capture remaining on the phone, a route error, or no transition after 30 seconds.
Record the approximate time and failing step before changing settings or retrying.

## Optional read-only Android evidence

During an explicitly granted phone handoff, capture `adb -s <serial> shell dumpsys
audio` immediately before the headset connects, after headset activation, and
after disconnect. Keep raw dumps private because they can contain device IDs and
unrelated audio state. Check for `MODE_IN_COMMUNICATION`, the selected communication
device, Bluetooth SCO or BLE input/output while connected, and speaker/input
fallback afterward. Dumpsys supplements the heard/spoken trial; it does not prove
which physical microphone produced a sample.

## Recovery

If the candidate fails, end the call and update-install the pre-candidate APK with
`adb -s <serial> install -r <baseline-apk>`. Preserve app data. No desktop service
restart is needed. Source rollback is a normal revert of the candidate commit.

Automated JVM tests cover priority, asynchronous route confirmation, pending-request
deduplication, add/removal transitions, exact route identity, rejection and timeout
retry, lower-priority fallback, missing Bluetooth permission, failure reporting,
and teardown fencing. They do not open hardware, establish SCO/BLE, or prove OEM
route timing and real WebRTC audio continuity.
