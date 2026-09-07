# A microphone identity for the LaunchAgent

macOS TCC denied the directly launched Homebrew Bun service microphone access
because the hardened executable lacked audio-input entitlement, suppressing the
permission prompt while CoreAudio appeared live. The installer therefore owns a
signed AgentVoice.app copy of Bun with its original runtime entitlements, explicit
microphone entitlement and usage description, and stable local designated identity;
it never modifies shared Bun or grants privacy permission. Bundle verification and
rollback are part of service installation/restart, while microphone consent stays
with macOS and the operator.
