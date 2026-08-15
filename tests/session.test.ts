import { describe, expect, test } from "bun:test";
import { type VoiceSessionEffects, VoiceSessionManager } from "../src/core/session.ts";

interface Call {
  kind: "answer" | "closed" | "failed" | "ready" | "start" | "stop";
  detail?: string;
}

function harness(options?: {
  startTimeoutMs?: number;
  startRejects?: boolean;
  stopRejects?: boolean;
}) {
  const calls: Call[] = [];
  const startIds: string[] = [];
  const effects: VoiceSessionEffects = {
    sendAnswer: (sdp) => calls.push({ kind: "answer", detail: sdp }),
    sendClosed: (reason) => calls.push({ kind: "closed", detail: reason }),
    sendFailed: (message) => calls.push({ kind: "failed", detail: message }),
    sendReady: () => calls.push({ kind: "ready" }),
    startRealtime: (id, sdp) => {
      calls.push({ kind: "start", detail: sdp });
      startIds.push(id);
      return options?.startRejects
        ? Promise.reject(new Error("start rejected"))
        : Promise.resolve();
    },
    stopRealtime: () => {
      calls.push({ kind: "stop" });
      return options?.stopRejects ? Promise.reject(new Error("stop rejected")) : Promise.resolve();
    },
  };
  const manager = new VoiceSessionManager(effects, options?.startTimeoutMs ?? 60_000);
  const kinds = () => calls.map((call) => call.kind);
  return { manager, calls, startIds, kinds };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("offer → answer", () => {
  test("relays the answer once the session has started", () => {
    const { manager, calls, startIds } = harness();
    manager.handleOffer("offer-sdp");
    expect(calls).toEqual([{ kind: "start", detail: "offer-sdp" }]);
    manager.handleNotification("thread/realtime/started", {
      realtimeSessionId: startIds[0],
    });
    manager.handleNotification("thread/realtime/sdp", { sdp: "answer-sdp" });
    expect(calls.at(-1)).toEqual({ kind: "answer", detail: "answer-sdp" });
  });

  test("drops an answer that arrives before started", () => {
    const { manager, kinds } = harness();
    manager.handleOffer("offer-sdp");
    manager.handleNotification("thread/realtime/sdp", { sdp: "stale" });
    expect(kinds()).toEqual(["start"]);
  });
});

describe("renewal supersedes without a stop", () => {
  test("a second offer never issues a stop and ignores the stale start", () => {
    const { manager, calls, startIds, kinds } = harness();
    manager.handleOffer("offer-1");
    manager.handleOffer("offer-2");
    expect(kinds()).toEqual(["start", "start"]);

    // The superseded start comes up late, answer and all: both are ignored.
    manager.handleNotification("thread/realtime/started", {
      realtimeSessionId: startIds[0],
    });
    manager.handleNotification("thread/realtime/sdp", { sdp: "stale-answer" });
    expect(kinds()).toEqual(["start", "start"]);

    manager.handleNotification("thread/realtime/started", {
      realtimeSessionId: startIds[1],
    });
    manager.handleNotification("thread/realtime/sdp", { sdp: "fresh-answer" });
    expect(calls.at(-1)).toEqual({ kind: "answer", detail: "fresh-answer" });
  });
});

describe("closed attribution", () => {
  test("closed(requested) after our stop is consumed silently", () => {
    const { manager, startIds, kinds } = harness();
    manager.handleOffer("offer-1");
    manager.handleNotification("thread/realtime/started", {
      realtimeSessionId: startIds[0],
    });
    manager.handleClientGone();
    expect(kinds()).toEqual(["start", "stop"]);
    manager.handleNotification("thread/realtime/closed", { reason: "requested" });
    expect(kinds()).toEqual(["start", "stop"]); // consumed, not forwarded
  });

  test("a natural close is forwarded and reopens offers", () => {
    const { manager, calls, startIds } = harness();
    manager.handleOffer("offer-1");
    manager.handleNotification("thread/realtime/started", {
      realtimeSessionId: startIds[0],
    });
    manager.handleNotification("thread/realtime/closed", { reason: "transport_closed" });
    expect(calls.slice(1)).toEqual([
      { kind: "closed", detail: "transport_closed" },
      { kind: "ready" },
    ]);
    expect(manager.hasSession).toBe(false);
  });

  test("closed with no session is ignored", () => {
    const { manager, kinds } = harness();
    manager.handleNotification("thread/realtime/closed", { reason: "transport_closed" });
    expect(kinds()).toEqual([]);
  });
});

describe("errors", () => {
  test("an error fails the session and the trailing closed(error) is ignored", () => {
    const { manager, calls, startIds } = harness();
    manager.handleOffer("offer-1");
    manager.handleNotification("thread/realtime/started", {
      realtimeSessionId: startIds[0],
    });
    manager.handleNotification("thread/realtime/error", { message: "upstream broke" });
    expect(calls.slice(1)).toEqual([
      { kind: "failed", detail: "upstream broke" },
      { kind: "ready" },
    ]);
    manager.handleNotification("thread/realtime/closed", { reason: "error" });
    expect(calls.length).toBe(3); // nothing further
  });

  test("a rejected start RPC fails the session and issues an ordered stop", async () => {
    const { manager, kinds } = harness({ startRejects: true });
    manager.handleOffer("offer-1");
    await tick();
    expect(kinds()).toEqual(["start", "stop", "failed", "ready"]);
    // The stop's unconditional closed(requested) is consumed, not forwarded.
    manager.handleNotification("thread/realtime/closed", { reason: "requested" });
    expect(kinds()).toEqual(["start", "stop", "failed", "ready"]);
  });

  test("start timeout fails the session and issues an ordered stop", async () => {
    const { manager, kinds } = harness({ startTimeoutMs: 5 });
    manager.handleOffer("offer-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(kinds()).toEqual(["start", "stop", "failed", "ready"]);
  });

  test("a rejected stop RPC releases its pending close", async () => {
    const { manager, calls, startIds } = harness({ stopRejects: true });
    manager.handleOffer("offer-1");
    manager.handleNotification("thread/realtime/started", {
      realtimeSessionId: startIds[0],
    });
    manager.handleClientGone();
    await tick();
    // Next session's genuine requested-close is NOT eaten by the failed stop.
    manager.handleOffer("offer-2");
    manager.handleNotification("thread/realtime/started", {
      realtimeSessionId: startIds[1],
    });
    manager.handleNotification("thread/realtime/closed", { reason: "requested" });
    expect(calls.at(-2)?.kind).toBe("closed");
    expect(calls.at(-1)?.kind).toBe("ready");
  });
});

describe("reset", () => {
  test("clears the session and pending closes without stopping", () => {
    const { manager, startIds, kinds } = harness();
    manager.handleOffer("offer-1");
    manager.handleNotification("thread/realtime/started", {
      realtimeSessionId: startIds[0],
    });
    manager.handleClientGone(); // one pending requested close
    manager.reset(); // app-server died; the close will never arrive
    manager.handleOffer("offer-2");
    manager.handleNotification("thread/realtime/started", {
      realtimeSessionId: startIds[1],
    });
    // A requested close now must belong to a live stop, not the stale one.
    manager.handleNotification("thread/realtime/closed", { reason: "requested" });
    expect(kinds().filter((kind) => kind === "closed")).toEqual(["closed"]);
  });
});
