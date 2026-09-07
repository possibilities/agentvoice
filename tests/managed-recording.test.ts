import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { attachmentSelection, parseAttachCommand } from "../src/attachment/command.ts";
import { voiceViewerArgv } from "../src/attachment/voice-launcher.ts";
import { LifecycleFeed } from "../src/events/feed.ts";
import { discoverServer } from "../src/frontend/discovery.ts";
import { frontendSocketPath } from "../src/frontend/protocol.ts";
import { VoiceServer } from "../src/frontend/server.ts";
import { recordCall } from "../src/recording/call.ts";
import { recordingDirectory, savedRecordings } from "../src/recording/store.ts";
import { VoiceRecording } from "../src/recording/writer.ts";
import { currentWorkspace } from "../src/workspace.ts";

const roots: string[] = [];
const cleanup: Array<() => void | Promise<void>> = [];
function root() {
  const value = realpathSync(mkdtempSync("/tmp/managed-voice-"));
  roots.push(value);
  return value;
}
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function content(path: string) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
const complete = (threadId: string, text: string) => ({
  event: "voice.item.completed" as const,
  data: {
    threadId,
    item: {
      type: "transcriptSegment" as const,
      id: "speech",
      realtimeSessionId: "session",
      role: "user" as const,
      text,
    },
  },
});

test("controller recorder starts on verified identity, survives runtime replacement and saves shutdown speech", () => {
  const state = root();
  const workspace = root();
  const feed = new LifecycleFeed("call");
  const notices: string[] = [];
  const recorder = recordCall(feed, state, (value) => notices.push(value));
  cleanup.push(() => recorder.close());
  feed.runtime(1, { workspace, mainThreadId: "thread", phase: "starting" });
  feed.voice(complete("thread", "first"));
  feed.runtime(2, { workspace, mainThreadId: "thread", phase: "ready" });
  feed.voice(complete("thread", "after restart"));
  feed.runtime(2, { workspace, mainThreadId: "thread", phase: "stopping" });
  feed.voice(complete("thread", "last"));
  recorder.close();
  const saved = savedRecordings(state, workspace);
  expect(saved).toHaveLength(1);
  expect(saved[0]?.interrupted).toBe(false);
  const rows = content(saved[0]!.path);
  expect(rows.filter((row) => row.type === "event").map((row) => row.data.item.text)).toEqual([
    "first",
    "after restart",
    "last",
  ]);
  expect(rows.some((row) => row.reason === "runtime_replaced")).toBe(true);
  expect(notices).toEqual([]);
  expect(savedRecordings(state, root())).toEqual([]);
});

test("foreign voice identity fails visibly without writing foreign content", () => {
  const state = root();
  const workspace = root();
  const feed = new LifecycleFeed("call");
  const notices: string[] = [];
  const recorder = recordCall(feed, state, (value) => notices.push(value));
  cleanup.push(() => recorder.close());
  feed.runtime(1, { workspace, mainThreadId: "thread", phase: "ready" });
  feed.voice(complete("foreign", "secret"));
  expect(notices).toHaveLength(1);
  expect(savedRecordings(state, workspace)).toHaveLength(1);
  expect(readFileSync(savedRecordings(state, workspace)[0]!.path, "utf8")).not.toContain("secret");
});

test("disk failure is reported without throwing through the feed", () => {
  const state = root();
  const workspace = root();
  const directory = recordingDirectory(state, workspace);
  const writer = new VoiceRecording(workspace, directory);
  writer.openThread("thread");
  writer.close("stopped");
  chmodSync(join(directory, "thread.jsonl"), 0o644);
  const feed = new LifecycleFeed("call");
  const notices: string[] = [];
  const recorder = recordCall(feed, state, (value) => notices.push(value));
  cleanup.push(() => recorder.close());
  expect(() =>
    feed.runtime(1, { workspace, mainThreadId: "thread", phase: "ready" }),
  ).not.toThrow();
  expect(notices[0]).toContain("transcript is incomplete");
});

test("saved history detects interruption on a complete newline and on a partial tail", () => {
  const state = root();
  const workspace = root();
  const directory = recordingDirectory(state, workspace);
  const writer = new VoiceRecording(workspace, directory);
  writer.openThread("thread");
  writer.close("stopped");
  const path = join(directory, "thread.jsonl");
  appendFileSync(path, '{"type":"recording.started"}\n');
  expect(savedRecordings(state, workspace)[0]?.interrupted).toBe(true);
  const next = new VoiceRecording(workspace, directory);
  next.openThread("thread");
  next.close("stopped");
  expect(content(path).some((row) => row.reason === "previous_recording_interrupted")).toBe(true);
  appendFileSync(path, '{"partial":');
  expect(savedRecordings(state, workspace)[0]?.interrupted).toBe(true);
});

test("attachment discovers idle server workspace without starting a call", async () => {
  const state = root();
  const workspace = root();
  let starts = 0;
  const server = new VoiceServer(
    frontendSocketPath(state),
    async () => {
      starts++;
      throw new Error("must not start");
    },
    () => {},
    () => workspace,
  );
  await server.start();
  cleanup.push(() => server.close());
  expect(await discoverServer(state)).toEqual({ busy: false, workspace, threadId: null });
  expect((await attachmentSelection(state)).workspace).toBe(workspace);
  expect(starts).toBe(0);
});

test("attach grammar is explicit and viewer argv preserves a literal file path", () => {
  expect(() => parseAttachCommand([])).toThrow("attach agent");
  expect(() => parseAttachCommand(["agent", "--list"])).toThrow();
  expect(parseAttachCommand(["voice", "--list"]).list).toBe(true);
  expect(() => parseAttachCommand(["voice", "--list", "--thread", "t"])).toThrow();
  expect(voiceViewerArgv("/tmp/a b.jsonl")).toEqual([
    "codex-viewer",
    "--voice-jsonl",
    "/tmp/a b.jsonl",
    "--follow",
  ]);
  expect(() => currentWorkspace(root(), false)).toThrow("No default workspace");
});

test("recording discovery rejects a FIFO without waiting for a writer", () => {
  const state = root();
  const workspace = root();
  const directory = recordingDirectory(state, workspace);
  const writer = new VoiceRecording(workspace, directory);
  writer.close("stopped");
  execFileSync("mkfifo", [join(directory, "pipe.jsonl")]);
  expect(() => savedRecordings(state, workspace)).toThrow("Unsafe voice recording");
});
