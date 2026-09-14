# 0069: Observe directory role content by runtime generation

Accepted 2026-09-14 for role freshness inspection. Extends
[0014](0014-roles.md) and [0015](0015-retain-controller-replace-runtime.md), preserving
[0042](0042-workspace-role-databases.md) and
[0053](0053-retain-workspace-session-across-frontend-detach.md).

Control status adds optional `directoryRole` for unejected directory roles. The
runtime candidate records resolved prompt and MCP buffers as their existing
readers load them, and observes the initial skills tree during preflight. The
controller retains that observation with the successfully activated generation.
Status recomputes the current source observation read-only and reports equality
or an unavailable observation. It never reloads the runtime or changes settings.
Redial and frontend reattachment retain the loaded observation; a successful
runtime replacement adopts its candidate's new observation. A failed replacement
may leave the previous successful generation's observation in status, explicitly
identified by `loaded.generation`.

The loaded observation attests preflight inputs, not proof of every native read.
Directory skills still use the existing live `skills/extraRoots/set` path; native
watchers or later skill reads can observe edits after preflight. We deliberately
retain that behavior instead of introducing a new directory snapshot policy.
Traversal is not an atomic filesystem snapshot. Source edits during traversal or
between preflight and activation can produce a mixed observation. Prompt/MCP
hashes use the exact original buffers decoded by their loaders, not a later read.

`agentvoice-role-content-v1` hashes UTF-8 JSON framing with SHA-256. Entries use
logical relative paths, sorted by JavaScript string comparison. File entries
have ordered keys `{path,kind:"file",hash}`; `hash` is SHA-256 of the resolved raw
bytes. Skill files additionally have `executable` (any execute bit). Skills
include directory entries `{path,kind:"directory"}`, including the root and empty
directories. Symlink target paths and timestamps are excluded; resolved bytes and
skill executable flags participate. The framing is
`JSON.stringify(["agentvoice-role-content-v1", entries])`.

The combined digest includes the two general role prompt names, seven
AgentVoice prompt/mode names, `mcp.json`, and the skills tree. General files read
before a voice-specific override still participate. Component digests filter the
same ordered entries into prompts, MCP and skills; unrelated role root files are
excluded. Empty and missing files differ. Source traversal limits are 4096 total
entries, 32 MiB of file bytes and 64 directory levels; cycles and unsupported
skill asset types fail. These bounds also apply to directory preflight capture.

Status exposes only source kind/path, generation, digest strings, equality and a
fixed error. It never returns file lists, prompt/MCP bodies, commands, arguments,
environment values, symlink targets or filesystem exception text. The configured
role path is intentionally visible. Hashes are content fingerprints, not secret
storage or authentication proofs. Desired means current contents at that loaded
source path; it does not reread config to discover a changed role selector or
validate edited MCP/prompt semantics. There is no background watcher.

Database-backed roles retain their existing immutable loaded/desired revision
contract and omit `directoryRole`; even projected directories are not source
inputs. Config-directory-only launches also omit it. Protocol 7 and the existing
`role` shape remain unchanged; consumers should tolerate the optional new status
field. Fake-native tests establish observation/lifecycle behavior, not live
native skill-consumption or audible behavior.
