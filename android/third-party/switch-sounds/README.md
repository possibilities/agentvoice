# Rocker audition families

Prepared September 9, 2026 for green-river's Android design studio integration.
These are audition candidates, not operator-approved production defaults.

Licensing-cleared integration set: only the six WAV files identified by SHA-256
below, with this receipt and LICENSE.txt. All six use solely the verified CC0
source recordings. Other files elsewhere in the scratch directory are not part
of this clearance. In particular, procedural-tap-familiar.wav is excluded:
the generator's MIT software license alone does not establish its output terms.

## Candidates

Start with Rocker 29: it comes from an existing operator audition selection and
retains a longer recorded decay. Rocker 13 provides the compact comparison.
The recommendation is based on provenance, relationship between cues, and measured
timing; final audible preference and phone-speaker suitability remain for the operator.

| Family | Both mute buttons | PTT down | PTT up |
| --- | --- | --- | --- |
| Rocker 29 | rocker-29-toggle.wav, 201.292 ms | rocker-29-ptt-down.wav, 222.542 ms | rocker-29-ptt-up.wav, 180.792 ms |
| Rocker 13 | rocker-13-toggle.wav, 44.021 ms | rocker-13-ptt-down.wav, 47.792 ms | rocker-13-ptt-up.wav, 40.375 ms |

All are mono PCM16 at 48,000 Hz. Toggle and down peak at -6 dBFS; up peaks at
-8 dBFS. These are peak levels, not perceptual loudness matching.

## Provenance and permission

Original creator: Kenney Vleugels (Kenney.nl), UI SFX Set.
Original package URL referenced by the mirror: https://kenney.nl/assets/ui-audio
Retrieved mirror: https://github.com/Calinou/kenney-ui-audio
Pinned commit: 8c3d81b9159d058c444f89d12d518276b0b09345
Paths: addons/kenney_ui_audio/switch29.wav and switch13.wav.
The mirror says its WAVs were converted from the original Ogg Vorbis pack.
Our files are derived from those WAVs, not verified lossless recording masters.

The archive's LICENSE.txt, also present beside the source WAVs, explicitly says:

> License (Creative Commons Zero, CC0)
> http://creativecommons.org/publicdomain/zero/1.0/
> You may use these assets in personal and commercial projects.
> Credit (Kenney or www.kenney.nl) would be nice but is not mandatory.

CC0 permits modification and redistribution, including raw WAVs in a public
source repository and app bundles. No attribution or share-alike requirement.
Preserve the supplied license and this provenance as good asset hygiene.
Optional credit: "Interface sounds adapted from Kenney's UI SFX Set (CC0)."
Our processing adds no additional license restriction.
No paid stock files or generated comparator are included in these families.

Source SHA-256:

- switch13.wav: 89f5746144f41a5dbf889d017ab549a6246922662321ddf25a76b4de69f7819c
- switch29.wav: 6403b4eeda8ee0eccbbc9c95d3e5de176126eb49754046678ecdb60991822750

## Processing

Reproducible command script: android/third-party/switch-sounds/build-families.sh (SoX).
Pass the pinned mirror checkout and a disposable output directory as arguments.
Average stereo channels to mono; remove leading signal below -45 dB using SoX's
0.1 ms detection period; remove trailing near-silence at -60 dB with a 1 ms
period; resample to 48 kHz; normalize peaks; add 2 ms leading and 8 ms trailing
silence. The trimmed fronts should be judged by ear before final adoption.
PTT down uses speed 0.90 (about -1.82 semitones and longer duration); PTT up
uses speed 1.12 (about +1.96 semitones and shorter duration), plus 2 dB lower peak.
Toggle has original pitch. No layering, reverb, synthetic samples, or lossy export.

Run android/third-party/switch-sounds/inspect-families.mjs to validate PCM format, nonzero samples, peaks,
duration, onset and SHA-256. All six passed. Signal above -40 dBFS starts at
2.0–2.3 ms. Rocker 29's strongest energy finishes much earlier than its quiet tail.

## Suggested integration behavior

- A family selection chooses all three cues together.
- Both mute buttons use the same toggle cue, once when a local toggle commits.
- PTT down fires once when a local hold is accepted; PTT up once when that accepted
  hold ends by ordinary release. Cancel, background, disconnect and teardown
  should clear the hold without an extra success-like release cue.
- No sounds from reconnect state hydration, render/recomposition, pending or
  disabled gestures, remote changes, or saved-profile loading.
- Treat down as interaction feedback unless actual capture is confirmed. Do not
  imply microphone readiness with a sound emitted before acknowledgement.
- Start audition gain at 0.7 for every cue (about -3.1 dB); up's relative attenuation
  is already baked in. Adjust final level on the phone; do not normalize each cue
  independently at playback, because that erases the intended quieter release.
- Preload short cues with native low-latency playback. Keep them client-local,
  with no routing into a transmitted track. Acoustic pickup still needs a phone test.
- Respect the operator's explicit sound setting. Preview selection is not production
  adoption. Keep any protocol/profile changes with green-river.

Output SHA-256:

- rocker-13-toggle.wav: 6113827f2515b73692c1149caf7481e08e563be41e45af8751c4fac58508cef8
- rocker-13-ptt-down.wav: 54ca082e5f2759ac138061c90b6ecab213d72e14e44447300e8e170b4aaf4c72
- rocker-13-ptt-up.wav: 306255a30935286a798dc80bd086eb5fb0c3e259d5489f31491dee001aace18c
- rocker-29-toggle.wav: e6e4878c610ef7346dabc6e67f0b9940a34812fb7a45f88e87de913900b83fe0
- rocker-29-ptt-down.wav: 840ff7a4c9a19db132a8505728824cf2a9b44ea6072a227ac04ff47652a0fbc3
- rocker-29-ptt-up.wav: e67574bbc50bf2e2fb3853be4fc887bb31360fb068c2383927a016836f38e1ce
