import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSpeechArgs, sendSpeech } from "../scripts/voice-speak.ts";
import { AttachmentGateway, type AttachmentTicket } from "../src/attachment/gateway.ts";
import { validateAttachmentRequest } from "../src/attachment/policy.ts";
import { resolveNativeExecutable } from "../src/core/native-listener.ts";

const identity = { threadId: "owned-thread", workspace: realpathSync(process.cwd()) };
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

async function opened(socket: WebSocket) {
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("socket failed")), { once: true });
  });
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

function fixture(rejectSpeech = false) {
  const calls: Record<string, unknown>[] = [];
  const peers = new Set<import("bun").ServerWebSocket<undefined>>();
  const nativeToken = "native-private";
  const native = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (request.headers.get("authorization") !== `Bearer ${nativeToken}`)
        return new Response("unauthorized", { status: 401 });
      if (!server.upgrade(request, { data: undefined }))
        return new Response("upgrade required", { status: 400 });
    },
    websocket: {
      open(peer) {
        peers.add(peer);
      },
      close(peer) {
        peers.delete(peer);
      },
      message(peer, text) {
        const frame = JSON.parse(String(text));
        calls.push(frame);
        if (frame.id === undefined) return;
        if (rejectSpeech && frame.method === "thread/realtime/appendSpeech") {
          peer.send(
            JSON.stringify({
              id: frame.id,
              error: { code: -32600, message: "conversation is not running" },
            }),
          );
          return;
        }
        peer.send(
          JSON.stringify({
            id: frame.id,
            result:
              frame.method === "turn/start"
                ? { turn: { id: "native-turn" }, diagnostic: nativeToken }
                : frame.method === "turn/steer"
                  ? { turnId: "native-turn" }
                  : {},
          }),
        );
      },
    },
  });
  const gateway = new AttachmentGateway({
    url: `ws://127.0.0.1:${native.port}`,
    token: nativeToken,
  });
  const close = () => {
    gateway.close();
    native.stop(true);
  };
  cleanup.push(close);
  return { calls, peers, gateway, close };
}

async function client(ticket: AttachmentTicket) {
  const headers = { Authorization: `Bearer ${ticket.token}` };
  const watch = new WebSocket(`${ticket.url}/watch`, { headers });
  await opened(watch);
  const socket = new WebSocket(ticket.url, { headers });
  const frames: Record<string, unknown>[] = [];
  socket.addEventListener("message", ({ data }) => frames.push(JSON.parse(String(data))));
  await opened(socket);
  socket.send(
    JSON.stringify({
      id: "initialize",
      method: "initialize",
      params: { clientInfo: { name: "test" }, capabilities: { experimentalApi: true } },
    }),
  );
  await until(() => frames.some((frame) => frame["id"] === "initialize"));
  socket.send(JSON.stringify({ method: "initialized", params: {} }));
  return { socket, watch, frames };
}

test("gateway policy exposes only web input and explicit speech on the exact root", () => {
  const allowed: Array<[string, Record<string, unknown>]> = [
    ["initialize", { clientInfo: { name: "test" } }],
    ["turn/start", { threadId: identity.threadId, input: [{ type: "text", text: "go" }] }],
    [
      "turn/steer",
      {
        threadId: identity.threadId,
        expectedTurnId: "turn",
        input: [{ type: "text", text: "now" }],
      },
    ],
    ["turn/interrupt", { threadId: identity.threadId, turnId: "turn" }],
    ["thread/realtime/appendSpeech", { threadId: identity.threadId, text: "hello" }],
  ];
  for (const [method, params] of allowed)
    expect(() => validateAttachmentRequest(method, params, identity)).not.toThrow();
  for (const [method, params] of [
    ["thread/read", { threadId: identity.threadId }],
    ["thread/settings/update", { threadId: identity.threadId }],
    ["turn/start", { threadId: "descendant", input: [{ type: "text", text: "no" }] }],
    ["turn/steer", { threadId: identity.threadId, expectedTurnId: "turn", input: [] }],
    [
      "turn/start",
      { threadId: identity.threadId, input: [{ type: "localImage", path: "/tmp/x" }] },
    ],
    [
      "turn/start",
      {
        threadId: identity.threadId,
        input: [{ type: "image", url: "data:image/png;base64,private" }],
      },
    ],
    [
      "turn/start",
      {
        threadId: identity.threadId,
        input: [{ type: "image", url: "https://remote.example/private.png" }],
      },
    ],
    ["thread/realtime/appendSpeech", { threadId: identity.threadId, text: " " }],
  ] as Array<[string, Record<string, unknown>]>) {
    expect(() => validateAttachmentRequest(method, params, identity)).toThrow();
  }
});

