import { expect, test } from "bun:test";
import type { IpcMessage } from "../src/runtime-control/protocol.ts";
import { runtimeSender } from "../src/runtime-control/sender.ts";

test("mailbox facts retain the reserved reliable lane while conversation observations are dropped", () => {
  const writes: IpcMessage[] = [];
  const callbacks: Array<(error: Error | null) => void> = [];
  const sender = runtimeSender({
    generation: 1,
    connected: () => true,
    write: (message, done) => {
      writes.push(message);
      callbacks.push(done);
    },
    failed: () => {
      throw new Error("unexpected transport failure");
    },
  });
  for (let revision = 1; revision <= 20; revision++)
    sender.send({ method: "conversation", params: { revision } });
  sender.send({
    method: "mailbox",
    params: { kind: "completed", completion: { turnId: "child-turn" } },
  });
  expect(writes).toHaveLength(17);
  expect(writes.at(-1)?.method).toBe("mailbox");
  while (callbacks.length) callbacks.shift()!(null);
});

test("voice pressure drops whole events at 16 writes, reserves control capacity, and never replays", () => {
  const writes: IpcMessage[] = [];
  const callbacks: Array<(error: Error | null) => void> = [];
  let failures = 0;
  const sender = runtimeSender({
    generation: 7,
    connected: () => true,
    write: (message, done) => {
      writes.push(message);
      callbacks.push(done);
    },
    failed: () => {
      failures++;
    },
  });
  for (let index = 0; index < 16; index++)
    sender.send({
      method: "voice",
      params: { event: "voice.item.transcript.delta", delta: String(index) },
    });
  expect(sender.pending).toBe(16);
  for (let index = 16; index < 100; index++)
    sender.send({
      method: "voice",
      params: { event: "voice.item.transcript.delta", delta: String(index) },
    });
  sender.send({ method: "state", params: {} });
  expect(writes).toHaveLength(16);
  expect(failures).toBe(0);
  sender.send({ id: 1, result: "control still responds" });
  expect(sender.pending).toBe(17);
  expect(writes.at(-1)?.result).toBe("control still responds");
  for (const done of callbacks.splice(0)) done(null);
  expect(sender.pending).toBe(0);
  sender.send({ method: "voice", params: { event: "voice.item.transcript.delta", delta: "next" } });
  expect(writes).toHaveLength(18);
  expect(writes.at(-1)).toMatchObject({
    version: 1,
    generation: 7,
    params: { event: "voice.item.transcript.delta", delta: "next" },
  });
  expect(writes.slice(0, 16).map((message) => (message.params as { delta: string }).delta)).toEqual(
    Array.from({ length: 16 }, (_, i) => String(i)),
  );
  callbacks[0]!(null);
  callbacks[0]!(null);
  expect(sender.pending).toBe(0);
  expect(failures).toBe(0);
});

test("runtime control retains its hard failure bound and write errors settle once", () => {
  let failures = 0;
  const sender = runtimeSender({
    generation: 1,
    connected: () => true,
    write() {},
    failed: () => {
      failures++;
    },
  });
  for (let id = 1; id <= 64; id++) sender.send({ id, result: null });
  expect(failures).toBe(0);
  sender.send({ id: 65, result: null });
  expect(failures).toBe(1);
  const broken = runtimeSender({
    generation: 1,
    connected: () => true,
    write(_message, done) {
      done(new Error("closed"));
      throw new Error("closed");
    },
    failed: () => {
      failures++;
    },
  });
  broken.send({ method: "voice" });
  expect(broken.pending).toBe(0);
  expect(failures).toBe(2);
});

test("a trailing dropped conversation produces a gap when IPC drains, even without another native event", () => {
  const writes: IpcMessage[] = [];
  const callbacks: Array<(error: Error | null) => void> = [];
  let failed = false;
  const sender = runtimeSender({
    generation: 1,
    connected: () => true,
    write: (message, done) => {
      writes.push(message);
      callbacks.push(done);
    },
    failed: () => {
      failed = true;
    },
  });
  const send = sender.send;
  for (let revision = 1; revision <= 20; revision++)
    send({ method: "conversation", params: { revision } });
  send({ id: 99, result: "control" });
  expect(writes).toHaveLength(17);
  callbacks.shift()!(null);
  callbacks.shift()!(null);
  expect(writes.at(-1)).toMatchObject({
    method: "conversation",
    params: { revision: 20, event: "conversation.gap", data: { reason: "backpressure" } },
  });
  while (callbacks.length) callbacks.shift()!(null);
  expect(sender.pending).toBe(0);
  expect(failed).toBe(false);
});

test("completed voice transcripts retain canonical text through soft backpressure", () => {
  const writes: IpcMessage[] = [];
  const sender = runtimeSender({
    generation: 1,
    connected: () => true,
    write: (message) => {
      writes.push(message);
    },
    failed: () => {
      throw new Error("unexpected failure");
    },
  });
  for (let i = 0; i < 16; i++) sender.send({ method: "state", params: {} });
  sender.send({
    method: "voice",
    params: { event: "voice.item.transcript.delta", data: { delta: "draft" } },
  });
  sender.send({
    method: "voice",
    params: { event: "voice.item.completed", data: { text: "canonical speech" } },
  });
  expect(writes).toHaveLength(17);
  expect(writes.at(-1)?.params).toEqual({
    event: "voice.item.completed",
    data: { text: "canonical speech" },
  });
});

test("shutdown drains queued transcript writes and reports an incomplete drain", async () => {
  let done: ((error: Error | null) => void) | undefined;
  const sender = runtimeSender({
    generation: 1,
    connected: () => true,
    write: (_, callback) => {
      done = callback;
    },
    failed: () => {},
  });
  sender.send({ method: "voice", params: { event: "voice.item.completed" } });
  await expect(sender.drain(1)).rejects.toThrow("did not drain");
  done!(null);
  await expect(sender.drain()).resolves.toBeUndefined();
});
