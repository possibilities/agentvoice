import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { VoiceRecording } from "../scripts/voice-recording.ts";
import { EVENT_PROTOCOL_VERSION } from "../src/events/contract.ts";

const roots: string[] = [];
const recorders: VoiceRecording[] = [];
function setup() {
  const root = realpathSync(mkdtempSync("/tmp/voice-recording-"));
  roots.push(root);
  const recorder = new VoiceRecording(root, join(root, "out"));
  recorders.push(recorder);
  return { root, recorder, path: join(root, "out", "main.jsonl") };
}
afterEach(() => {
  for (const recorder of recorders.splice(0)) recorder.close("stopped");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function frame(event: string, fields: object, threadId = "main", generation = 1) {
  return {
    v: EVENT_PROTOCOL_VERSION,
    type: "event",
    event,
    data: { instanceId: "controller", generation, sequence: 7, threadId, ...fields },
  };
}
function item(text: string, realtimeSessionId = "call") {
  return {
    item: { id: "message", realtimeSessionId, type: "transcriptSegment", role: "user", text },
  };
}
function records(path: string) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("records native deltas and canonical text unchanged; Fresh separates files, redial appends", () => {
  const { root, recorder, path } = setup();
  const frames = [
    frame("voice.item.started", item("")),
    frame("voice.item.transcript.delta", { itemId: "message", delta: "Hi" }),
    frame("voice.item.completed", item("  Hi 雪  ")),
  ];
  for (const value of frames) recorder.accept(value);
  recorder.accept(frame("voice.item.completed", item("Next call", "redial")));
  recorder.accept(frame("voice.item.completed", item("Fresh"), "fresh"));
  recorder.close("disconnected");
  const saved = records(path);
  expect(saved[0]).toMatchObject({ type: "voice_transcript", workspace: root, threadId: "main" });
  expect(saved.slice(2, 5).map(({ observedAt: _, ...value }) => value)).toEqual(frames);
  expect(saved.at(-1)).toMatchObject({ type: "recording.ended", reason: "disconnected" });
  expect(records(join(root, "out", "fresh.jsonl"))[2].data.item.text).toBe("Fresh");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(root, "out")).mode & 0o777).toBe(0o700);
});

test("excludes promoted work and refuses non-voice records", () => {
  const { recorder, path } = setup();
  recorder.openThread("main");
  recorder.accept(
    frame("voice.item.completed", {
      item: {
        id: "work",
        realtimeSessionId: "call",
        type: "bemItemPromoted",
        turnId: "turn",
        itemId: "codex-item",
        presentation: { type: "wholeItem" },
      },
    }),
  );
  expect(() => recorder.accept(frame("conversation.item.completed", item("hidden")))).toThrow();
  recorder.close("stopped");
  expect(records(path).map((record) => record.type)).toEqual([
    "voice_transcript",
    "recording.started",
    "recording.ended",
  ]);
});

test("runtime changes and explicit gaps are durable", () => {
  const { recorder, path } = setup();
  recorder.accept(frame("voice.item.started", item("Partial")));
  recorder.accept(frame("voice.item.completed", item("Other"), "main", 2));
  recorder.gap("runtime_unavailable");
  recorder.close("error");
  expect(
    records(path)
      .filter((record) => record.type === "recording.gap")
      .map((record) => record.reason),
  ).toEqual(["runtime_replaced", "runtime_unavailable"]);
});

test("restart appends and crash recovery truncates only an unfinished suffix", () => {
  const { root, recorder, path } = setup();
  recorder.accept(frame("voice.item.completed", item("Keep me")));
  recorder.close("stopped");
  const prefix = readFileSync(path, "utf8");
  appendFileSync(path, '{"type":"event","partial":');
  const next = new VoiceRecording(root, join(root, "out"));
  recorders.push(next);
  next.accept(frame("voice.item.completed", item("New")));
  next.close("stopped");
  expect(readFileSync(path, "utf8").startsWith(prefix)).toBe(true);
  expect(records(path).filter((record) => record.type === "recording.gap")).toMatchObject([
    { reason: "unfinished_record_recovered" },
  ]);
});

test("one writer per directory and safe identity/private file checks", () => {
  const { root, recorder, path } = setup();
  expect(() => new VoiceRecording(root, join(root, "out"))).toThrow("Cannot lock");
  recorder.openThread("main");
  recorder.close("stopped");
  const next = new VoiceRecording("different-workspace", join(root, "out"));
  recorders.push(next);
  expect(() => next.openThread("main")).toThrow("identity mismatch");
  next.close("stopped");
  const third = new VoiceRecording(root, join(root, "out"));
  recorders.push(third);
  chmodSync(path, 0o644);
  expect(() => third.openThread("main")).toThrow("Unsafe recording");
  const outside = join(root, "outside");
  writeFileSync(outside, "untouched");
  symlinkSync(outside, join(root, "out", "linked.jsonl"));
  expect(() => third.openThread("linked")).toThrow();
  expect(readFileSync(outside, "utf8")).toBe("untouched");
});
