# 0037: Configure the native phone preview from a host browser

Accepted 2026-09-08 at the operator's request to extract the existing configurator
before expanding its scope. Supersedes the on-phone tuning overlay in
[ADR 0035](0035-native-android-voice-client.md).

`android/configurator/` is a separate Bun browser app, launched explicitly with
`bun run android:configure --device <adb-serial>`. Its Controls panel owns
composition, surface light, control height and talk-button share; its
Persona panel owns connection preview, state, variant, size, position, motion
and colors. Save profile retains both panels' design and geometry. The phone
runs debug-only studio controls around native Halo, with synthetic voice state
and no tuning overlay. Original retains its renderer and transitions; Contained
uses the separate native adaptation described below. The host never substitutes
a browser Halo renderer for the phone.

The operator narrowed the initial Current/Signal/Field radio/Ghost terminal
exploration to Rockers or Keycaps for mute controls and, initially, one fixed Trigger.
That iteration removed preset, header and talk-surface selectors; protocol 6
restored an independent Trigger/Rocker talk-surface selector. Protocol 8 converges
both controls on Rockers and removes those style selectors. The visible and accessible
label is Push to talk; pressing and holding still opens the temporary capture
gate, and release or cancellation closes it. Active styling keeps a dark face
with focused lime accents.

Controls height spans 240–480 dp, including the fixed 16 dp join. Push-to-talk
share spans 30–60% of the total; the mute row uses the remaining height after
the join. Baseline geometry is 130 + 16 + 116 = 262 dp, so the exact talk share
is `116 / 262 × 100` (about 44.3%). Reset button sizes restores only these
two dimensions, keeping composition, light and Persona tuning. The granular
Persona resets below replace the former Reset Persona. Increasing control height moves
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
checks the observed revision, atomically stores version 8 on the phone, then
copies the exact confirmed bytes to a private host JSON file. The host checks
design, geometry, Halo and spirit settings in the receipt before writing that
copy. Partial save failure is visible. Live edits and all resets are unsaved changes.
Version 1–7 phone profiles load without rewriting; retired button styles map to
Rockers in memory. Version 1 seeds all three Halo sizes. Stored position is
retained, with +35 dp used when absent. Versions 1–3 use the control geometry
baseline; versions 4–7 retain control dimensions. Versions 1–5 select Open;
versions 6–7 keep their composition. Versions 1–4 select Original; versions 5–7
retain their Halo settings. Version 7 keeps its spirit settings.
Older profiles become version 8 only on explicit Save. Production still
uses its existing screen and compiled defaults; adoption remains explicit in code.

The vertical position extension replaced the initial fixed offset with one
shared −200…+200 dp slider in integer steps; +35 dp remains the default.
That extension used protocol 2 and retained profile version 2. The initial
design comparison added protocol/profile version 3. The narrowed studio introduced
preview protocol 4 and profile version 4. Its bounded design fixed
`layout: studio`, `header: none`, `hold: trigger`, permitted
`mute: rockers|keycaps`, and added integer `controlsHeightDp` (240–480) and finite
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

Protocol/profile 5 added `halo`: variant (`original|contained`), a shared Contained
size (35–120%, default 78%), ring spread (35%), listening pulse (25%), speaking
motion (25%), idle breathing (25%), and three opaque RGB colors. Motion ranges
are integer 0–100%. Initial Speaking/Listening/Idle colors match the native
violet/lime/warm-white palette. Original retains its independent sizes and
colors. Switching variants preserves both configurations. Its former Reset
Persona restored the active variant and shared offset. Version 1–4 profiles
load as Original without a write. Connection simulation stays transient and
media remains absent.

Protocol/profile 6 adds `design.composition: open|dock|yoke` and permits
`design.hold: trigger|rocker`, independently of `mute: rockers|keycaps`.
Trigger and Open were its defaults. Dock is a quiet chamfered shared plate
behind lower Persona and the control deck. Yoke is a minimal stem that branches
toward the mute buttons. Both are passive stationary neutral drawing layers:
they add no status, animation or interaction and change no layout, Halo renderer,
tuning, full-bleed artwork or touch target. Open keeps the unframed composition.

The reset controls now have precise scopes. Reset button sizes affects only
height/share. Reset size affects Contained's shared size or the current Original
state's size. Reset position affects only the shared offset. Reset animation
affects only Ring spread, Listening pulse, Speaking motion and Idle breathing.
Reset colors affects only the three Contained colors. Every reset preserves
other choices and remains unsaved until explicit Save. Save validates the exact
composition, control styles, geometry and Halo receipt before the host copy is
written. Version 1–5 profiles remain readable without automatic rewriting;
existing defaults, including Original tuning and the exact control ratio, remain intact.


Updated 2026-09-09: protocol/profile 7 adds independent `spirit` choices:
`surface: still|soft`, `strengthPercent: 0..100` (default 35), and
`persona: fixed|follow`. Still/Fixed preserves the current rendering and is the
migration default for versions 1–6. Reset light affects surface/strength only;
Reset color behavior affects persona only. Base Halo colors, motion and geometry
remain independent. Exact Save receipts include spirit. Transient
`activity: steady|voice` selects the rehearsal envelope and never enters a profile.

Soft light uses one lifecycle-aware 14-second scene clock, a draw-only face wash
capped at 3.5% alpha, and slow attack/release on the existing level-envelope seam.
Binary mute state, acknowledged capture, touch geometry and text remain immediate.
Closed gates fence activity immediately. Reduced motion freezes both drift and
energy modulation; background/disconnect/Off stop frame work. Follow channels
uses small per-family tonal changes and a 900 ms gate/palette blend; it neither
changes Rive motion tuning nor repeatedly settles the native pose on recoloring.
The preview remains synthetic and opens no microphone, playback or voice call.

`design.composition` also accepts Socket and Traces: stationary mechanical
supports and paired PCB routes. A placement-derived clear aperture prevents
these layers from appearing inside the transparent Persona center; their geometry
never follows an animated frame. Version 6 remains restricted to Open/Dock/Yoke
on load. All five choices retain the same native renderer and control layout.
An acknowledged open microphone is labelled Live now; PTT eligibility and
release behavior remain unchanged.

Protocol/profile 8 converges the studio on Rockers for both mute and Push to
talk. The non-Rocker painters, selectable styles and browser controls are
removed. The current design contract fixes `mute: rockers` and `hold: rocker`;
separate legacy readers validate each older shape before mapping its styles in
memory. Placement, composition, dimensions, Halo and spirit values survive
migration, and neither saved phone nor host profile is rewritten until Save.
Current receipts require version 8 and the exact fixed-style design. Rocker
geometry, dark active styling, PTT gates, renderer identity and all seven scoped
resets retain their behavior. This remains a debug studio convergence;
production adoption is still a separate decision.
