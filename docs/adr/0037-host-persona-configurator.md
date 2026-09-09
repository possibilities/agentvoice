# 0037: Configure the native phone preview from a host browser

Accepted 2026-09-08 at the operator's request to extract the existing configurator
before expanding its scope. Supersedes the on-phone tuning overlay in
[ADR 0035](0035-native-android-voice-client.md).

`android/configurator/` is a separate Bun browser app, launched explicitly with
`bun run android:configure --device <adb-serial>`. It owns the current three-state
selector, one state-specific size slider, Reset and Save. The phone runs the
shared native screen and unchanged Rive adapter, with synthetic voice state and
no control overlay. The fixed +35 dp offset, 35–120% range, state transition
timing and existing saved choices are preserved. This avoids implementing a
second renderer whose preview could differ from the phone.

The host serves fixed assets on loopback with a per-run capability URL and exact
Host/Origin validation. Explicitly selected, authorized ADB forwards a fresh
port to a debug-activity-owned abstract Unix socket. A separate per-session
token admits one owner; bounded requests can only observe/select/size the
preview and save the fixed private profile. Activity stop and transport loss
close that session; no automatic replacement or replay occurs. The host removes
only its own forward on exit. There is no phone TCP listener, production grant,
Codex connection, audio or media. Release manifests and TLS policy are unchanged.
The production same-device browser gateway is not reused or widened.

The phone's private tuning profile remains the initial source. Explicit Save
checks the observed revision, atomically stores version 2 on the phone, then
copies the exact confirmed bytes to a private host JSON file. Partial save
failure is visible. Live edits and Reset are unsaved changes. Version 1 loads
without rewriting and migrates only on Save. Production still uses compiled
defaults; saved tuning is adopted explicitly in code.

The browser, host transport, profile persistence and native preview are separate
modules, so later configuration can extend this app without placing a settings
surface over the voice UI. See the [configurator guide](../../android/configurator/README.md)
for commands, boundaries and verification.
