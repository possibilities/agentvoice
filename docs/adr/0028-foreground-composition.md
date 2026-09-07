# 0028: Bare command composes local terminal apps

Accepted 2026-09-07. Bare `agentvoice` now owns a foreground smolmux process with
three local-PTY apps; the former bare pointer frontend moves to `agentvoice client`.
A read-only frontend subscription correlates the spawned client and waits for
live media and exact workspace/thread before launching the two attachments, while
Companion persistence and automatic attachment replay remain excluded so closing
smolmux ends every pane and the call.
