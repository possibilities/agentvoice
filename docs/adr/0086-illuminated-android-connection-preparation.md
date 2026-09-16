# 0086: Illuminate Android connection preparation

Status: Accepted
Date: 2026-09-16

Extends [0081: Saved Android server profiles](0081-saved-android-server-profiles.md)
and [0041: Configure the native phone preview](0041-host-persona-configurator.md).
This replaces the generic device-access loading dialog on the Persona route only;
scanner, enrollment, permission, takeover and error overlays keep their owners.

## Decision

An initial Persona frame means preparation, not a failed connection. The Activity
projects credential loading, service readiness, deliberate profile selection and
required human actions into `VoicePreparation`; `VoicePresentation` combines it
with the real controller snapshot. The presentation has no media authority.
`connected`, mute state, effective gates and control acknowledgement retain their
existing meanings. Pairing still does not start a call.

Preparation, first connection and permission/confirmation waits use a steady,
illuminated Persona and readable neutral control faces. Those controls remain
disabled. Preparing has no fictitious Connect or Cancel action before an attempt
exists. The actual permission or takeover surface owns its required action.
Successful connection immediately reveals real state and eligible controls,
without waiting for an animation or a minimum loading interval.

A controller observation records whether its current attempt has reached live.
It survives Activity recreation with that controller and resets with a new
attempt. A later loss uses the disconnected grey presentation rather than
replaying the initial establishment treatment. Failed access or voice remains an
error; an explicit retry may prepare over the old failed snapshot. Loading saved
access while a call attempt is retained does not obscure its connection truth,
including an attempt still connecting or one whose voice was lost. Saved-access
recovery stays separately available on Connections. Profile loading and selection
use per-operation ownership tokens as well as lifecycle epochs, so a cancelled
predecessor cannot publish a result or clear a successor’s loading/busy state. A retained disconnected
attempt offers End attempt before reconnecting, not Cancel or a premature Connect.

Decoration is independent of control enablement. A scene-owned presentation
context supplies neutral light and unavailable copy; control callbacks still
use `CallUi`. Original and Contained retain their existing native Rive instances,
asset bytes and placement. Preparation recolors their asleep/idle silhouette and
settles it without motion. There is no additional clock, audio energy, activity
trace or synthetic coding-work signal. Reduced motion and background lifecycle
continue to constrain the existing renderers.

The shipping profile and provenance remain unchanged: this is state behavior,
not a promotion of a new Studio preference. Studio's existing Connecting rehearsal
uses the same illuminated treatment without acquiring network or media authority.

## Next design exploration

A non-default Persona beacon remains a follow-up. Its proposed fixed-center
neutral wave would take 240 ms to gather, dissipate outward by 960 ms, then rest
until a 2.4-second cycle ends. It would stop immediately for a required action,
failure or cancellation, and yield immediately to live state. Reduced motion
would use a still pose. This is indeterminate connection activity, never progress
or a simulated remote acknowledgement. It needs a separate Studio audition and
native renderer review; no new profile/protocol field is introduced here.

Activity-carrying traces were deferred here and are implemented by
[0087](0087-gated-android-trace-energy.md). That implementation must use real
gated input/output levels, keep route geometry fixed, clear energy immediately
when a gate closes, and keep neutral connection light distinct from lime capture
and violet playback. The existing trace geometry and light clock are unchanged.

## Verification boundary

Host state tests cover initial resolution, service wait, explicit retry, pending
actions, retained live calls, failures and later disconnects. Compose host renders
exercise illuminated disabled controls, literal status, no premature action,
Cancel and confirmed live enablement without microphone or network. The pinned
Rive asset and actual first native frame require a physical-phone check; a host
control render does not establish those pixels. Build/lint, Studio unit tests and
APK isolation audits qualify the code and packaging before that handoff.
