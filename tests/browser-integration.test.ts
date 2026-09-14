import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBrowserFrontend } from "../src/browser/frontend.ts";
import { connectFrontend } from "../src/frontend/client.ts";
import type { ClientMediaMessage, ServerMediaMessage } from "../src/frontend/media-protocol.ts";
import type { FrontendState } from "../src/frontend/protocol.ts";
import { frontendSocketPath } from "../src/frontend/protocol.ts";
import { type Call, VoiceServer } from "../src/frontend/server.ts";
import { parseArgs } from "../src/main.ts";
import { RuntimeController } from "../src/runtime-control/controller.ts";

async function until(predicate: () => boolean, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${url.replace("http:", "ws:")}ws`, {
      headers: { Origin: new URL(url).origin },
    });
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("websocket rejected")), {
      once: true,
    });
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

test("browser WebSocket relays media, detaches on disconnect, and reuses its backend", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-browser-integration-"));
  const received: ClientMediaMessage[] = [];
  let sendRuntime: ((message: ServerMediaMessage) => void) | undefined;
  let creates = 0;
  let starts = 0;
  let closes = 0;
  const attachments: boolean[] = [];
  const state: FrontendState = {
    available: true,
    codingActivity: "unknown" as const,
    phase: "live",
    mic: { muted: true, effectiveMuted: true },
    speaker: { muted: false, effectiveMuted: false },
  };
  const server = new VoiceServer(frontendSocketPath(root), async (_changed, params, sendMedia) => {
    expect(params?.clientId).toBeString();
    sendRuntime = sendMedia;
    creates++;
    return {
      state: () => state,
      start: async () => {
        starts++;
      },
      command() {},
      clientMedia: (message) => received.push(message),
      setFrontendAttached: async (attached) => {
        attachments.push(attached);
      },
      close: async () => {
        closes++;
      },
    } satisfies Call;
  });
  let socket: WebSocket | undefined;
  let browser: Promise<void> | undefined;
  const abort = new AbortController();
  try {
    await server.start();
    browser = runBrowserFrontend(undefined, {
      stateDir: root,
      signal: abort.signal,
      write() {},
      open: async (url) => {
        socket = await openSocket(url);
      },
    });
    await until(() => starts === 1 && socket?.readyState === WebSocket.OPEN);

    const sessionId = "11111111-1111-4111-8111-111111111111";
    const prepared = nextMessage(socket!);
    sendRuntime?.({ type: "prepare", sessionId });
    expect(await prepared).toEqual({ type: "prepare", sessionId });
    socket!.send(JSON.stringify({ type: "connected", sessionId }));
    await until(() => received.length === 1);
    expect(received).toEqual([{ type: "connected", sessionId }]);

    socket!.close();
    await until(() => attachments.at(-1) === false);
    expect({ creates, starts, closes, attachments }).toEqual({
      creates: 1,
      starts: 1,
      closes: 0,
      attachments: [true, false],
    });
    abort.abort();
    await browser;
    const successor = await connectFrontend(server.path);
    await until(() => attachments.at(-1) === true);
    expect({ creates, starts, closes }).toEqual({ creates: 1, starts: 1, closes: 0 });
    await successor.close();
    await until(() => attachments.at(-1) === false);
    await server.close();
    expect(closes).toBe(1);
  } finally {
    abort.abort();
    socket?.close();
    await browser?.catch(() => {});
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller relays browser media only for the active runtime incarnation", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-browser-controller-"));
  const callbacks: Array<(method: string, params: unknown) => void> = [];
  const notifications: Array<{ incarnation: number; method: string; params: unknown }> = [];
  const outgoing: ServerMediaMessage[] = [];
  const controller = new RuntimeController({
    instanceId: "browser-controller",
    stateDir: root,
    provenance: {
      parsed: parseArgs([]),
      options: { debug: false },
      launchCwd: root,
    },
    version: "test",
    control: { name: "agentvoice_control", tools: [], server: {}, env: {} },
    onMedia: (message) => outgoing.push(message),
    lease: () => () => {},
    spawn: (incarnation, event, lease) => {
      callbacks.push(event);
      return {
        pid: incarnation,
        nativePid: undefined,
        exited: Promise.resolve(),
        notify: (method, params) => notifications.push({ incarnation, method, params }),
        stop: async () => false,
        request: async <T>(method: string): Promise<T> => {
          if (method === "preflight")
            return { workspace: root, buildId: `browser-${incarnation}`, pid: incarnation } as T;
          if (method === "activate") {
            await lease("browser-thread");
            event("identity", { workspace: root, threadId: "browser-thread" });
            event("state", {
              available: true,
              codingActivity: "unknown" as const,
              phase: "live",
              mic: { muted: true, effectiveMuted: true },
              speaker: { muted: false, effectiveMuted: false },
            });
          }
          return null as T;
        },
      };
    },
  });
  try {
    await controller.start();
    const firstSession = "11111111-1111-4111-8111-111111111111";
    callbacks[0]!("client-media", { type: "prepare", sessionId: firstSession });
    expect(outgoing).toEqual([{ type: "prepare", sessionId: firstSession }]);

    await controller.setFrontendAttached(false);
    callbacks[0]!("client-media", { type: "answer", sessionId: firstSession, sdp: "detached" });
    controller.clientMedia({ type: "connected", sessionId: firstSession });
    expect(outgoing).toHaveLength(1);
    expect(notifications.some((message) => message.method === "client-media")).toBe(false);
    expect(controller.state().mic.effectiveMuted).toBe(true);
    expect(controller.state().speaker.effectiveMuted).toBe(true);
    await controller.setFrontendAttached(true);

    await controller.restart({
      operationId: "browser-restart",
      expectedInstanceId: "browser-controller",
      expectedGeneration: 1,
      scope: "runtime",
    });
    await until(() => controller.status().currentOperation?.phase === "ready");
    expect(controller.status().generation).toBe(2);

    callbacks[0]!("client-media", { type: "answer", sessionId: firstSession, sdp: "stale" });
    expect(outgoing).toHaveLength(1);
    const secondSession = "22222222-2222-4222-8222-222222222222";
    callbacks[1]!("client-media", { type: "prepare", sessionId: secondSession });
    expect(outgoing.at(-1)).toEqual({ type: "prepare", sessionId: secondSession });

    controller.clientMedia({ type: "connected", sessionId: firstSession });
    expect(notifications.at(-1)).toEqual({
      incarnation: 2,
      method: "client-media",
      params: { type: "connected", sessionId: firstSession },
    });
    expect(
      notifications.some(
        (message) => message.incarnation === 1 && message.method === "client-media",
      ),
    ).toBe(false);
  } finally {
    await controller.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
