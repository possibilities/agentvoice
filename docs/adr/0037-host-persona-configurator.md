# 0037: Configure the native phone preview from a host browser

Accepted 2026-09-08 at the operator's request to extract the existing configurator
before expanding its scope. Supersedes the on-phone tuning overlay in
[ADR 0035](0035-native-android-voice-client.md).

`android/configurator/` is a separate Bun browser app, launched explicitly with
`bun run android:configure --device <adb-serial>`. Its Controls panel owns mute
style, control height and talk-button share; its Persona panel owns connection
preview, the three-state selector, state-specific size and shared vertical
position. Save profile retains both panels' design and geometry. The phone runs
debug-only studio controls around the unchanged Rive adapter, with synthetic
voice state and no tuning overlay. The initial +35 dp offset, 35–120% range,
state transition timing and existing saved choices are preserved. This avoids
implementing a second Halo renderer whose preview could differ from the phone.

The operator narrowed the initial Current/Signal/Field radio/Ghost terminal
exploration to Rockers or Keycaps for mute controls and one fixed Trigger.
Preset, header and talk-surface selectors are removed. Its visible and accessible
label is Push to talk; pressing and holding still opens the temporary capture
gate, and release or cancellation closes it. Active styling keeps a dark face
with focused lime accents rather than filling the whole trigger.

Controls height spans 240–480 dp, including the fixed 16 dp join. Push-to-talk
share spans 30–60% of the total; the mute row uses the remaining height after
the join. Baseline geometry is 130 + 16 + 116 = 262 dp, so the exact talk share
is `116 / 262 × 100` (about 44.3%). Controls Reset defaults restores only these
two dimensions, keeping the selected mute style. Reset Persona independently
restores Halo's three sizes and shared offset. Increasing control height moves
the available center without changing Halo's diameter or its tuning values.

The operator then removed the header entirely. A top overlay with a static
glyph remains visible only while Connecting or Disconnected; it slides down
and away over 240 ms, respecting disabled animations. Connected removes the
notice without a success toast. The notice reserves no height and shifts
neither Halo nor controls. The host's connection selector is a synthetic preview
condition, distinct from its actual ADB link. It cannot start media and is not
persisted in the profile. The production layout and behavior stay as before
until explicit adoption; its labels now say Push to talk.

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
checks the observed revision, atomically stores version 5 on the phone, then
copies the exact confirmed bytes to a private host JSON file. The host checks
design, geometry and Halo settings in the receipt before writing that copy. Partial save
failure is visible. Live edits and both resets are unsaved changes. Version 1,
2, 3 and 4 phone profiles load without rewriting; version 1 seeds all three Halo
sizes. Stored position is retained, with +35 dp used when absent. Legacy profiles
use the new control geometry baseline and fixed headerless Trigger layout.
Version 3 retains Rockers or Keycaps; legacy Glyphs and missing mute choices
use Keycaps. Version 4 retains control dimensions; older profiles select Original and become
version 5 only on explicit Save. Production still
uses its existing screen and compiled defaults; adoption remains explicit in code.

The vertical position extension replaced the initial fixed offset with one
shared −200…+200 dp slider in integer steps; +35 dp remains the default.
That extension used protocol 2 and retained profile version 2. The initial
design comparison added protocol/profile version 3. The narrowed studio introduced
preview protocol 4 and profile version 4. Its bounded design fixes
`layout: studio`, `header: none`, `hold: trigger`, permits
`mute: rockers|keycaps`, and adds integer `controlsHeightDp` (240–480) and finite
`holdSharePercent` (30–60). Protocol 4 added live, saved and default designs
alongside sizes and offsets, plus transient
`connection: connected|connecting|disconnected`. Save excludes the connection
selection. The retained internal `hold` field does not change the user-facing
Push to talk label. Production defaults and Halo animation sequencing remain unchanged.

The browser, host transport, profile persistence and native preview are separate
modules, so later configuration can extend this app without placing a settings
surface over the voice UI. See the [configurator guide](../../android/configurator/README.md)
for commands, boundaries and verification.

Updated 2026-09-09: the operator requested an altered Halo and per-state colors.
The debug-only Contained variant patches a checksum-verified copy of the original
4,497-byte asset in memory. Listening ring spread and pulse move inward; cubic
interpolation replaces elastic overshoot. Speaking/idle gains scale authored
motion around 1. The original file and main renderer remain unchanged and remain
available as Original. The operator explicitly chose to proceed with best-effort
attribution without waiting for upstream permission. [The provenance record](../../android/third-party/persona-halo.md)
and packaged notice distinguish code/runtime licenses from the external asset's
unspecified current license; no upstream contact was made.

Protocol/profile 5 adds `halo`: variant (`original|contained`), a shared Contained
size (35–120%, default 78%), ring spread (35%), listening pulse (25%), speaking
motion (25%), idle breathing (25%), and three opaque RGB colors. Motion ranges
are integer 0–100%. Initial Speaking/Listening/Idle colors match the native
violet/lime/warm-white palette. Original retains its independent sizes and
colors. Switching variants preserves both configurations; Reset Persona restores
only the active variant and shared offset. Save validates the exact Halo receipt
alongside control dimensions and Original sizes. Old profiles load as Original
without a write. Connection simulation stays transient and media remains absent.
