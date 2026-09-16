# 0087: Carry gated Android audio energy along the traces

Status: Accepted
Date: 2026-09-16

Extends [0041](0041-host-persona-configurator.md) and resolves the activity-trace
deferral in [0086](0086-illuminated-android-connection-preparation.md). Connection
preparation and the optional beacon exploration retain their existing behavior.

## Decision

The existing traces explain the two audio directions. A restrained lime band
travels from Human controls toward Persona; a violet band travels from Persona
toward Agent controls. Each route explicitly carries Capture or Playback through
the shared portrait geometry and its landscape transform, including handedness.
Both channels can show measured energy at once. Persona's single selected state
does not arbitrate the two live meters.

The existing lifecycle-aware `PreviewSpiritMotion` owns a 1.8-second flow phase
alongside its slow ambient phase. Its normalized, smoothed input/output levels
drive both route intensity and control-face light. Audio activity remains visible
when optional ambient Spirit light is Still. A broad cosine band enters and
leaves beyond the endpoints; eligible channel controls share that band's endpoint
intensity. During PTT, the held control lights while the persistent Human mute
rocker retains its muted face. Path distance carries the band around bends without changing any
route points, clear aperture, control bounds, semantics or pointer ownership.
There is no new clock, media source, coding-work claim or binary asset edit.

The current effective gates fence the draw as well as the model. Closing a gate,
pending controls, disconnect or leaving the resumed lifecycle clears energy
without a fade-out or another animation tick. A still scene under reduced motion
has no moving band or audio-driven light modulation; its normal static routes,
channel faces and semantic state remain. Preparation/connecting retains steady
neutral light and disabled controls, with no colored energy.

Both Original and Contained use the same overlay and their established aperture
calculation. Route ink and activity ink share the same radial feather, preserving
the clear center and configured tip opacity. Rive instances and pinned bytes,
shipping profile/provenance and generated defaults are unchanged.

Studio's existing transient Synthetic voice activity auditions the selected
Listening or Speaking channel using its existing deterministic envelope. This
needs no new profile field, protocol revision or default promotion. Real calls
use only the already gated controller meters. Host render tests explicitly
exercise simultaneous capture and playback.

## Verification and physical boundary

Model tests cover independent duplex energy, directions, stale draw frames,
immediate cancellation, finite levels and suspended/resumed phase. Native
Robolectric Canvas renders cover portrait and both landscape sides, visible
movement, unchanged control bounds/actions and exact stale-energy removal.
Existing trace/aperture, presentation and Android tests remain required, followed
by instrumentation compilation, lint, optimized production/release builds and
shipping isolation audits.

Host renders deliberately omit native Rive. Isolated Galaxy S22 instrumentation
also checks Original and Contained in the production immersive viewport, portrait
and both landscape sides, duplex phase samples, closed gates, neutral connection
and system reduced motion. It checks accessible controls and retained bounds
without opening media or the Studio draft. Sustained real-call frame pacing and
full screen-reader interaction remain separate checks. For later qualification,
after an explicit phone handoff, preserve Studio's draft and the real app's data,
then:

1. Install the built production and Studio APKs without clearing data. In Studio,
   audition Synthetic voice Listening and Speaking with Original and Contained,
   all trace patterns, portrait and both landscape sides; restore prior choices.
2. On an authorized real call, compare silent open gates with speech and playback,
   then overlap capture/playback. Confirm lime travels inward and violet outward;
   inspect brightness and frame pacing at native scale as well as full screen.
3. Toggle each mute rapidly and press/release/cancel PTT, including rotation and
   Back. Confirm energy clears immediately, control targets stay fixed and held
   capture closes correctly. Inspect the clear Persona center throughout.
4. Verify cold preparation, connecting, pending controls and later disconnect:
   no activity band before real gates/levels, and neutral startup remains distinct.
5. Disable system animator duration, vary audio levels, and confirm static routes and truthful
   controls with no energy decoration. Background/lock and return; no
   catch-up sweep or stale energy. Restore the original system setting.
6. Check Quiet/Grayscale and accessible labels/actions, restore the prior app and
   Studio state, and release the phone. No service restart is needed.
