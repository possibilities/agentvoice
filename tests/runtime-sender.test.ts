import { expect, test } from "bun:test";
import type { IpcMessage } from "../src/runtime-control/protocol.ts";
import { runtimeSender } from "../src/runtime-control/sender.ts";

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
    sender.send({ method: "voice", params: { delta: String(index) } });
  expect(sender.pending).toBe(16);
  for (let index = 16; index < 100; index++)
    sender.send({ method: "voice", params: { delta: String(index) } });
  sender.send({ method: "state", params: {} });
  expect(writes).toHaveLength(16);
  expect(failures).toBe(0);
  sender.send({ id: 1, result: "control still responds" });
  expect(sender.pending).toBe(17);
  expect(writes.at(-1)?.result).toBe("control still responds");
  for (const done of callbacks.splice(0)) done(null);
  expect(sender.pending).toBe(0);
  sender.send({ method: "voice", params: { delta: "next" } });
  expect(writes).toHaveLength(18);
  expect(writes.at(-1)).toMatchObject({ version: 1, generation: 7, params: { delta: "next" } });
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
