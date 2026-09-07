import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CONTROL_PROTOCOL_VERSION,
  type ControlBackend,
  startControlServer,
} from "../src/control/index.ts";
import { ControlMcpHttpHost } from "../src/control/mcp.ts";

function fakeBackend(): ControlBackend {
  return {
    status: () => ({
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      instanceId: "instance-a",
      workspace: "/work",
      threadId: "thread-a",
      generation: 1,
      runtime: { phase: "ready" },
    }),
  };
}

async function socketRequest(path: string, request: unknown): Promise<Record<string, unknown>> {
  return await socketLine(path, `${JSON.stringify(request)}\n`);
}

async function socketLine(path: string, line: string): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    let received = "";
    let outgoing = Buffer.from(line);
    const flush = (socket: { write(data: Uint8Array): number }) => {
      const written = socket.write(outgoing);
      if (written > 0) outgoing = outgoing.subarray(written);
    };
    void Bun.connect({
      unix: path,
      socket: {
        open: flush,
        drain: flush,
        data: (socket, data) => {
          received += new TextDecoder().decode(data);
          const newline = received.indexOf("\n");
          if (newline < 0) return;
          socket.end();
          resolve(JSON.parse(received.slice(0, newline)) as Record<string, unknown>);
        },
        error: (_socket, error) => reject(error),
      },
    }).catch(reject);
  });
}

async function mcpRequest(
  url: string,
  token: string,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<Response> {
  return await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("controller control transports", () => {
  test("only status is exposed through socket and MCP", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentvoice-control-"));
    const server = await startControlServer({
      backend: fakeBackend(),
      stateDir,
      instanceId: "instance-a",
    });
    try {
      expect((await stat(server.socketPath)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(server.socketPath))).mode & 0o777).toBe(0o700);
      const status = await socketRequest(server.socketPath, {
        v: CONTROL_PROTOCOL_VERSION,
        type: "request",
        id: "status",
        method: "agentvoice.status",
      });
      expect(status).toMatchObject({ ok: true, result: { threadId: "thread-a" } });
      expect(server.mcpServer.enabled_tools).toEqual(["agentvoice_status"]);
      for (const method of ["agentvoice.redial", "agentvoice.restart", "agentvoice.fresh"])
        expect(
          await socketRequest(server.socketPath, {
            v: CONTROL_PROTOCOL_VERSION,
            type: "request",
            id: method,
            method,
          }),
        ).toMatchObject({ ok: false, error: { code: "unknown_method" } });
      const response = await mcpRequest(server.httpUrl, server.bearerToken, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      });
      const session = response.headers.get("mcp-session-id")!;
      const catalog = await mcpRequest(
        server.httpUrl,
        server.bearerToken,
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        session,
      );
      expect(
        (
          JSON.parse((await catalog.text()).split("data: ")[1]!.split("\n")[0]!) as {
            result: { tools: { name: string }[] };
          }
        ).result.tools.map((tool: { name: string }) => tool.name),
      ).toEqual(["agentvoice_status"]);
    } finally {
      await server.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("rejects bad auth, malformed mutations, and stale socket owners without calling the backend", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentvoice-control-"));
    const server = await startControlServer({
      backend: fakeBackend(),
      stateDir,
      instanceId: "instance-a",
    });
    try {
      const unauthorized = await fetch(server.httpUrl, { method: "POST" });
      expect(unauthorized.status).toBe(401);
      const malformed = await socketLine(server.socketPath, "{not json}\n");
      expect(malformed).toMatchObject({ ok: false, error: { code: "invalid_request" } });
      const invalid = await socketRequest(server.socketPath, {
        v: CONTROL_PROTOCOL_VERSION,
        type: "request",
        id: "bad",
        method: "agentvoice.restart",
        params: { operationId: "one", expectedGeneration: 7, expectedInstanceId: "instance-a" },
      });
      expect(invalid).toMatchObject({ ok: false, error: { code: "unknown_method" } });
      const stale = await socketRequest(server.socketPath, {
        v: CONTROL_PROTOCOL_VERSION,
        type: "request",
        id: "stale",
        method: "agentvoice.redial",
        params: {
          operationId: "redial-stale",
          expectedGeneration: 6,
          expectedInstanceId: "instance-a",
        },
      });
      expect(stale).toMatchObject({ ok: false, error: { code: "unknown_method" } });
      await expect(
        startControlServer({ backend: fakeBackend(), stateDir, instanceId: "instance-a" }),
      ).rejects.toThrow("another AgentVoice controller owns");
    } finally {
      await server.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("bounds and cleans authenticated MCP sessions and rejects non-loopback web headers", async () => {
    const host = new ControlMcpHttpHost(fakeBackend(), "test-token", {
      maxSessions: 1,
      sessionIdleMs: 1_000,
    });
    const url = host.start();
    const initialize = () =>
      mcpRequest(url, "test-token", {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      });
    try {
      const invalidInitialize = await fetch(url, {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: "{",
      });
      expect(invalidInitialize.status).toBe(400);
      expect((await initialize()).status).toBe(200);
      expect((await initialize()).status).toBe(429);
      const foreignOrigin = await fetch(url, {
        method: "POST",
        headers: { authorization: "Bearer test-token", origin: "https://example.test" },
        body: "{}",
      });
      expect(foreignOrigin.status).toBe(403);
      const foreignHost = await fetch(url, {
        method: "POST",
        headers: { authorization: "Bearer test-token", host: "example.test" },
        body: "{}",
      });
      expect(foreignHost.status).toBe(403);
      const oversized = await fetch(url, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: "x".repeat(65 * 1024),
      });
      expect(oversized.status).toBe(413);
    } finally {
      await host.close();
    }
    const expiring = new ControlMcpHttpHost(fakeBackend(), "test-token", {
      maxSessions: 1,
      sessionIdleMs: 1,
    });
    const expiringUrl = expiring.start();
    try {
      expect(
        (
          await mcpRequest(expiringUrl, "test-token", {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "test", version: "1" },
            },
          })
        ).status,
      ).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(
        (
          await mcpRequest(expiringUrl, "test-token", {
            jsonrpc: "2.0",
            id: 2,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "test", version: "1" },
            },
          })
        ).status,
      ).toBe(200);
    } finally {
      await expiring.close();
    }
  });
});
