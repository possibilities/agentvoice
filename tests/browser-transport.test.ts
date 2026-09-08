import { describe, expect, test } from "bun:test";
import {
  type BrowserReadyInfo,
  type BrowserTransportCommand,
  BrowserVoiceTransport,
} from "../src/console/browser-transport.ts";

const ready: BrowserReadyInfo = {
  threadId: "browser-thread",
  workspace: "/test",
  model: null,
  effort: null,
  conversationMode: "started",
  voiceVersion: null,
  prompts: [],
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function harness() {
  let nextId = 0;
  const commands: BrowserTransportCommand[] = [];
  const offers: string[] = [];
  const phases: string[] = [];
  const seenReady: BrowserReadyInfo[] = [];
  const errors: string[] = [];
  const debug: string[] = [];
  const transport = new BrowserVoiceTransport({
    signal: { offer: (sdp) => offers.push(sdp) },
    send: (command) => commands.push(command),
    onPhase: (phase) => phases.push(phase),
    onReady: (info) => seenReady.push(info),
    onInfo() {},
    onError: (line) => errors.push(line),
    debug: (line) => debug.push(line),
    createSessionId: () => `session-${++nextId}`,
    timings: {
      negotiationTimeoutMs: 80,
      retryMs: 10,
      renewalMs: 40,
      healthySessionMs: 30,
    },
  });
  const prepares = () =>
    commands.filter(
      (command): command is Extract<BrowserTransportCommand, { type: "prepare" }> =>
        command.type === "prepare",
    );
  return {
    transport,
    commands,
    offers,
    phases,
    seenReady,
    errors,
    debug,
    prepares,
  };
}

describe("browser-owned voice transport", () => {
  test("relays only the exact pending peer's offer and returns its answer", async () => {
    const h = harness();
    try {
      h.transport.handleReady(ready);
      expect(h.seenReady).toEqual([ready]);
      expect(h.phases).toEqual(["negotiating"]);
      expect(h.prepares()).toEqual([{ type: "prepare", sessionId: "session-1" }]);

      expect(h.transport.handleBrowserOffer("stale", "secret-stale-sdp")).toBe(false);
      expect(h.transport.handleBrowserConnected("stale")).toBe(false);
      expect(h.transport.handleBrowserFailed("stale", "ignored")).toBe(false);
      expect(h.transport.handleBrowserOffer("session-1", "secret-offer-sdp")).toBe(true);
      expect(h.transport.handleBrowserOffer("session-1", "duplicate-sdp")).toBe(false);
      expect(h.offers).toEqual(["secret-offer-sdp"]);

      await h.transport.handleAnswer("secret-answer-sdp");
      expect(h.commands.at(-1)).toEqual({
        type: "answer",
        sessionId: "session-1",
        sdp: "secret-answer-sdp",
      });
      expect(h.debug.join("\n")).not.toContain("secret-");
      expect(h.transport.handleBrowserConnected("session-1")).toBe(true);
      expect(h.transport.currentPhase).toBe("live");
    } finally {
      await h.transport.stop();
    }
  });

  test("retries after one second-equivalent, stops after three rapid failures, and manual redial recovers", async () => {
    const h = harness();
    try {
      h.transport.handleReady(ready);
      for (let attempt = 1; attempt <= 3; attempt++) {
        const id = `session-${attempt}`;
        expect(h.prepares()).toHaveLength(attempt);
        expect(h.transport.handleBrowserOffer(id, `offer-${attempt}`)).toBe(true);
        expect(h.transport.handleBrowserFailed(id, `failure-${attempt}`)).toBe(true);
        await delay(15);
      }
      expect(h.prepares()).toHaveLength(3);
      expect(h.transport.currentPhase).toBe("failed");
      expect(h.errors.at(-1)).toContain("retries paused");

      h.transport.redial("manual");
      expect(h.prepares().at(-1)?.sessionId).toBe("session-4");
    } finally {
      await h.transport.stop();
    }
  });

  test("renews a live session at 52-minute-equivalent and closes it only after promotion", async () => {
    const h = harness();
    try {
      h.transport.handleReady(ready);
      h.transport.handleBrowserOffer("session-1", "offer-1");
      h.transport.handleBrowserConnected("session-1");
      await delay(45);
      expect(h.prepares().at(-1)?.sessionId).toBe("session-2");
      expect(h.commands).not.toContainEqual({
        type: "close",
        sessionId: "session-1",
      });
      h.transport.handleBrowserOffer("session-2", "offer-2");
      h.transport.handleBrowserConnected("session-2");
      expect(h.commands).toContainEqual({
        type: "close",
        sessionId: "session-1",
      });
    } finally {
      await h.transport.stop();
    }
  });

  test("redial waiter follows its exact successor, rejecting failure, supersede and stop", async () => {
    const h = harness();
    try {
      h.transport.handleReady(ready);
      h.transport.handleBrowserOffer("session-1", "offer-1");
      h.transport.handleBrowserConnected("session-1");

      let result = "pending";
      const connected = h.transport.redialAndWait("control").then(() => {
        result = "connected";
      });
      await tick();
      expect(result).toBe("pending");
      expect(h.transport.handleBrowserConnected("session-1")).toBe(false);
      expect(result).toBe("pending");
      h.transport.handleBrowserOffer("session-2", "offer-2");
      h.transport.handleBrowserConnected("session-2");
      await connected;
      expect(result).toBe("connected");

      const failed = h.transport.redialAndWait("control").catch((error) => error.message);
      h.transport.handleBrowserFailed("session-3", "browser broke");
      expect(await failed).toContain("browser broke");

      const superseded = h.transport.redialAndWait("control").catch((error) => error.message);
      h.transport.redial("manual");
      expect(await superseded).toContain("superseded");

      const stopped = h.transport.redialAndWait("control").catch((error) => error.message);
      await h.transport.stop();
      expect(await stopped).toContain("stopped");
    } finally {
      await h.transport.stop();
    }
  });

  test("negotiation timeout closes the exact peer before retrying", async () => {
    const h = harness();
    try {
      h.transport.handleReady(ready);
      await delay(95);
      expect(h.commands).toContainEqual({
        type: "close",
        sessionId: "session-1",
      });
      expect(h.errors).toContain("voice negotiation timed out");
      expect(h.prepares().at(-1)?.sessionId).toBe("session-2");
    } finally {
      await h.transport.stop();
    }
  });
});
