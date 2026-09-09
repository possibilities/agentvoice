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

AgentVoice modification, 2026-09-09: the **Contained Halo** debug variant derives
modified runtime bytes in memory from the verified original asset. It adjusts
listening rings and their pulse inward, replaces elastic easing with cubic
easing, and adds adjustable speaking/idle motion and per-state colors. These
are AgentVoice modifications, not an upstream asset release. The bundled
original `.riv` and production `PersonaHalo.kt` remain unchanged; this variant
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
AgentVoice modification and the asset-license evidence boundary. Including
that notice in the release APK does not include the debug-only variant there.
