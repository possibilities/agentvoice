import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { ChatsConnection, ChatsConnectionError } from "../src/chats/client.ts";
import {
  AppServerGateway,
  type GatewayUpstream,
  type GatewayUpstreamCallbacks,
} from "../src/server/appserver-gateway.ts";
import { type SocketData, startHttpServer } from "../src/server/http-server.ts";

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

const servers: Server<SocketData>[] = [];

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
