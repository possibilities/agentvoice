# Design Studio icon auditions

These assets are debug-only comparisons, not adopted production defaults. The
channel pair changes together across Rockers and center indicators; PTT can keep
the current symbol, use the original Contact, or follow the selected microphone.
The installed launcher remains unchanged; its original alternatives appear only
in the browser gallery.

- **Current / Engraved / Contact / launcher studies**: original AgentVoice vector
  artwork, under the repository MIT license. Engraved uses a 24-unit canvas and
  two-unit strokes. Its mute clearance has opposing contour winding so Android
  Compose's NonZero clip parsing preserves transparency under uniform tint.
- **Phosphor Bold / Fill**: MIT, copyright 2023 Phosphor Icons. Eight unchanged
  upstream SVGs and hashes are in [phosphor](phosphor/receipt.json), pinned to
  `2b75f3ad12b420c9504ef05df8d2564a28f8500e`. Android copies preserve original
  path coordinates in a 256-unit viewport, tint white paths to the channel ink,
  and set intrinsic dimensions to 64 dp. [Full MIT terms](phosphor/LICENSE.txt).
- **Noun Project / Edward Boatman and i cons**: CC BY 3.0, separately from the
  app code license. [Acquisition](noun-project/acquisition.md), [exact credits and
  modifications](noun-project/NOTICE.txt), and [full terms](noun-project/CC-BY-3.0.txt)
  accompany the original files and sanitized license/download evidence.
  The license text is the SPDX CC-BY-3.0 transcription at
  https://github.com/spdx/license-list-data/blob/main/text/CC-BY-3.0.txt .

The studio exposes source/license links and **Credits on phone**. That action
opens accessible, selectable linked credits without adding a permanent header.
Notices are packaged in the debug APK. Moving credit text out of an icon is not
removing attribution: it remains in those credits and beside the source files.
No payment, attribution waiver or exclusive trademark right is claimed.

The screenshots used during discovery are evaluation references only. They were
not traced or bundled. All Noun integration geometry derives from the actual
SVG response to its authorized free download action.

To regenerate the Noun adaptations into a disposable directory, run
`python3 noun-project/normalize.py /absolute/output/directory` from this directory
with `rsvg-convert` and ImageMagick available. This uses the checked-in originals
and evidence; the receipt includes all source transforms and mute sample pixels.
The exported helper only changes its input/output path handling from the reviewed
scratch helper. It does not install anything or edit application resources.
