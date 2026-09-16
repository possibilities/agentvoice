# 0082: Let the kernel release service-operation locks

Accepted September 15, 2026 after an interrupted default-server lifecycle command
left the menu and CLI permanently blocked by an empty lock directory. Extends
[0065](0065-native-menu-server-lifecycle.md); the existing ownership checks,
single-operation rule, and explicit lifecycle actions remain.

## Decision

Serialize AgentVoice LaunchAgent installation, load, unload, restart, and removal
with an exclusive nonblocking `flock` on one retained private lock-file inode.
The owning process keeps the descriptor open for the complete mutation and closes
it in normal cleanup. Process exit, including `SIGKILL`, releases the kernel lock
without deleting the inode, so an interrupted menu or CLI command cannot strand
future lifecycle actions. The inode must be a single-link regular file owned by
the current user with mode `0600`; symlinks, hard links, other file types, other
owners, and changed permissions fail closed.

Do not unlink the lock file. A concurrent operation fails visibly and never waits
or retries. A directory at the historical lock path remains a legacy stale-lock
condition that requires the existing evidence-backed manual cleanup; the new code
does not guess that an unknown directory is safe to remove.

## Verification boundary

Tests hold the exact named lock from another process, prove concurrent refusal,
kill that owner, and reacquire the same inode. They also reject redirected,
non-regular, multiply linked, unowned, and incorrectly permissioned paths.
Service fixtures continue to prove that menu, CLI, and installer lifecycle
operations share one exclusion boundary, that the retained path is a file reusable
across sequential actions, and that a legacy directory is preserved until an
operator inspects and removes it before the first file-lock acquisition.
