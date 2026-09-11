# Participant profile icons — original project artwork

These four SVGs are original AgentVoice artwork created for the Human and Agent
channel controls. They use no third-party icon, logo, font outline, Persona/Rive
frame, or traced geometry. They are covered by the repository license.

The pair shares a 24-unit canvas and 1.8-unit rounded stroke. The human microphone
uses a neutral speaking profile; the agent speaker uses a softly machined android
portrait. The identity drawing is identical between each live/muted pair. Live
audio adds two outward voice arcs. Muted audio replaces only those arcs with a
compact stop block at the same output position, so muting never crosses out or
fragments the participant.

The silhouettes are intentionally sparse enough for 24 px and 16 px indicators.
At large Rocker size, the profile, eye and android face details remain visible.

Regenerate the browser previews and debug Android VectorDrawables from these
checked-in originals:

```sh
python3 android/third-party/icons/participants-original/generate.py
```

The generator writes only the four `participant-profile-*.svg` browser previews
and four `preview_participant_profile_*.xml` debug resources named in the script.

