import { expect, test } from "bun:test";
import { BrowserMediaServer } from "../src/browser/server.ts";
import {
  clientMediaMessageSchema,
  serverMediaMessageSchema,
} from "../src/frontend/media-protocol.ts";

function openSocket(url: string, origin: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Origin: origin } });
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("websocket rejected")), { once: true });
  });
}

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), {
      once: true,
    });
    socket.addEventListener("close", () => reject(new Error("socket closed")), { once: true });
  });
}

function closed(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
}

const sessionId = "11111111-1111-4111-8111-111111111111";
const callbacks = {
  onOwnerOpen: () => {},
  onClientMessage: () => {},
  onOwnerClosed: () => {},
};

test("browser media serves only its capability path with restrictive browser policy", async () => {
  const server = new BrowserMediaServer({ token: "a".repeat(32), ...callbacks });
  server.start();
  try {
    const response = await fetch(server.url);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("permissions-policy")).toBe("microphone=(self), camera=()");
    const page = await response.text();
    expect(page).toContain("Start voice");
    expect(page).toContain('src="app.js"');

    const script = await fetch(`${server.url}app.js`).then((result) => result.text());
    expect(script).toContain("getUserMedia");
    expect(script).toContain("RTCPeerConnection");
    expect(script).toContain('createDataChannel("oai-events")');
    expect(script).toContain("ICE gathering timed out");
    expect(script).toContain("peer !== nextPeer || sessionId !== peerSessionId");
    expect(script.indexOf('addEventListener("click"')).toBeLessThan(script.indexOf("getUserMedia"));
    expect(script.indexOf("getUserMedia")).toBeLessThan(script.indexOf("connect();"));

    const hidden = new URL(server.url);
    hidden.pathname = "/wrong/";
    expect((await fetch(hidden)).status).toBe(404);
    expect((await fetch(server.url, { headers: { Host: "attacker.test" } })).status).toBe(421);
    expect(page).not.toContain(server.token);
  } finally {
    await server.close();
  }
});

test("browser media validates session-bound offer, answer, state and mute messages", () => {
  expect(clientMediaMessageSchema.parse({ type: "offer", sessionId, sdp: "v=0" })).toEqual({
    type: "offer",
    sessionId,
    sdp: "v=0",
  });
  expect(
    clientMediaMessageSchema.parse({
      type: "mute",
      sessionId,
      target: "mic",
      muted: true,
    }),
  ).toEqual({
    type: "mute",
    sessionId,
    target: "mic",
    muted: true,
  });
  expect(clientMediaMessageSchema.parse({ type: "connected", sessionId })).toEqual({
    type: "connected",
    sessionId,
  });
  expect(clientMediaMessageSchema.parse({ type: "hold", sessionId })).toEqual({
    type: "hold",
    sessionId,
  });
  expect(serverMediaMessageSchema.parse({ type: "answer", sessionId, sdp: "v=0" })).toEqual({
    type: "answer",
    sessionId,
    sdp: "v=0",
  });
  expect(() =>
    clientMediaMessageSchema.parse({
      type: "mute",
      sessionId,
      target: "mic",
      muted: true,
      token: "leak",
    }),
  ).toThrow();
  expect(() =>
    clientMediaMessageSchema.parse({ type: "offer", sessionId, sdp: "x".repeat(200_000) }),
  ).toThrow();
  expect(() =>
    serverMediaMessageSchema.parse({
      type: "state",
      sessionId: "not-a-session",
      mic: { muted: false, effectiveMuted: false },
      speaker: { muted: false, effectiveMuted: false },
    }),
  ).toThrow();
});

