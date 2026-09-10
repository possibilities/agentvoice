# AgentVoice Noun Project original SVG acquisition

Completed 2026-09-10 UTC. Four original site-supplied SVGs obtained via each exact icon's **Continue With Attribution → Download SVG** route. Each live page explicitly displayed **CC BY-3.0 Attribution License**. No payment, subscription, or unrelated account change. No app/repo/device edits.

## Files and SHA-256

| File in originals/ | Creator / source | SHA-256 |
|---|---|---|
| boatman-microphone-171.svg | [Microphone — Edward Boatman](https://thenounproject.com/icon/microphone-171/) | dc612abee5d0cf9df7e40f2a1620bb9d443f120a2ee8e578c6c063f395363b62 |
| boatman-speaker-100.svg | [Speaker — Edward Boatman](https://thenounproject.com/icon/speaker-100/) | 7447d13c6fdece5b8678e68a819bb97a21382876d53e2a5dc4ecc355c7cfc5c4 |
| icons-microphone-856601.svg | [Microphone — i cons](https://thenounproject.com/icon/microphone-856601/) | 58f3cb6eedc2c620d59da664fef7ecdece9c260900a6ebcb901feb91eae5fdc7 |
| icons-volume-974802.svg | [Volume — i cons](https://thenounproject.com/icon/volume-974802/) | f2a6d452bbb6c2d65cceb85867adbe5f96139a0da9e1c2564a739b69c76be0db |

All paths are under `/tmp/agentvoice-noun-assets/`. All four parse as SVG XML. **No geometry edits or conversions were performed.** Original files contain embedded creator/Noun Project text and extra viewBox space for those credits. Preserve these originals. Make separate integration copies if moving credits to accessible About/Credits; document text removal, viewBox normalization, recoloring, and any slash/knockout modifications. Do not scale the complete attribution-inclusive viewBox as though it were only the glyph.

## Attribution to package and display

- Microphone by Edward Boatman from Noun Project (CC BY 3.0).
- Speaker by Edward Boatman from Noun Project (CC BY 3.0).
- Microphone by i cons from Noun Project (CC BY 3.0).
- Volume by i cons from Noun Project (CC BY 3.0).

Link titles to the exact source URLs in the table and the license phrase to https://creativecommons.org/licenses/by/3.0/. The site's medium-specific FAQ requests linking “Noun Project” to the corresponding term browse page: `/browse/icons/term/microphone/`, `/speaker/`, or `/volume/`. Include the creator names exactly as shown; “i cons” is intentional. Keep these assets under CC BY 3.0, excluded from a blanket app-code license. Add a notice of your actual modifications; do not imply creator endorsement.

## Evidence and download recovery

`evidence/*-download.json` records per-file UI download response request ID, HTTP status/date, icon ID, creator, export parameters, byte count, hash and recovery method. `evidence/*-license-page.txt` records live license-page text. Source legal references:

- https://thenounproject.com/legal/terms-of-use/#icon-licenses
- https://help.thenounproject.com/hc/en-us/articles/200509798-What-licenses-do-you-offer-for-icons
- https://help.thenounproject.com/hc/en-us/articles/200509948-Medium-Specific-Credit-Requirements-Examples
- https://creativecommons.org/licenses/by/3.0/
- https://creativecommons.org/licenses/by/3.0/legalcode

Agent-browser's file-saving command reported “Download was canceled,” but the site's downloadIcon response was HTTP 200 / ok=true and contained the actual original SVG as base64Stream. Recovery decoded that exact response using the driver's read-only network request inspection. No new endpoint was guessed or replayed, no cookies were exported, no preview paths were traced, and no premium/license gate was bypassed. The helper script documents this extraction; it reads only captured downloadIcon responses for the four approved IDs and writes sanitized evidence without browser credentials.

The earlier discovery receipt's “no assets acquired” status is now superseded by this acquisition receipt. Discovery/rationale remains at `/tmp/agentvoice-noun-icon-receipt.md`; screenshots remain evaluation-only.
