# A microphone identity for the LaunchAgent

Status review 2026-09-08: partially superseded.
[0033](0033-client-owned-native-media.md) moves microphone use to the client. The installer-owned signed runtime, stable permission identity and operator-owned consent remain.

macOS TCC denied the directly launched Homebrew Bun service microphone access
because the hardened executable lacked audio-input entitlement, suppressing the
permission prompt while CoreAudio appeared live. The installer therefore owns a
signed AgentVoice.app copy of Bun with its original runtime entitlements, explicit
microphone entitlement and usage description, and stable local designated identity;
it never modifies shared Bun or grants privacy permission. Bundle verification and
rollback are part of service installation/restart, while microphone consent stays
with macOS and the operator.
