# 0067: Trial continuous muted Android input

Proposed trial, 2026-09-14; human authorized a candidate APK and will perform the phone test. Extends [0035](0035-native-android-voice-client.md). No server or speaker policy changes.

The pinned Android WebRTC fork stops ADM recording when all send streams are muted. Exact cached ARM64 disassembly confirms this branch and its enabled default. AgentVoice currently both zeros Java input and disables the local track on microphone mute. Recorded voice answers have appeared tens of seconds after working-agent output; the capture-stop behavior is established, but causality for these delays is unproven.

For the bounded trial, keep the active local track enabled while the existing Java ADM microphone mute supplies zero PCM. Pending peers and closed sessions remain disabled. Preserve speaker behavior. This avoids toggling recording for an ordinary mic preference change and leaves local capture active, which can retain Android's microphone indicator and consume capture resources.

The change is not accepted as a verified production fix until the [human trial](../../android/MIC-MUTE-TRIAL.md) and relevant media checks pass. Unit tests cover actual gate application, ordering and peer isolation; exact-dependency verification covers zeroing separately. Packet cadence under DTX, actual-device privacy, and shared-ADM renewal remain separate checks. Keep a pre-candidate APK for easy recovery. No synthetic agent wake or voice scheduling-mode change is part of this decision.
