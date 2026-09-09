import { afterEach, expect, test } from "bun:test";
import type { PhoneState } from "../src/protocol.ts";
import { type PreviewConnection, ReconnectingPhone } from "../src/reconnecting-phone.ts";

const scales = { speaking: 78, listening: 58, idle: 78 };
const timing = { poll: 5, retry: 10, maxRetry: 20 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

class Connection implements PreviewConnection {
  connected = true;
  state: PhoneState = {
    protocol: 1,
    revision: 0,
    holding: false,
    mode: "listening",
    scales: { ...scales, listening: 52 },
    savedScales: { ...scales },
    defaults: { ...scales },
  };
  calls: Record<string, unknown>[] = [];
  close() {
    this.connected = false;
  }
  async request(command: Record<string, unknown>) {
    this.calls.push(command);
    if (!this.connected) throw Error("Disconnected");
    if (command["method"] === "save") {
      this.close();
      throw Error("Disconnected before save confirmation");
    }
    return { state: this.state };
  }
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error("Timed out waiting for reconnect");
    await Bun.sleep(5);
  }
}

test("reconnect retains last preview, retries failed dials, then observes fresh state", async () => {
  const initial = new Connection();
  const returned = new Connection();
  returned.state = { ...returned.state, mode: "idle", revision: 4 };
  let dials = 0;
  const phone = new ReconnectingPhone(
    initial,
    async () => {
      if (++dials < 3) throw Error("Device unavailable");
      return returned;
    },
    timing,
  );
  cleanups.push(() => phone.close());
  initial.close();
  expect(phone.connected).toBe(false);
  expect(phone.reconnecting).toBe(true);
  expect(phone.state.scales.listening).toBe(52);
  expect(phone.state.savedScales.listening).toBe(58);
  await until(() => phone.connected);
  expect(dials).toBe(3);
  expect(phone.generation).toBe(2);
  expect(phone.reconnecting).toBe(false);
  expect(phone.state.mode).toBe("idle");
  await until(() => returned.calls.length > 0);
  expect(returned.calls.every((call) => call["method"] === "get")).toBe(true);
});

test("an unconfirmed save fails once and is never replayed after reconnect", async () => {
  const initial = new Connection();
  const returned = new Connection();
  const phone = new ReconnectingPhone(initial, async () => returned, timing);
  cleanups.push(() => phone.close());
  await expect(phone.request({ method: "save", revision: 0 })).rejects.toThrow("confirmation");
  await expect(phone.request({ method: "preview" })).rejects.toThrow("disconnected");
  await until(() => phone.generation === 2 && returned.calls.length > 0);
  expect(initial.calls).toEqual([{ method: "save", revision: 0 }]);
  expect(returned.calls.every((call) => call["method"] === "get")).toBe(true);
});

test("shutdown aborts an in-progress dial and closes even a late successful candidate", async () => {
  const initial = new Connection();
  const candidate = new Connection();
  let finish!: (connection: Connection) => void;
  let signal: AbortSignal | undefined;
  let dials = 0;
  const phone = new ReconnectingPhone(
    initial,
    (nextSignal) => {
      dials++;
      signal = nextSignal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    timing,
  );
  initial.close();
  await until(() => signal !== undefined);
  const closed = phone.close();
  expect(signal?.aborted).toBe(true);
  finish(candidate);
  await closed;
  await Bun.sleep(30);
  expect(dials).toBe(1);
  expect(candidate.connected).toBe(false);
  expect(phone.connected).toBe(false);
  expect(phone.reconnecting).toBe(false);
  expect(phone.generation).toBe(1);
});
