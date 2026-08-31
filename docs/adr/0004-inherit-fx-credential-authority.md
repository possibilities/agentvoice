# Inherit Fx credential authority into Codpiece

Fx is the sole Codex subscription authority: it serves bounded runtime leases over one persistent length-prefixed channel, and AgentVoice passes the exact paused Fx pipe endpoint opaquely to Codpiece as inherited descriptor 3. Codpiece sets close-on-exec, fails closed without that channel, and has no local login, credential-store, ambient-key, or refresh-token fallback; this avoids both duplicate authorization and an AgentVoice credential relay.
