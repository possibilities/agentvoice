# 0005: Project Codex history without loading threads

Chats builds its Codex transcript from `thread/read` with `includeTurns:true`
and merges Frame envelopes already crossing AgentVoice's owning App-server
connection while that read is in flight. It never resumes or subscribes to a
thread, so historical inspection cannot change App-server retention; the raw
item on every projection and the alternate Frames view preserve protocol data
when the semantic renderer is incomplete or Codex evolves.

Voice Sessions remain outside this projection and Frames-only because realtime
control observations are live, unpersisted, and semantically different from a
Codex thread's durable turn/item history.
