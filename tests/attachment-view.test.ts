import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentTranscript, readAttachmentFrames } from "../src/attachment/bridge.ts";
import {
  type AttachmentFrame,
  type AttachmentIdentity,
  MAX_ATTACHMENT_FRAME,
  MAX_TRANSCRIPT_BYTES,
  streamAttachmentSession,
  VoiceRecordingTail,
} from "../src/attachment/session.ts";
import { attachmentSshArgv, shellQuote, validateSshHost } from "../src/attachment/ssh.ts";
import { startControlServer } from "../src/control/index.ts";
import {
  CONTROL_PROTOCOL_VERSION,
  type ControlBackend,
  type ControlStatus,
} from "../src/control/types.ts";
import { connectFrontend } from "../src/frontend/client.ts";
import { frontendSocketPath } from "../src/frontend/protocol.ts";
import { VoiceServer } from "../src/frontend/server.ts";
import { recordingDirectory } from "../src/recording/store.ts";
import { VoiceRecording } from "../src/recording/writer.ts";

const roots: string[] = [];
function root() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "av-view-test-")));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
async function until(predicate: () => boolean) {
  const end = Date.now() + 3000;
  while (!predicate() && Date.now() < end) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}
const identity: AttachmentIdentity = {
  clientId: randomUUID(),
  instanceId: "view-fixture",
  generation: 1,
  workspace: "/exact/workspace",
  threadId: "thread",
};
const header = (selected = identity) =>
  JSON.stringify({
    type: "voice_transcript",
    format: "agentvoice",
    workspace: selected.workspace,
    threadId: selected.threadId,
  });

test("SSH uses verified configured hosts and preserves hostile arguments as literal argv", () => {
  for (const host of [
    "-oProxyCommand=evil",
    "host;command",
    "host\n",
    "user@host $(touch pwn)",
    "",
    "foo/bar",
  ])
    expect(() => validateSshHost(host)).toThrow();
  expect(validateSshHost("user@smolbird")).toBe("user@smolbird");
  const argv = attachmentSshArgv(
    "smolbird",
    ["agentvoice", "__attach-bridge", "--workspace", "/a'b $(touch pwn) `hi`"],
    true,
  );
  expect(argv).toContain("StrictHostKeyChecking=yes");
  expect(argv).toContain("BatchMode=yes");
  expect(argv).toContain("ForwardAgent=no");
  expect(argv[1]).toBe("-tt");
  expect(argv.at(-1)).toBe(
    "exec 'agentvoice' '__attach-bridge' '--workspace' '/a'\\''b $(touch pwn) `hi`'",
  );
  expect(() => shellQuote("a\nb")).toThrow();
});

