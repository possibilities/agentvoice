import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import {
  AppServerGateway,
  type GatewayUpstream,
  type GatewayUpstreamCallbacks,
} from "../src/server/appserver-gateway.ts";
import { type SocketData, startHttpServer } from "../src/server/http-server.ts";

class EchoUpstream implements GatewayUpstream {
  constructor(readonly callbacks: GatewayUpstreamCallbacks) {}
  connect(): Promise<void> {
    return Promise.resolve();
  }
  sendText(text: string): void {
    const value = JSON.parse(text) as Record<string, unknown>;
    this.callbacks.onText(
      JSON.stringify({
        jsonrpc: "2.0",
        id: value["id"],
        result: { echoedMethod: value["method"] },
      }),
    );
  }
  close(): void {}
}

const servers: Server<SocketData>[] = [];
const sockets: WebSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of servers.splice(0)) server.stop(true);
});

function fixture(): { url: string; voiceOpens: () => number } {
  const gateway = new AppServerGateway({
    connect(_socketPath, callbacks) {
      return new EchoUpstream(callbacks);
    },
  });
  gateway.setAppServer({ alive: true, socketPath: "/private/app-server.sock" });
  let voiceOpenCount = 0;
  const server = startHttpServer({
    port: 0,
    token: "secret",
    version: "test",
    appServerGateway: gateway,
    voice: {
      open() {
        voiceOpenCount++;
      },
      message() {},
      close() {},
    },
  });
  servers.push(server);
  return {
    url: `ws://127.0.0.1:${server.port}`,
    voiceOpens: () => voiceOpenCount,
  };
}

function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error(`unable to connect to ${url}`));
  });
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.onmessage = (event) =>
      resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
  });
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => {
    socket.onclose = resolve;
  });
}

describe("AgentVoice HTTP/WebSocket server", () => {
  test("advertises protocol 2 and rejects the wrong token after upgrade", async () => {
    const { url } = fixture();
    const health = await fetch(url.replace("ws:", "http:"));
    expect(await health.json()).toMatchObject({
      appServerGateway: { path: "/app-server", protocol: 2 },
    });

    const socket = new WebSocket(`${url}/app-server?token=wrong`);
    sockets.push(socket);
    const closed = nextClose(socket);
    expect((await closed).code).toBe(4401);
  });

  test("serves independent raw gateway clients without consuming the voice slot", async () => {
    const { url, voiceOpens } = fixture();
    const first = await connect(`${url}/app-server?token=secret`);
    const second = await connect(`${url}/app-server?token=secret`);
    await Promise.resolve();

    const firstResponse = nextMessage(first);
    const secondResponse = nextMessage(second);
    first.send(JSON.stringify({ id: "same-id", method: "future/one", params: { a: 1 } }));
    second.send(JSON.stringify({ id: "same-id", method: "future/two", params: { b: 2 } }));
    expect(await firstResponse).toMatchObject({
      id: "same-id",
      result: { echoedMethod: "future/one" },
    });
    expect(await secondResponse).toMatchObject({
      id: "same-id",
      result: { echoedMethod: "future/two" },
    });

    const voice = await connect(`${url}/ws?token=secret`);
    expect(voice.readyState).toBe(WebSocket.OPEN);
    expect(voiceOpens()).toBe(1);
  });

  test("keeps voice exclusivity while allowing native thread/unsubscribe", async () => {
    const { url } = fixture();
    await connect(`${url}/ws?token=secret`);
    const secondVoice = new WebSocket(`${url}/ws?token=secret`);
    sockets.push(secondVoice);
    const closed = nextClose(secondVoice);
    expect((await closed).code).toBe(4429);

    const chats = await connect(`${url}/app-server?token=secret`);
    await Promise.resolve();
    const response = nextMessage(chats);
    chats.send(JSON.stringify({ id: 4, method: "thread/unsubscribe", params: { threadId: "t" } }));
    expect(await response).toMatchObject({
      id: 4,
      result: { echoedMethod: "thread/unsubscribe" },
    });
  });
});
