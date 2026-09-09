# Android voice control exploration

Explore an oversized voice instrument with less writing and more tactile form.
The existing native Persona Halo remains the expressive centerpiece. This demo
kept the production UI and compiled placement defaults unchanged. These are the
initial directions; [ADR 0041](../../docs/adr/0041-host-persona-configurator.md)
records the current narrowed controls and headerless layout.

| Preset | Header | Mutes | Hold | Intent |
| --- | --- | --- | --- | --- |
| Signal | `quiet` | `glyphs` | `beam` | Calm, clear channel controls with one broad thumb surface. |
| Field radio | `drawer` | `rockers` | `trigger` | A physical communication tool: retract the panel and hold the trigger. |
| Ghost terminal | `none` | `keycaps` | `keycap` | Give Halo the screen; mechanical forms carry the terminal character. |

Capture uses the existing lime and playback the existing violet. Off states
remain recognizable through a slash, shape or position; color never carries the
whole distinction. Large icons can replace repeated explanations, while accessible
names retain microphone, speaker and push-to-talk meaning.
Persistent mute and temporary capture are distinct: a hold may light the capture
path, but it must not flip the microphone's binary mute detent. Large-font
instructions should wrap or shorten inside the fixed target instead of clipping
their action or moving the deck.

Header disclosure and Halo recentering form one deliberate transition, around
280 ms without overshoot. Mute and hold targets stay anchored. A hidden header
has an explicit, reachable reveal control; the PTT gesture never doubles as a
menu gesture. Reduced motion snaps, and an active press cannot be displaced by
auto-hide. Connection failure must remain visible without hunting for chrome.

Watch for false volume affordances on rockers, fake keyboard shortcuts on
keycaps, competing glow around every control, unreadably dim muted icons,
accidental End call adjacency, and PTT that stays latched after cancellation.
Use at least 48 dp equivalent touch targets with clear separation. Keep short
visible hold instructions and an explicit accessible start/stop alternative.

Research anchors:

- [ADR 0035](../../docs/adr/0035-native-android-voice-client.md): one voice
  instrument, native Halo, semantic audio colors, stable PTT and a separate
  preview boundary.
- [AgentVoice Android — Persona Halo](/Users/arthack/wiki/agentvoice-android-the-voice-filament.md):
  Halo is the single theatrical gesture; controls remain on the foreground layer.
- [Signal Room](/Users/arthack/wiki/arthack-tui-design-language-signal-room.md):
  show the instrument, quiet until active, color is signal, and meaning survives
  without color. Its literal terminal palette and shell are not native UI rules.
- [Core stance](/Users/arthack/resources/design-with-ai/docs/01-core-stance.md):
  subtraction, generous space, structure and theatrical pacing.
- [Design taste](/Users/arthack/resources/design-with-ai/docs/02-design-taste-skill.md):
  establish coherent foundations and critique every element's purpose.
- [Arthack north star](/Users/arthack/resources/design-with-ai/docs/09-arthack-north-star.md):
  mechanical keyboards, monospace, old glowing terminals and hidden energy.
- [Chuchu Apps](/Users/arthack/wiki/chuchu-app-profiles.md):
  touch-first fullscreen with recoverable hidden chrome. Its global long press
  is not transferred here because holding already means talk.
