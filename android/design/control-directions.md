# Debug control directions

The Halo remains the moving, expressive element. These initial synthetic native demos explored the controls beneath it; they did not select a production design. [ADR 0037](../../docs/adr/0037-host-persona-configurator.md) records the current narrowed choices and adjustable geometry.

## Tokens and layout

- Ground `#050607`; hardware surface `#101311`; edge `#343B33`; secondary ink `#90988F`; capture lime `#D4FF72`; playback violet `#BBAAFF`. Existing `VoiceInk.text` supplies high contrast neutral type.
- IBM Plex Mono throughout. Large operational words belong on the thumb surface; small channel names identify the hardware. The keyboard direction uses TX/RX as transmit/receive legends, with full accessible names.
- One fixed deck: two equal mute targets, a short microphone conduit, one full-width hold target. Every selection occupies the same bounds. All text and icon arrangements center optically within their own controls.

```text
Signal console             Field radio                Ghost terminal
[ MIC  /  SPEAKER ]         [ rocker ][ rocker ]        [ TX key ][ RX key ]
       |                          |                           |
[ ===== Push to talk ==== ] [ grip / Push to talk ]     [     talk key     ]
```

## Three pairings

| Direction | Mute ID | Hold ID | Character |
| --- | --- | --- | --- |
| Signal console | `glyphs` | `beam` | Filled, engraved pictograms on one split signal plate; a broad transmit bar. |
| Field radio | `rockers` | `trigger` | Two visibly tilted binary switches and a chamfered thumb trigger with tactile ribs. |
| Ghost terminal | `keycaps` | `keycap` | TX/RX keyboard caps with side walls and a deep full-width talk key. |

Any mute and hold choice can mix. The common palette, proportions, microphone conduit, and static target bounds make the combinations coherent.

## Critique before implementation

Three rounded cards recolored lime and violet would repeat a generic settings screen. Instead, each direction changes the control's physical construction: an engraved plate, a two-position rocker, or a raised keycap. Distinct mechanical geometry carries the difference; decorative meters, glows, and idle motion add no information and are omitted. The two channel glyphs are filled custom shapes with heavy mute cuts rather than familiar thin outlines enlarged three times.

Mute is a persistent switch. Hold is a momentary action; its text remains readable, and an unavailable surface explicitly explains that the microphone must be muted first. Pointer exit, cancellation, another finger, replacement, and disposal release an owned hold. TalkBack has explicit start/stop actions. Confirmed capture and an unconfirmed hold remain separate states.
