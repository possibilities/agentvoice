# Header directions

These alternatives exist only in the synthetic debug preview. The production
call screen is unchanged.

The Halo is the memorable element. The header supplies a place to reveal state
or leave; it does not compete with the Halo or invent connection statistics.
Use the existing palette: ground `#050607`, surface `#101311`, text `#F0F2E9`,
muted text `#90988F`, YOU `#D4FF72`, AGENT `#BBAAFF`. IBM Plex Mono remains the
only type family. Preview labels use 11sp; native target areas remain at least
48dp. Color follows the represented channel or Halo state.

| Choice | Collapsed treatment | Expanded treatment |
| --- | --- | --- |
| `quiet` | A 48dp rail with Preview, synthetic mode, a reveal chevron, and direct exit. Most of the rail is empty touch space. | Adds one compact row of microphone and speaker state; approximately 100dp total. |
| `drawer` | A small centered pull tab, 48dp high. | Reveals channel state, Keep open, and Exit preview; approximately 148dp total. |
| `none` | A floating Preview menu at the upper right. The Halo reserves no space for it. | Reveals synthetic mode, channel state, and Exit preview; approximately 148dp total. |

```text
quiet    Preview  Idle v                         x
drawer                 __
                    Preview v
none                                  (Preview ...)
```

Expanded content is aligned with the existing channel controls. A fake timer,
model name, latency, connection count, or tuning readout would make these headers
larger without supplying real call information. The host configurator owns tuning.

`PreviewHeader` takes parent-owned expansion state and reports the measured target
reservation. Its 280ms Compose disclosure follows Android's duration scale,
including disabled animations. The parent animates the Halo's center within the
uncovered region while keeping the Halo stage size and bottom controls fixed.
The floating menu's 48dp hit area does not become a permanent layout reservation.

Only `drawer` hides after inactivity. Its eight-second timer uses the accessibility
recommended timeout and runs only while resumed, connected in the synthetic
state, and free of messages, pending controls, holds, pointer activity, hover,
keyboard focus, or parent-reported interaction. Any enabled accessibility service
disables automatic hiding. Keep open is retained as local saved interaction state.
Revealing or hiding is always an explicit accessible action; Back collapses an
expanded header. Quiet retains a direct exit; Drawer and None expose exit after
one reveal.

Stable action tags are `preview-header-reveal`, `preview-header-exit`, and
`preview-header-pin`. Readable state is tagged `preview-header-mode`,
`preview-header-microphone`, and `preview-header-speaker`; the disclosed region is
`preview-header-details`. Each header root also carries its exact choice tag.
