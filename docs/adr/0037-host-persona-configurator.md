# 0037: Configure the native phone preview from a host browser

Accepted 2026-09-08 at the operator's request to extract the existing configurator
before expanding its scope. Supersedes the on-phone tuning overlay in
[ADR 0035](0035-native-android-voice-client.md).

`android/configurator/` is a separate Bun browser app, launched explicitly with
`bun run android:configure --device <adb-serial>`. It owns the design directions,
three-state selector, one state-specific size slider, shared vertical position,
Reset tuning and Save profile. The phone runs the shared native screen or
debug-only studio controls around the unchanged Rive adapter, with synthetic
voice state and no tuning overlay. The initial +35 dp offset, 35–120% range,
state transition timing and existing saved choices are preserved. This avoids
implementing a second Halo renderer whose preview could differ from the phone.

The design studio presents Current as the existing screen, Signal as quiet
header/glyph mutes/beam hold, Field radio as slide-away header/rockers/trigger,
and Ghost terminal as hidden header/keycaps/keycap hold. Header, mute and hold
choices can be mixed independently; selecting a part enters the studio layout.
Presets preserve all three size values and shared position. Studio disclosure
eases only Halo's center to reflect the header's space; its diameter and the
mute/PTT targets remain fixed. Header reveal is explicit, and slide-away chrome
stays open during interaction or when Keep open is selected. These choices are
reviewable alternatives; the production UI is unchanged until explicit adoption.

The host serves fixed assets on loopback with a per-run capability URL and exact
Host/Origin validation. Explicitly selected, authorized ADB forwards a fresh
port to a debug-activity-owned abstract Unix socket. A separate per-session
token admits one peer at a time; bounded requests can only observe the preview,
select its design and synthetic state, adjust size/position, and save the fixed
private profile. The host removes
only its own forward on exit. There is no phone TCP listener, production grant,
Codex connection, audio or media. Release manifests and TLS policy are unchanged.
The production same-device browser gateway is not reused or widened.

Updated 2026-09-08 at the operator's request: the debug configurator now
automatically reconnects after preview backgrounding/recreation and temporary
ADB loss, superseding this ADR's initial no-reconnect choice. Activity stop
closes the listener; returning reopens it with the same private binding and
unsaved preview state. The host retries with bounded backoff, recreates only
its own missing forward and authenticates each new peer before publishing its
state. It retains the browser URL and never foregrounds the activity on retry.
Force-stop/task dismissal and host restart require a fresh binding. Android's
private saved-instance state retains this debug token, never a production grant.
Production voice and attachment disconnect policies remain unchanged.

Only observation is retried. Browser edits and saves name the observed connection
generation and are refused after reconnect. In-flight commands are not replayed;
an ambiguous Save stays visible even after the connection recovers. Closing the
host cancels retries, closes late peers and removes only this run's forwards.

The phone's private tuning profile remains the initial source. Explicit Save
checks the observed revision, atomically stores version 3 on the phone, then
copies the exact confirmed bytes to a private host JSON file. The host checks
both design and geometry in the receipt before writing that copy. Partial save
failure is visible. Live edits and Reset tuning are unsaved changes. Version 1
and 2 phone profiles load without rewriting and select Current; version 1 seeds
all three sizes. Stored position is retained, with +35 dp used when absent.
Older phone profiles become version 3 only on explicit Save. Production still
uses its existing screen and compiled defaults; adoption remains explicit in code.

The vertical position extension replaced the initial fixed offset with one
shared −200…+200 dp slider in integer steps; +35 dp remains the default.
That extension used protocol 2 and retained profile version 2. The design studio
supersedes those wire/save versions with preview protocol 3 and profile version 3.
Protocol 3 carries live, saved and default designs alongside sizes and offsets.
Its bounded design object contains `layout: original|studio`,
`header: quiet|drawer|none`, `mute: glyphs|rockers|keycaps`, and
`hold: beam|trigger|keycap`. Reset tuning restores only geometry, preserving
the selected design and synthetic state. Save keeps all design and geometry
choices. Production defaults and Halo animation sequencing remain unchanged.

The browser, host transport, profile persistence and native preview are separate
modules, so later configuration can extend this app without placing a settings
surface over the voice UI. See the [configurator guide](../../android/configurator/README.md)
for commands, boundaries and verification.
