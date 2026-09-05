# 0011: Continue the spoken conversation

2026-09-05. Supersedes ADR 0008's no-replay/startup-context policy and extends
ADR 0010's quiet-only reconnect behavior. The operator approved saved-speech
restoration, native Recent Work as an opt-in, and an independent replay opt-out.

## Evidence

The operator's test created a fresh working thread, spoke a correction from a
home-directory request to a workspace-directory request, then restarted voice.
The saved working-agent answer listed the home directory; the actual saved speech
listed workspace files. On reconnect, the voice answered a recall question from
the working-agent answer instead of the last words spoken. The quiet-resume
instruction prevented unsolicited startup speech in that trace but did not
restore the missing speech context.

A subsequent fresh thread had no Current Thread startup section, yet received
old directory requests through native Recent Work and described them as the
previous conversation. Thread identity was new; the startup snapshot crossed
conversation boundaries. Stock 0.153.4's relevant realtime/context sources are
unchanged from 0.153.3. These are two distinct gaps in the frontend's behavior.

## Decisions

- Default launch and explicit `--continue` select and resume eligible native
  working-thread history in the exact workspace. `--no-continue` creates fresh.
- `voice.include-startup-context` defaults false on every call. Explicit true
  opts into the whole native snapshot (Recent Work, current working-thread
  context and a machine/workspace map); raw null restores native resolution.
  Codex has no separate native Recent Work switch. User config files are not edited.
- `voice.replay-spoken-history` is an AgentVoice setting, default true. Continue,
  explicit resume and redial restore recent saved user/assistant speech from that
  selected thread through native v3 initialItems. It is history context, never
  a submitted new user request, synthetic work turn or automatic speaker playback.
  False skips both history reads and replay while preserving working-thread
  continuation. It does not disable native startup context or quiet-resume.
- Keep `voice.quiet-resume` independent. With replay, its developer instruction
  shares one initial item with the description of the historical speech. Explicit
  initial items (including seed files, []/null) own startup behavior and replace
  both automatic policies. Non-v3/alternate transport overrides stay unchanged.
- Keep the native voice base prompt and tail-flush behavior. Do not add summaries,
  skills, account policy, a transcript database, or writes/migration to native history.

## Native history contract

Prefer `thread/timeline/list`: newest page first, entries in chronological rollout
order within each page, nextCursor toward older entries. Extract realtime
transcriptSegment entries, excluding working-agent messages and tool results.

An isolated stock 0.153.4 probe found that legacy threads return -32601 for this
method. On that specific refusal, call thread/read for the selected ID, verify
workspace/main-thread ownership again, and read the returned flat local JSONL
rollout. Verify its filename and metadata identity, refuse symlinks/nonfiles, and
extract only native realtime_item transcript_segment records. Ignore a final
incomplete record; never infer its contents. No directory scan or independent
session index is used. Other native errors remain errors.

The fallback supports local flat JSONL; compressed/shared/forked history requires
native timeline support. A detected rollback or malformed record refuses replay.
The file format/path is an unstable compatibility surface, documented rather than
hidden as native API parity. See stock
[timeline implementation](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/thread-store/src/local/thread_history/realtime.rs)
and [realtime records](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/protocol/src/realtime.rs).

Retain a contiguous recent tail of at most 64 segments / 24,000 UTF-8 bytes,
leaving room under native v3's initial-item limits. Do not replace an oversized
last segment with older speech. Timeline reads are bounded to 32 pages of 256;
the fallback reads the last 8 MiB and validates metadata within the first 1 MiB.
Truncation is visible. Read failures visibly fail voice startup with an explicit
replay opt-out, rather than silently connecting without the promised context.
Fresh/quit/newer offers invalidate pending reads before a native start can occur.

## Validation and limits

`scripts/voice-history-probe.ts` creates a synthetic rollout in a disposable
CODEX_HOME, denies network with macOS sandbox-exec, and verifies exact speech
restoration through the stock history contract. No turns, login, microphone or
speaker are used. Tests cover speech/work-text divergence, both settings, native
pagination, fallback identity checks, broken history and obsolete-offer races.

Live acceptance remains: speak, finish an answer, restart, hear no unsolicited
recap, and ask for the last spoken filename or reply. Test Fresh separately: no
old speech or Recent Work unless explicitly configured. Test replay=false with
and without startup context. Saved transcripts do not prove which audio was heard;
unsaved/in-flight speech at kill or redial cannot be restored, and the model can
still fail to follow guidance or recall correctly.