test("one authenticated browser owns signaling through cleanup", async () => {
  const seen: string[] = [];
  let releaseCleanup: (() => void) | undefined;
  const cleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const ownerClosed = Promise.withResolvers<void>();
  let server: BrowserMediaServer;
  server = new BrowserMediaServer({
    token: "b".repeat(32),
    onOwnerOpen: (owner) => {
      seen.push(`open:${owner.id}`);
    },
    onClientMessage: (message, owner) => {
      seen.push(`${message.type}:${owner.id}`);
    },
    onOwnerClosed: async () => {
      ownerClosed.resolve();
      await cleanup;
    },
  });
  server.start();
  const origin = new URL(server.url).origin;
  const wsUrl = `${server.url.replace("http:", "ws:")}ws`;
  let first: WebSocket | undefined;
  try {
    first = await openSocket(wsUrl, origin);
    await expect(openSocket(wsUrl, origin)).rejects.toThrow("rejected");
    const prepared = nextMessage(first);
    expect(server.send({ type: "prepare", sessionId })).toBe(true);
    expect(await prepared).toEqual({ type: "prepare", sessionId });
    first.send(JSON.stringify({ type: "connected", sessionId }));
    await Bun.sleep(5);
    expect(seen[0]).toMatch(/^open:[0-9a-f-]+$/);
    expect(seen[1]).toMatch(/^connected:[0-9a-f-]+$/);

    first.close();
    await ownerClosed.promise;
    await expect(openSocket(wsUrl, origin)).rejects.toThrow("rejected");
    releaseCleanup?.();
    await Bun.sleep(10);
    const successor = await openSocket(wsUrl, origin);
    successor.close();
  } finally {
    releaseCleanup?.();
    first?.close();
    await server.close();
  }
});

test("browser disconnect waits for owner startup before cleanup", async () => {
  const opening = Promise.withResolvers<void>();
  const opened = Promise.withResolvers<void>();
  const cleaned = Promise.withResolvers<void>();
  const order: string[] = [];
  const server = new BrowserMediaServer({
    token: "d".repeat(32),
    onOwnerOpen: async () => {
      order.push("opening");
      opened.resolve();
      await opening.promise;
      order.push("opened");
    },
    onClientMessage: () => {},
    onOwnerClosed: () => {
      order.push("closed");
      cleaned.resolve();
    },
  });
  server.start();
  const socket = await openSocket(
    `${server.url.replace("http:", "ws:")}ws`,
    new URL(server.url).origin,
  );
  try {
    await opened.promise;
    socket.close();
    await Bun.sleep(10);
    expect(order).toEqual(["opening"]);
    opening.resolve();
    await cleaned.promise;
    expect(order).toEqual(["opening", "opened", "closed"]);
  } finally {
    opening.resolve();
    socket.close();
    await server.close();
  }
});

test("server shutdown waits for owner startup and closes it exactly once", async () => {
  const opening = Promise.withResolvers<void>();
  const opened = Promise.withResolvers<void>();
  let closes = 0;
  const server = new BrowserMediaServer({
    token: "e".repeat(32),
    onOwnerOpen: async () => {
      opened.resolve();
      await opening.promise;
    },
    onClientMessage: () => {},
    onOwnerClosed: () => {
      closes++;
    },
  });
  server.start();
  const socket = await openSocket(
    `${server.url.replace("http:", "ws:")}ws`,
    new URL(server.url).origin,
  );
  try {
    await opened.promise;
    const shutdown = server.close();
    expect(server.close()).toBe(shutdown);
    await Bun.sleep(10);
    expect(closes).toBe(0);
    opening.resolve();
    await shutdown;
    await Bun.sleep(5);
    expect(closes).toBe(1);
  } finally {
    opening.resolve();
    socket.close();
    await server.close();
  }
});

test("browser media rejects wrong origins and closes schema-invalid owners", async () => {
  const server = new BrowserMediaServer({ token: "c".repeat(32), ...callbacks });
  server.start();
  const wsUrl = `${server.url.replace("http:", "ws:")}ws`;
  try {
    await expect(openSocket(wsUrl, "http://example.test")).rejects.toThrow("rejected");
    const socket = await openSocket(wsUrl, new URL(server.url).origin);
    const closing = closed(socket);
    socket.send(JSON.stringify({ type: "mute", muted: "yes" }));
    expect((await closing).code).toBe(1008);
  } finally {
    await server.close();
  }
});
