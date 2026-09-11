# Studio icon preview provenance

These local images support debug studio auditions only. They do not change
production channel defaults or installed launcher resources. Only filenames in
`src/icons.ts` are served; this note is a repository document, not a served asset.

## Phosphor Icons — MIT

The eight microphone, microphone-slash, speaker-high and speaker-slash SVGs
(`bold` and `fill`) preserve the official artwork from `@phosphor-icons/core`
revision `2b75f3ad12b420c9504ef05df8d2564a28f8500e`.

- Source: https://github.com/phosphor-icons/core/tree/2b75f3ad12b420c9504ef05df8d2564a28f8500e
- License: https://github.com/phosphor-icons/core/blob/2b75f3ad12b420c9504ef05df8d2564a28f8500e/LICENSE
- The full notice is retained in `PHOSPHOR-LICENSE.txt` and shipped locally.

The preserved upstream originals remain byte-identical in
`android/third-party/icons/phosphor/`. Browser copies add only accessible titles
and root image roles/labels. Their file hashes therefore intentionally differ;
tests compare the exact SVG after removing those metadata additions.

The browser uses a CSS paint filter for light monochrome previews. The SVG
source paths, weights and transparent regions remain unchanged. Noun Project artwork is documented separately below.

## Original project artwork

`current-*` reproduces the existing native mic/speaker/press geometry as SVG.
Muted slash clearance is transparent, and mic grille clearance uses SVG masks.
`launcher-current*` reproduces the current `ic_agentvoice.xml` path exactly,
with an additional transparent black monochrome comparison version. The current
production launcher is a vector resource; its masked/themed drawings here are
illustrative comparisons, not existing adaptive-icon resources.

`engraved-*` is original task artwork from the Codex-assisted AgentVoice design
team. The study was initially called Machined. Its coherent 24-unit family uses
2-unit strokes, butt caps and round joins. Muted variants cut out a transparent
clearance strip using opposite-winding contours compatible with both NonZero and
EvenOdd clipping. No background-colored erase paint is used.

`ptt-contact-monochrome.svg` is an original action glyph: cap, stem and fixed
contact. Its 48-unit geometry uses filled rectangles at (10,8,28,6), (20,14,8,16)
and (8,39,32,5). Match human channel uses the selected family's existing live human-channel icon.

Duplex Halo, Relay Aperture and Voice Carrier launcher concepts are original task
artwork from the same project design team. Color and monochrome source geometry
is identical; marks fit the central66-unit safe circle within the108-unit layer.
Adaptive comparison masks expose the central72 units, matching the designer's
handoff. The browser's monochrome tint is illustrative.

“Original” is an authorship/provenance tag, not a CC0 or other new license grant.
These original drawings use no third-party logo, Rive frame, Noun Project asset,
font outline or traced third-party path. Adoption of an audition remains a
separate product decision.


## Noun Project — CC BY 3.0

The Boatman pair uses Microphone by Edward Boatman (171) and Speaker by Edward
Boatman (100). The i cons pair uses Microphone by i cons (856601) and Volume by
i cons (974802), all from Noun Project under CC BY 3.0.

- https://thenounproject.com/icon/microphone-171/
- https://thenounproject.com/icon/speaker-100/
- https://thenounproject.com/icon/microphone-856601/
- https://thenounproject.com/icon/volume-974802/
- License: https://creativecommons.org/licenses/by/3.0/

The acquired originals, full terms, download evidence and complete credit notice
are retained in [the repository's Noun Project directory](../../../third-party/icons/noun-project/).
The studio uses normalized SVG derivatives: attribution text moved into visible
credits, artwork normalized and optically resized, channel colors applied, and
diagonal mute slashes added with transparent clearance. Revision3 additionally
clips three isolated lower wave fragments from the muted Boatman speaker; its
horn and upper waves remain unchanged. The other seven Noun SVGs remain identical
to revision2. Native VectorDrawable
conversion is part of the shared adaptation; these browser SVGs retain the same
normalized artwork. No creator endorsement is implied. The artwork remains
CC BY 3.0, separately from the application code license.


## Accessible standalone previews

Each served SVG has a nonempty title and an image role with either a readable
label or references to its existing title/description. Current, Engraved,
Phosphor and launcher/contact previews gained only these nonvisual metadata
additions. Their artwork, paint, geometry, clipping and viewBox remain unchanged.
Unserved designer verification exports are excluded from the preview directory.
Noun SVGs already carried valid title/description references and were unchanged;
their eight file hashes match normalization receipt revision3, including the
muted Boatman speaker correction described above.

## Human / Agent auditions

`participant-profile-*` are original Speaking profiles, with stable participant
silhouettes and voice arcs replaced by an audio-stop block when muted. Their
editable originals and generator live in `android/third-party/icons/participants-original/`.
`participant-bold-*` and `participant-fill-*` derive from the actual Phosphor
User/Robot MIT SVGs, with documented optical sizing and transparent mute
adaptations in `android/third-party/icons/phosphor-participants/`. The native
VectorDrawables and gallery previews are generated together. These are additional
Studio options, not an adopted production pair.
