# Landscape clearance refinement

The normal landscape Persona moves 7 dp toward the camera-side edge: horizontal
offset **−36 → −43 dp**. The approved upright portrait, both reverse layouts,
Persona sizes, animation settings, button spacing and control sizes are unchanged.
This uses the existing layout setting; it changes no renderer or inset logic.

The operator authorized collaborative refinement and production adoption after
the original profile was shipped at `fca1b9c`. A separate layout reviewer checked
the geometry, animation periods and all four native candidate screenshots.

## Physical-device evidence

Samsung SM-S901U / R5CT91TW4RP, density 3, native 1080×2340 portrait and
2340×1080 landscape. Android reports an 81 px camera cutout on the corresponding
physical edge, with no visible system-bar inset. The Persona remains on the left
in both landscapes; the reverse-landscape cutout is beside the controls instead.

Baseline recordings cover Thinking and Speaking for 12 seconds in each of the
four orientations. Candidate recordings repeat both states in the changed
landscape. The first second is excluded from analysis. The Thinking loop is
3.25 seconds; Speaking is approximately 0.833 seconds. Recordings therefore
cover several complete cycles, rather than comparing isolated poses.

The full-rate candidate analysis checks the camera corridor at y=500…579,
slightly wider than Android's y=512…567 cutout bounds:

| Moving edge | Baseline x | Adopted x | Clearance beyond x=81 |
| --- | ---: | ---: | ---: |
| Speaking, RGB channels >110 | 115 px | 94 px | 13 px |
| Thinking, RGB channels >110 | 107 px | 84 px | 3 px |
| Speaking, faint edge >40 | 103 px | 83 px | 2 px |
| Thinking, faint edge >40 | 106 px | 84 px | 3 px |

These are observed encoded-frame extrema, not mathematical bounds for every
possible frame or a measurement of the exact rounded camera hardware. Sampling
phase, antialiasing and compression explain small differences from the nominal
21 px translation. A more aggressive −45 dp candidate was rejected because it
would place the Thinking arc inside the reported cutout boundary.

Across the unchanged slots, baseline bright-edge minima were: upright portrait
Speaking 77 px / Thinking 89 px from the top; reverse portrait 42 / 53 px from
the top; reverse landscape 41 / 31 px from the left. Reverse slots have no
camera cutout at that Persona-side edge. The approved portrait remains intact.

## Adoption and preservation

The candidate is exported from the durable Studio working draft to a separate
scratch profile. All four live layouts are validated against that profile before
promotion. The only visual delta from the locked profile is the normal-landscape
offset. The draft export uses its existing `savedAtEpochMs: 1` sentinel; it does
not claim that an explicit Save occurred.

The adopted profile and exact source bytes/hash are retained in
`shipping-profile.json` and `shipping-provenance.json`. Studio intentionally
keeps the refined draft. The explicit phone checkpoint, original private host
profile, binding and their sidecar presence are preserved. No Save, Reset to
production, grant replacement or desktop service operation is part of this change.

Native rotation-transition artifacts are a separate capture investigation; this
offset refinement neither attributes nor claims to fix them.
