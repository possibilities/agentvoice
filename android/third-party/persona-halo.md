# Persona Halo

The original `halo-2.0.riv` asset used by Vercel AI Elements Persona is bundled
unchanged as `app/src/main/res/raw/persona_halo.riv`.

- Asset: https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/halo-2.0.riv
- Source: https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/persona.tsx
- Retrieved 2026-09-08, 4,497 bytes.
- SHA-256: `c8d97df33c47f52c993667515700e12f110539a46048b142a0ec787dba9dcc96`
- AI Elements component-code copyright: Copyright 2023 Vercel, Inc.; Apache License 2.0.
  https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/LICENSE

## Attribution and asset-license evidence

The AI Elements repository's Apache-2.0 license covers its component code. The
Persona component references the `.riv` at a separate Vercel Blob URL; that
repository license alone does not establish the external asset's license.

Elements originated at Surge Studio. On 2026-09-09, its
[homepage](https://elements.surge.studio/) stated that Vercel had acquired
Elements and that the entire product range was now free in AI Elements. Its
[customization documentation](https://elements.surge.studio/docs/customization)
describes the original purchase as including a `.riv` runtime file and `.rev`
editable source.

The published [Surge license](https://elements.surge.studio/legal/license),
effective 2024-01-29, identifies Hayden Barnett trading as Surge Studio and
states that Surge Studio owns the asset copyright. It permits derivative
end applications while restricting redistribution in tools, templates and
source form. This is pre-acquisition text, not evidence of the current Vercel
asset terms. The acquisition/free-availability statement does not itself
specify modification or redistribution terms for the externally hosted `.riv`.

As checked on 2026-09-09, [AI Elements issue 471](https://github.com/vercel/ai-elements/issues/471)
was open with no comments, asking about asset licensing and editable source.
The current external asset license remains unspecified in the inspected
sources. This record does not relicense that asset or claim that either
Apache-2.0 or the Rive runtime's MIT license resolves its terms. Attribution
does not imply endorsement by Surge Studio, Hayden Barnett, Vercel or Rive.

## Native adaptation and Contained Halo

`PersonaHalo.kt` adapts the component's `default` state machine, boolean inputs
and `color` view-model binding to native Android. The asset is loaded locally;
CDN asset loading and pointer interaction are disabled. No WebView, JavaScript,
React, remote content, credential or audio input reaches this renderer.

The adapter observes the asset's `listening_out` state to synchronize enlargement
into Idle with its exit. Enlargement into Speaking waits for `listening_off`
to avoid magnifying the outgoing rings. The bundled exit timeline reports a
one-second effective duration. Rive 11.12 adds the metadata instance to the
artboard's owned dependencies; artboard teardown releases it.
The transform scales the whole native view, including the outer rings.

AgentVoice modification, 2026-09-09: the **Contained Halo** variant derives
modified runtime bytes in memory from the verified original asset. It adjusts
listening rings and their pulse inward, replaces elastic easing with cubic
easing, and adds adjustable speaking/idle motion and per-state colors. These
are AgentVoice modifications, not an upstream asset release. The bundled
original `.riv` and Original renderer remain unchanged; this variant
does not supply or claim to be the original editable `.rev` source.

## Runtime and packaged notices

The runtime is `app.rive:rive-android:11.12.0` (MIT):
https://github.com/rive-app/rive-android/tree/11.12.0
https://github.com/rive-app/rive-android/blob/11.12.0/LICENSE

The pinned file uses legacy state-machine boolean inputs. Rive's native
`RiveAnimationView` supports them and its GPU renderer; the new Compose API
does not expose them. Keep this adapter isolated when upgrading Rive. Its
view lifecycle owns renderer cleanup. The general Rive Compose worker helper
also acquires Rive's audio engine; this visual uses the native view API instead.

The original AI Elements notice, full Apache-2.0 text and full Rive MIT license
remain in `app/src/main/assets/notices` and are packaged in both APKs.
`Persona-Halo-NOTICE.txt` separately records asset provenance, the dated
AgentVoice modification and the asset-license evidence boundary. The adopted
shipping profile now uses Contained in the release app, with its selected tuning
applied in memory. The studio retains the Original comparison.

## Contained Thinking geometry — September 11, 2026

The four Thinking dash ellipses retain their 128×128 dimensions but use scaleX
1.05 instead of the authored1.28. Their horizontal centerline reach beyond the
64-unit frame radius falls from17.92 to3.2 artboard units; the frame circle and
vertical geometry are unchanged. This affects only Contained. Original stays
byte-exact, and no layout scale or saved tuning choice is changed.

Verified against the pinned4,497-byte source hash above and public generated
Rive property definitions at runtime commit
`df5d96b7deb6af1822383171d566bc1e4949ab51`. The static float offsets304/364/436/496
are scaleX on artboard ellipse components11/15/19/23 (Dash2 Mirror, Dash2,
Dash1 Mirror, Dash1). Thinking loops2/1 animate only TrimPath start/end/offset
(properties114/115/116), never geometry. Their0.2-length sweep,195-frame loop,
color binding, inherited Idle breathing, and empty thinking_off timeline remain
unchanged. Implicit zero start/end hides these dashes outside Thinking.
The existing source hash and per-site raw-float guards apply before mutation.

Thinking wingspan tuning, September 11, 2026: Contained now exposes an integer
1–10 range for those same four scaleX fields. Setting 2 preserves 1.05; setting 1
uses 1.025; settings 3–9 interpolate from 1.05 to 1.28, and 10 equals authored 1.28.
This changes only the dash reach, retaining the source circle, Y geometry and
complete trim-path timelines. Older designs default to 2. Original stays intact.
