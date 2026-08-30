# Input voice fixture

Render these four files from the exact transcripts in `scenario.json`:

- `01-diagnose.wav`
- `02-implement.wav`
- `03-steer.wav`
- `04-verify.wav`

The final fixture should use one natural, consistent speaker from a
high-quality paid TTS provider. Source encoding is unrestricted: the harness
uses `ffmpeg` to normalize every file to 48 kHz mono signed 16-bit PCM before
the run. Do not add artificial leading or trailing silence; the continuous
WebRTC uplink supplies silence between scripted actions.

Generated audio is ignored by Git so provider changes do not masquerade as
harness changes. Every run's manifest and input recording preserve the exact
bytes actually evaluated.