test("ticket is minimal and requires an authenticated watcher before one client", async () => {
  const f = fixture();
  const ticket = f.gateway.issue(identity);
  expect(ticket).toEqual({
    ...identity,
    url: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
    token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
  });
  expect(ticket).not.toHaveProperty("codex");
  const http = ticket.url.replace("ws:", "http:");
  expect((await fetch(http)).status).toBe(401);
  expect(
    (
      await fetch(http, {
        headers: { Authorization: `Bearer ${ticket.token}` },
      })
    ).status,
  ).toBe(409);

  const connected = await client(ticket);
  const duplicate = await fetch(http, {
    headers: { Authorization: `Bearer ${ticket.token}` },
  });
  expect(duplicate.status).toBe(409);
  connected.socket.close();
  connected.watch.close();
});

test("gateway forwards correlated root input, redacts native credentials and rejects read RPC", async () => {
  const f = fixture();
  const connected = await client(f.gateway.issue(identity));
  connected.socket.send(
    JSON.stringify({
      id: "turn",
      method: "turn/start",
      params: { threadId: identity.threadId, input: [{ type: "text", text: "work" }] },
    }),
  );
  await until(() => connected.frames.some((frame) => frame["id"] === "turn"));
  const turn = connected.frames.find((frame) => frame["id"] === "turn")!;
  expect(turn).toMatchObject({ result: { turn: { id: "native-turn" } } });
  expect(JSON.stringify(turn)).not.toContain("native-private");
  expect(JSON.stringify(turn)).toContain("[redacted]");

  const count = f.calls.length;
  connected.socket.send(
    JSON.stringify({
      id: "read",
      method: "thread/read",
      params: { threadId: identity.threadId },
    }),
  );
  await until(() => connected.frames.some((frame) => frame["id"] === "read"));
  expect(connected.frames.find((frame) => frame["id"] === "read")?.["error"]).toBeTruthy();
  expect(f.calls).toHaveLength(count);
  connected.socket.close();
  connected.watch.close();
});

test("revocation closes both peers and invalidates the token", async () => {
  const f = fixture();
  const ticket = f.gateway.issue(identity);
  const connected = await client(ticket);
  f.gateway.revoke();
  await until(
    () =>
      connected.socket.readyState === WebSocket.CLOSED &&
      connected.watch.readyState === WebSocket.CLOSED,
  );
  await until(() => f.peers.size === 0);
  expect(
    (
      await fetch(ticket.url.replace("ws:", "http:"), {
        headers: { Authorization: `Bearer ${ticket.token}` },
      })
    ).status,
  ).toBe(401);
});

test("speech CLI parses selection and uses the guarded connection once", async () => {
  expect(parseSpeechArgs(["Hello café 👋"]).text).toBe("Hello café 👋");
  expect(parseSpeechArgs(["--thread", "owned-thread", "--", "--hello"]).text).toBe("--hello");
  expect(() => parseSpeechArgs([])).toThrow("nonempty");
  expect(() => parseSpeechArgs(["--workspace"])).toThrow("Missing value");

  const f = fixture();
  await sendSpeech(f.gateway.issue(identity), "Hello café 👋");
  expect(f.calls.map((frame) => frame["method"])).toEqual([
    "initialize",
    "initialized",
    "thread/realtime/appendSpeech",
  ]);
});

test("speech rejection is surfaced without retry and native executable resolution remains shared", async () => {
  const f = fixture(true);
  await expect(sendSpeech(f.gateway.issue(identity), "Hello")).rejects.toThrow(
    "conversation is not running",
  );
  expect(
    f.calls.filter((frame) => frame["method"] === "thread/realtime/appendSpeech"),
  ).toHaveLength(1);

  const root = mkdtempSync(join(tmpdir(), "av-executable-"));
  try {
    symlinkSync(process.execPath, join(root, "codex"));
    expect(resolveNativeExecutable("./codex", root)).toBe(realpathSync(process.execPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
