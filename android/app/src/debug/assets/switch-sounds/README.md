# Cleared rocker quartets (revision 2)

This receipt supersedes the trio mapping. Only the eight WAVs identified below
are in this integration delivery. Both families now provide toggle-on,
toggle-off, ptt-down and ptt-up. On means the channel becomes unmuted; off means
it becomes muted. HUMAN and AGENT share the same on/off pair.

## Clearance and source

All eight derive solely from Kenney Vleugels' UI SFX Set, explicitly dedicated
to CC0 1.0 in the source archive's LICENSE.txt (copied here). CC0 permits
commercial use, modifications, raw public repository distribution and app
bundling without payment, attribution or share-alike requirements. Our processing
adds no restriction. No third-party audio was introduced by the processing.
The procedural comparator elsewhere in the scratch workspace is excluded.

Original package link recorded by the mirror: https://kenney.nl/assets/ui-audio
Retrieved mirror: https://github.com/Calinou/kenney-ui-audio
Pinned commit: 8c3d81b9159d058c444f89d12d518276b0b09345
Source paths: addons/kenney_ui_audio/switch13.wav and switch29.wav.
The mirror documents WAV conversion from the original Ogg Vorbis pack;
these are not verified lossless recording masters.

Source SHA-256:

- switch13.wav: 89f5746144f41a5dbf889d017ab549a6246922662321ddf25a76b4de69f7819c
- switch29.wav: 6403b4eeda8ee0eccbbc9c95d3e5de176126eb49754046678ecdb60991822750

License evidence (supplied LICENSE.txt):

> License (Creative Commons Zero, CC0)
> http://creativecommons.org/publicdomain/zero/1.0/
> You may use these assets in personal and commercial projects.
> Credit (Kenney or www.kenney.nl) would be nice but is not mandatory.

Retain source/license provenance. Optional credit: "Interface sounds adapted
from Kenney's UI SFX Set (CC0)." Attribution is not a CC0 condition.

## Processing and reproduction

All outputs are mono PCM16, 48,000 Hz. Existing toggle files are copied byte-for-byte
as toggle-on. All four PTT files are copied byte-for-byte from the cleared trio;
their SHA-256 values are unchanged.

New off cues use the SAME original source per family. SoX averages stereo to mono,
removes leading signal below -45 dB using a 0.1 ms detection period, trims trailing
near-silence below -60 dB using 1 ms detection, applies speed 1.08 (about +1.33
semitones and a shorter duration), resamples to 48 kHz, peak-normalizes to -9 dBFS,
and adds 2 ms leading/8 ms trailing silence. No synthetic samples, layering,
reverb or lossy export. The original on cue has no pitch shift and a -6 dBFS peak;
off is 3 dB quieter at its peak. Peak matching is not perceived loudness matching.

The retained PTT down uses speed .90 and -6 dBFS peak; retained PTT up uses 1.12
and -8 dBFS peak. All trim/downmix/resample/padding steps follow the prior script.

Reproduce with build-quartets.sh (three directory arguments): original Kenney
WAV directory, cleared trio directory, output directory. The earlier
build-families.sh reconstructs the trio inputs from the same original WAVs.
inspect-families.mjs accepts an output directory and reports format, duration,
peak, onset and SHA-256. SoX uses -D for deterministic output without dither.

## Verification and audition

All eight passed PCM format, nonzero signal and peak checks; onset above
-40 dBFS is 2.0–2.3 ms. Existing on/PTT bytes match the first clearance receipt.
Phone listening preference remains for the operator; no subjective listening or
device verification is claimed by this asset handoff. Preserve the existing
shared gain (70% is a useful starting point); do not independently renormalize
off at playback, since its quieter peak is intentional.

| Family | On | Off | PTT down | PTT up |
| --- | --- | --- | --- | --- |
| Rocker 13 | 44.021 ms | 41.500 ms | 47.792 ms | 40.375 ms |
| Rocker 29 | 201.292 ms | 187.125 ms | 222.542 ms | 180.792 ms |

On/off selection should follow the committed persistent mute assignment, not
transient PTT effective state. Retain existing accepted-hold PTT pairing and
cancellation behavior. Integration, studio persistence and device work belong
to green-river; this receipt changes assets only.

## Exact delivery hashes (SHA-256)

- rocker-13-toggle-on.wav: 6113827f2515b73692c1149caf7481e08e563be41e45af8751c4fac58508cef8
- rocker-13-toggle-off.wav: 522ba3bba3078eb0121ebb3431f9686f4d117801d5c538df214954f4b0b757f4
- rocker-13-ptt-down.wav: 54ca082e5f2759ac138061c90b6ecab213d72e14e44447300e8e170b4aaf4c72
- rocker-13-ptt-up.wav: 306255a30935286a798dc80bd086eb5fb0c3e259d5489f31491dee001aace18c
- rocker-29-toggle-on.wav: e6e4878c610ef7346dabc6e67f0b9940a34812fb7a45f88e87de913900b83fe0
- rocker-29-toggle-off.wav: b5efcf1ee1e9b6619998c958855033c364a0ba5e07bbf5f624b5c4d823efd2a2
- rocker-29-ptt-down.wav: 840ff7a4c9a19db132a8505728824cf2a9b44ea6072a227ac04ff47652a0fbc3
- rocker-29-ptt-up.wav: e67574bbc50bf2e2fb3853be4fc887bb31360fb068c2383927a016836f38e1ce
