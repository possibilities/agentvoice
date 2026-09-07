# Speech fixtures

These two short files are locally synthesized system speech, not microphone
recordings. The lab analyzes their actual PCM; no speech model or service runs
at launch. Demo replay is silent. Both files are mono PCM16 at 24 kHz.

Generated on macOS using its default system voice:

```sh
say -r 170 --file-format=WAVE --data-format=LEI16@24000 -o you.wav 'Help me find a little more space in my day.'
say -r 165 --file-format=WAVE --data-format=LEI16@24000 -o agent.wav 'Let us start with one thing. What can wait until tomorrow?'
```

Silence and conversation-state cues are assembled by `demoSpeech()`; the
state timeline is authored demo data, never inferred from audio energy.
