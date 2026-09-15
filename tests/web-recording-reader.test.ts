import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TRANSCRIPT_BYTES, VoiceRecordingTail } from "../src/attachment/session.ts";

const roots: string[] = [];
function root() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "av-web-recording-test-")));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

const identity = { workspace: "/exact/workspace", threadId: "thread" };
const header = () =>
  JSON.stringify({
    type: "voice_transcript",
    format: "agentvoice",
    workspace: identity.workspace,
    threadId: identity.threadId,
  });

test("web transcript tail reads complete records and rejects unsafe replacement", () => {
  const directory = root();
  const path = join(directory, "voice.jsonl");
  writeFileSync(path, `${header()}\n`, { mode: 0o600 });
  const tail = new VoiceRecordingTail(path, identity);
  try {
    expect(tail.read()).toEqual([header()]);
    const record = Buffer.from('{"text":"雪"}\n');
    const split = record.indexOf(Buffer.from("雪")) + 1;
    appendFileSync(path, record.subarray(0, split));
    expect(tail.read()).toEqual([]);
    appendFileSync(path, record.subarray(split));
    expect(tail.read()).toEqual(['{"text":"雪"}']);
    truncateSync(path, 0);
    expect(() => tail.read()).toThrow("truncated");
  } finally {
    tail.close();
  }

  writeFileSync(path, `${header()}\n`, { mode: 0o600 });
  const replaced = new VoiceRecordingTail(path, identity);
  try {
    renameSync(path, `${path}.old`);
    writeFileSync(path, `${header()}\n`, { mode: 0o600 });
    expect(() => replaced.read()).toThrow("replaced");
  } finally {
    replaced.close();
  }
  chmodSync(path, 0o644);
  expect(() => new VoiceRecordingTail(path, identity)).toThrow("Unsafe");
});

test("web transcript tail enforces identity and size", () => {
  const path = join(root(), "voice.jsonl");
  writeFileSync(
    path,
    `${JSON.stringify({
      type: "voice_transcript",
      format: "agentvoice",
      workspace: identity.workspace,
      threadId: "foreign",
    })}\n`,
    { mode: 0o600 },
  );
  const foreign = new VoiceRecordingTail(path, identity);
  try {
    expect(() => foreign.read()).toThrow("identity");
  } finally {
    foreign.close();
  }

  writeFileSync(path, `${header()}\n`, { mode: 0o600 });
  truncateSync(path, MAX_TRANSCRIPT_BYTES + 1);
  const oversized = new VoiceRecordingTail(path, identity);
  try {
    expect(() => oversized.read()).toThrow("limit");
  } finally {
    oversized.close();
  }
});
