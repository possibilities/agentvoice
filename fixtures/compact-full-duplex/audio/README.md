# Input voice fixture

`tts.json` records the exact paid request used to render these four selected,
hash-locked files from the transcripts in `scenario.json`:

- `01-diagnose.wav`
- `02-implement.wav`
- `03-steer.wav`
- `04-verify.wav`

It uses OpenAI `gpt-4o-mini-tts` with the recommended high-quality `marin`
voice and a shared speech-style instruction, giving every turn one natural,
consistent speaker. Render it with:

```bash
bun run render:fixture -- fixtures/compact-full-duplex/audio/tts.json
```

The renderer requires `OPENAI_API_KEY` only when an utterance actually needs a
paid request. It validates and reuses fingerprinted outputs, checkpoints each
successful response atomically, and resumes after a partial failure. To
intentionally purchase a replacement, name exactly one utterance—for example,
`--replace steer`; there is no blanket overwrite switch. `rendered.json` binds
the exact text and audio hashes returned by the provider. The WAVs and receipt
are committed so normal evals need no TTS credentials and always use the same
bytes; a stochastic re-render is an intentional fixture replacement.

Source encoding is unrestricted: the harness uses `ffmpeg` to normalize every
file to 48 kHz mono signed 16-bit PCM before the run. Do not add artificial
leading or trailing silence; the continuous WebRTC uplink supplies silence
between scripted actions.

Every run verifies the receipt and source hashes before opening a realtime
session, then records the source and normalized PCM hashes in its manifest.