test("transcript tail waits for complete UTF-8 records and rejects replacement, truncation and unsafe files", () => {
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
  writeFileSync(path, `${header()}\n`);
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

test("transcripts enforce identity and size and remove only their private desktop copy", () => {
  const copy = new AttachmentTranscript();
  const path = copy.path;
  expect(statSync(copy.directory).mode & 0o777).toBe(0o700);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  try {
    expect(() => copy.append(header({ ...identity, threadId: "foreign" }), identity)).toThrow(
      "identity",
    );
    copy.append(header(), identity);
    copy.append('{"text":"hello"}', identity);
    expect(readFileSync(path, "utf8")).toContain("hello");
    expect(() => copy.append("x".repeat(1024 * 1024), identity)).toThrow("limit");
    expect(() => copy.append("null", identity)).toThrow("Invalid");
  } finally {
    copy.close();
  }
  expect(existsSync(path)).toBe(false);
  const source = join(root(), "voice.jsonl");
  writeFileSync(source, `${header()}\n`, { mode: 0o600 });
  truncateSync(source, MAX_TRANSCRIPT_BYTES + 1);
  const tail = new VoiceRecordingTail(source, identity);
  try {
    expect(() => tail.read()).toThrow("limit");
  } finally {
    tail.close();
  }
});

test("bridge frames handle split UTF-8 and reject truncated, oversized, malformed and stalled streams", async () => {
  const session: AttachmentFrame = {
    v: 1,
    type: "session",
    identity,
    phase: "starting",
    agentReady: true,
  };
  const voice: AttachmentFrame = { v: 1, type: "voice", line: '{"text":"雪"}' };
  const bytes = Buffer.from(`${JSON.stringify(session)}\n${JSON.stringify(voice)}\n`);
  const frames: AttachmentFrame[] = [];
  const streamed = (chunks: Uint8Array[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  await readAttachmentFrames(
    streamed([...bytes].map((byte) => Uint8Array.of(byte))),
    async (frame) => {
      frames.push(frame);
    },
    new AbortController().signal,
  );
  expect(frames).toEqual([session, voice]);
  for (const [input, message] of [
    [Buffer.from('{"v":1'), "mid-frame"],
    [Buffer.from("x".repeat(MAX_ATTACHMENT_FRAME + 1)), "limit"],
    [Buffer.from('{"v":1,"type":"voice","line":"hi","token":"secret"}\n'), "Invalid"],
    [Buffer.from([0xff, 10]), "Invalid"],
  ] as const) {
    await expect(
      readAttachmentFrames(streamed([input]), async () => {}, new AbortController().signal),
    ).rejects.toThrow(message);
  }
  let cancelled = false;
  await expect(
    readAttachmentFrames(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      async () => {},
      new AbortController().signal,
      20,
    ),
  ).rejects.toThrow("timed out");
  expect(cancelled).toBe(true);
});

async function harness() {
  const stateDir = root();
  const workspace = root();
  const selected = { ...identity, workspace };
  let starts = 0;
  let closes = 0;
  const inputs: string[] = [];
  const status: ControlStatus = {
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    instanceId: selected.instanceId,
    workspace,
    threadId: selected.threadId,
    generation: 1,
    runtime: { phase: "starting", attachmentReady: true },
    recentOperations: [],
  };
  const forbidden = async (): Promise<never> => {
    throw new Error("Observation cannot mutate");
  };
  const backend: ControlBackend = {
    status: () => status,
    redial: forbidden,
    restart: forbidden,
    mailboxOpen: forbidden,
    voiceSet: forbidden,
  };
  const control = await startControlServer({ stateDir, instanceId: selected.instanceId, backend });
  const writer = new VoiceRecording(workspace, recordingDirectory(stateDir, workspace));
  writer.openThread(selected.threadId);
  const server = new VoiceServer(frontendSocketPath(stateDir), async () => {
    starts++;
    return {
      identity: () => ({ workspace, threadId: selected.threadId }),
      state: () => ({
        available: true,
        codingActivity: "unknown" as const,
        phase: "negotiating",
        mic: { muted: true, effectiveMuted: true },
        speaker: { muted: false, effectiveMuted: true },
      }),
      start: async () => {},
      command: (input) => {
        inputs.push(input.action);
      },
      close: async () => {
        closes++;
      },
    };
  });
  await server.start();
  return {
    stateDir,
    workspace,
    selected,
    status,
    control,
    server,
    starts: () => starts,
    closes: () => closes,
    inputs,
    close: async () => {
      await server.close();
      writer.close("stopped");
      await control.close();
    },
  };
}

test("view waits without owning a call, follows pre-media identity, and disconnect leaves the mobile owner alive", async () => {
  const h = await harness();
  const abort = new AbortController();
  const frames: AttachmentFrame[] = [];
  const stream = streamAttachmentSession(
    h.stateDir,
    h.workspace,
    async (frame) => {
      frames.push(frame);
    },
    abort.signal,
  );
  let client: Awaited<ReturnType<typeof connectFrontend>> | undefined;
  try {
    await until(() => frames.some((frame) => frame.type === "waiting"));
    expect(h.starts()).toBe(0);
    client = await connectFrontend(h.server.path, () => {}, identity.clientId);
    await until(() => frames.some((frame) => frame.type === "voice"));
    expect(frames.find((frame) => frame.type === "session")).toMatchObject({
      identity: h.selected,
      agentReady: true,
      phase: "starting",
    });
    const serialized = JSON.stringify(frames);
    expect(serialized).not.toContain(h.control.bearerToken);
    expect(serialized).not.toContain(h.control.socketPath);
    abort.abort();
    await stream;
    expect(h.starts()).toBe(1);
    expect(h.closes()).toBe(0);
    expect(h.inputs).toEqual([]);
  } finally {
    abort.abort();
    await stream.catch(() => {});
    await client?.close();
    await h.close();
  }
});

test.each(["generation", "call"])(
  "view ends on %s change and never follows a successor",
  async (change) => {
    const h = await harness();
    const abort = new AbortController();
    let client = await connectFrontend(h.server.path, () => {}, identity.clientId);
    const frames: AttachmentFrame[] = [];
    const result = streamAttachmentSession(
      h.stateDir,
      undefined,
      async (frame) => {
        frames.push(frame);
      },
      abort.signal,
    ).catch((error: Error) => error);
    try {
      await until(() => frames.some((frame) => frame.type === "voice"));
      if (change === "generation") h.status.generation++;
      else await client.close();
      const end = await result;
      if (change === "generation") expect((end as Error).message).toContain("Backend changed");
      else {
        expect(end).toBeUndefined();
        client = await connectFrontend(h.server.path);
      }
      expect(
        frames
          .filter((frame) => frame.type === "session")
          .every(
            (frame) =>
              frame.identity.generation === 1 && frame.identity.clientId === identity.clientId,
          ),
      ).toBe(true);
    } finally {
      abort.abort();
      await result;
      await client.close();
      await h.close();
    }
  },
);
