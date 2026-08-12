import { afterEach, describe, expect, test } from "bun:test";
import { ChatsConnection, ChatsConnectionError } from "../src/chats/client.ts";
import {
  AppServerGateway,
  type GatewayUpstream,
  type GatewayUpstreamCallbacks,
} from "../src/server/appserver-gateway.ts";
import { startHttpServer } from "../src/server/http-server.ts";

class RpcUpstream implements GatewayUpstream {
  constructor(readonly callbacks: GatewayUpstreamCallbacks) {}
  connect(): Promise<void> {
    return Promise.resolve();
  }
  sendText(text: string): void {
    const request = JSON.parse(text) as Record<string, unknown>;
    this.callbacks.onText(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request["id"],
        result: { echoedMethod: request["method"] },
      }),
    );
  }
  close(): void {}
}

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function fixture(): string {
  const gateway = new AppServerGateway({
    connect(_socketPath, callbacks) {
      return new RpcUpstream(callbacks);
    },
  });
  gateway.setAppServer({ alive: true, socketPath: "/private/app-server.sock" });
  const server = startHttpServer({
    port: 0,
    token: "secret",
    version: "test",
    appServerGateway: gateway,
    voice: { open() {}, message() {}, close() {} },
  });
  servers.push(server);
  return `ws://127.0.0.1:${server.port}/app-server`;
}

function legacyFixture(): string {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/") {
        return Response.json({ name: "agentvoice", version: "old", protocol: 1 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return `ws://127.0.0.1:${server.port}/app-server`;
}

function hangingFixture(): string {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Promise<Response>(() => {});
    },
  });
  servers.push(server);
  return `ws://127.0.0.1:${server.port}/app-server`;
}

describe("ChatsConnection", () => {
  test("initializes and speaks app-server requests through its native connection", async () => {
    const frames: Record<string, unknown>[] = [];
    const connection = new ChatsConnection({
      url: fixture(),
      token: "secret",
      version: "test",
      onFrame(frame) {
        frames.push(frame);
      },
    });
    await connection.connect();
    await expect(connection.request("future/read", { raw: true })).resolves.toEqual({
      echoedMethod: "future/read",
    });
    expect(frames).toContainEqual({
      direction: "toAppServer",
      owner: "client",
      payload: { jsonrpc: "2.0", id: 2, method: "future/read", params: { raw: true } },
    });
    expect(frames).toContainEqual({
      direction: "fromAppServer",
      owner: "client",
      payload: { jsonrpc: "2.0", id: 2, result: { echoedMethod: "future/read" } },
    });
    connection.close();
  });

  test("reports an unauthorized close and does not leave a usable connection", async () => {
    const connection = new ChatsConnection({
      url: fixture(),
      token: "wrong",
      version: "test",
      onFrame() {},
    });
    await expect(connection.connect()).rejects.toThrow(ChatsConnectionError);
    await expect(connection.request("thread/loaded/list", {})).rejects.toThrow(
      "app-server gateway is not connected",
    );
  });

  test("explains when a live server predates the app-server gateway", async () => {
    const connection = new ChatsConnection({
      url: legacyFixture(),
      token: "secret",
      version: "test",
      onFrame() {},
    });
    await expect(connection.connect()).rejects.toThrow(
      "predates chats support — restart agentvoice server, then retry",
    );
  });

  test("bounds a server probe that accepts TCP but never answers HTTP", async () => {
    const connection = new ChatsConnection({
      url: hangingFixture(),
      token: "secret",
      version: "test",
      onFrame() {},
    });
    const startedAt = performance.now();
    await expect(connection.connect()).rejects.toThrow("timed out probing AgentVoice server");
    expect(performance.now() - startedAt).toBeLessThan(3_000);
  });

  test("can initialize a fresh native connection after closing", async () => {
    const connection = new ChatsConnection({
      url: fixture(),
      token: "secret",
      version: "test",
      onFrame() {},
    });
    await connection.connect();
    connection.close();
    await connection.connect();
    await expect(connection.request("thread/loaded/list", {})).resolves.toEqual({
      echoedMethod: "thread/loaded/list",
    });
    connection.close();
  });
});
