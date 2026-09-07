import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { VoiceMessagePresence } from "../src/composition/messages.ts";

const roots: string[] = [];
const readers: VoiceMessagePresence[] = [];
function setup(events: object[] = []) {
  const root = realpathSync(mkdtempSync("/tmp/voice-presence-"));
  roots.push(root);
  const path = join(root, "thread.jsonl");
  writeFileSync(
    path,
    [
      { type: "voice_transcript", format: "agentvoice", workspace: root, threadId: "thread" },
      { type: "recording.started" },
      ...events,
    ]
      .map((event) => `${JSON.stringify(event)}\n`)
      .join(""),
    { mode: 0o600 },
  );
  const reader = new VoiceMessagePresence(path, root, "thread");
  readers.push(reader);
  return { reader, path, root };
}
function event(name: string, text: string, id = "message", generation = 1) {
  return {
    v: 2,
    type: "event",
    event: name,
    observedAt: new Date().toISOString(),
    data: {
      instanceId: "fixture",
      generation,
      sequence: 1,
      threadId: "thread",
      ...(name === "voice.item.transcript.delta"
        ? { itemId: id, delta: text }
        : {
            item: {
              id,
              realtimeSessionId: "session",
              type: "transcriptSegment",
              role: "user",
              text,
            },
          }),
    },
  };
}
function append(path: string, value: object) {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}
afterEach(() => {
  for (const reader of readers.splice(0)) reader.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("empty recordings wait for nonempty known-speaker text, including split UTF-8", () => {
  const { reader, path } = setup();
  expect(reader.hasMessages()).toBe(false);
  append(path, event("voice.item.completed", "  "));
  append(path, event("voice.item.transcript.delta", "unknown", "other"));
  append(path, event("voice.item.started", ""));
  expect(reader.hasMessages()).toBe(false);
  const line = Buffer.from(`${JSON.stringify(event("voice.item.transcript.delta", "雪"))}\n`);
  const split = line.indexOf(Buffer.from("雪")) + 1;
  appendFileSync(path, line.subarray(0, split));
  expect(reader.hasMessages()).toBe(false);
  appendFileSync(path, line.subarray(split));
  expect(reader.hasMessages()).toBe(true);
  reader.close();
  expect(reader.hasMessages()).toBe(true);
});

test("saved user or assistant messages are visible immediately", () => {
  for (const role of ["user", "assistant"]) {
    const record = event("voice.item.completed", "Saved text");
    if ("item" in record.data) record.data.item.role = role;
    const { reader } = setup([record]);
    expect(reader.hasMessages()).toBe(true);
  }
});

test("gaps, completions and new producer generations fence later deltas", () => {
  const { reader, path } = setup([event("voice.item.started", "")]);
  expect(reader.hasMessages()).toBe(false);
  append(path, { type: "recording.gap", reason: "redial" });
  append(path, event("voice.item.transcript.delta", "stale"));
  append(path, event("voice.item.started", "", "message", 2));
  append(path, event("voice.item.transcript.delta", "foreign generation"));
  expect(reader.hasMessages()).toBe(false);
  append(path, event("voice.item.completed", "", "message", 2));
  append(path, event("voice.item.transcript.delta", "late", "message", 2));
  expect(reader.hasMessages()).toBe(false);
  append(path, event("voice.item.completed", "Canonical", "message", 2));
  expect(reader.hasMessages()).toBe(true);
});

test("refuses unsafe, foreign and replaced recordings", () => {
  const { reader, path, root } = setup();
  expect(reader.hasMessages()).toBe(false);
  chmodSync(path, 0o644);
  expect(() => new VoiceMessagePresence(path, root, "thread")).toThrow("Unsafe");
  chmodSync(path, 0o600);
  const foreign = new VoiceMessagePresence(path, root, "foreign");
  readers.push(foreign);
  expect(() => foreign.hasMessages()).toThrow("identity");
  const replacement = join(root, "replacement");
  writeFileSync(replacement, "{}\n", { mode: 0o600 });
  renameSync(replacement, path);
  expect(() => reader.hasMessages()).toThrow("changed");
});

test("oversized unfinished records fail boundedly and closed readers stop polling", () => {
  const { reader, path } = setup();
  appendFileSync(path, "x".repeat((1 << 20) + 1));
  expect(() => reader.hasMessages()).toThrow("1 MiB");
  reader.close();
  expect(reader.hasMessages()).toBe(false);
});
