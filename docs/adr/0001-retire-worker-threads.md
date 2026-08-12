# 0001: Retire Worker threads after task settlement

AgentVoice archives every materialized or ambiguously-started Worker root after
its terminal notification, and deletes only roots whose first turn was
definitively rejected. Task outcome and Worker cleanup remain separate so
history and final output survive while retirement can retry until the Worker,
including its guardian and other runtime resources, has shut down.
