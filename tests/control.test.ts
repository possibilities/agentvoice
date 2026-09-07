import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CONTROL_PROTOCOL_VERSION,
  type ControlBackend,
  ControlError,
  type ControlMutationRequest,
  type ControlOperation,
  type ControlStatus,
  startControlServer,
} from "../src/control/index.ts";
import { ControlMcpHttpHost } from "../src/control/mcp.ts";

function operation(
  kind: ControlOperation["kind"],
  scope: ControlOperation["scope"],
  request: ControlMutationRequest,
): ControlOperation {
  return {
    operationId: request.operationId,
    kind,
    scope,
    expectedGeneration: request.expectedGeneration,
    expectedInstanceId: request.expectedInstanceId,
    phase: "accepted",
    acceptedAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
  };
}

function fakeBackend(observe?: (request: unknown) => void): ControlBackend {
  const recentOperations: ControlOperation[] = [];
  const byId = new Map<string, ControlOperation>();
  const accept = (
    kind: ControlOperation["kind"],
    scope: ControlOperation["scope"],
    request: ControlMutationRequest,
  ) => {
    observe?.(request);
    if (request.expectedGeneration !== 7)
      throw new ControlError(
        "stale_generation",
        "read status before mutating the current runtime generation",
      );
    const prior = byId.get(request.operationId);
    if (prior) {
      if (
        prior.kind !== kind ||
        prior.expectedInstanceId !== request.expectedInstanceId ||
        prior.expectedGeneration !== request.expectedGeneration
      )
        throw new ControlError(
          "operation_conflict",
          "operation ID already names a different immutable request",
        );
      return prior;
    }
    const next = operation(kind, scope, request);
    byId.set(request.operationId, next);
    recentOperations.push(next);
    return next;
  };
  return {
    status: (): ControlStatus => ({
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      instanceId: "instance-a",
      workspace: "/work",
      threadId: "thread-a",
      generation: 7,
      runtime: { pid: 42, buildId: "build-a", phase: "ready" },
      recentOperations,
    }),
    redial: async (request) => accept("redial", "voice", request),
    restart: async (request) => accept("restart", "runtime", request),
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
  test("socket and MCP use the same durable mutation dispatch", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentvoice-control-"));
    const requests: unknown[] = [];
    const server = await startControlServer({
      backend: fakeBackend((request) => requests.push(request)),
      stateDir,
      instanceId: "instance-a",
    });
    try {
      expect((await stat(server.socketPath)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(server.socketPath))).mode & 0o777).toBe(0o700);
      expect(server.mcpServer).toMatchObject({
        url: server.httpUrl,
        bearer_token_env_var: server.bearerTokenEnvVar,
        startup_timeout_sec: 5,
        tool_timeout_sec: 5,
        required: true,
        enabled_tools: ["agentvoice_status", "agentvoice_redial", "agentvoice_restart_runtime"],
      });
      const status = await socketRequest(server.socketPath, {
        v: CONTROL_PROTOCOL_VERSION,
        type: "request",
        id: "status-1",
        method: "agentvoice.status",
        params: {},
      });
      expect(status).toMatchObject({ ok: true, id: "status-1", result: { generation: 7 } });

      const initial = await mcpRequest(server.httpUrl, server.bearerToken, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      });
      expect(initial.status).toBe(200);
      const sessionId = initial.headers.get("mcp-session-id");
      expect(sessionId).toBeString();
      await mcpRequest(
        server.httpUrl,
        server.bearerToken,
        { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
        sessionId ?? undefined,
      );
      const tools = await mcpRequest(
        server.httpUrl,
        server.bearerToken,
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        sessionId ?? undefined,
      );
      const toolText = await tools.text();
      expect(toolText).toContain("agentvoice_restart_runtime");
      expect(toolText).toContain("handoffPrompt");

      const call = await mcpRequest(
        server.httpUrl,
        server.bearerToken,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "agentvoice_restart_runtime",
            arguments: {
              operationId: "restart-1",
              expectedGeneration: 7,
              expectedInstanceId: "instance-a",
              scope: "runtime",
              handoffPrompt: "After restart, check status.\n雪",
            },
          },
        },
        sessionId ?? undefined,
      );
      expect(await call.text()).toContain('"operationId":"restart-1"');
      const duplicate = await socketRequest(server.socketPath, {
        v: CONTROL_PROTOCOL_VERSION,
        type: "request",
        id: "duplicate-1",
        method: "agentvoice.restart",
        params: {
          operationId: "restart-1",
          expectedGeneration: 7,
          expectedInstanceId: "instance-a",
          scope: "runtime",
          handoffPrompt: "After restart, check status.\n雪",
        },
      });
      expect(duplicate).toMatchObject({
        ok: true,
        result: { operationId: "restart-1", phase: "accepted" },
      });
      expect(requests).toHaveLength(2);
      expect(requests[0]).toEqual(requests[1]);
      expect(requests[0]).toHaveProperty("handoffPrompt", "After restart, check status.\n雪");
      let badRequestId = 4;
      for (const handoffPrompt of ["", " \n\t", null, "a".repeat(8193), "雪".repeat(2731)]) {
        const args = {
          operationId: "bad-handoff",
          expectedGeneration: 7,
          expectedInstanceId: "instance-a",
          scope: "runtime",
          handoffPrompt,
        };
        const socket = await socketRequest(server.socketPath, {
          v: CONTROL_PROTOCOL_VERSION,
          type: "request",
          id: "bad-handoff",
          method: "agentvoice.restart",
          params: args,
        });
        expect(socket).toMatchObject({ ok: false, error: { code: "invalid_params" } });
        const mcp = await mcpRequest(
          server.httpUrl,
          server.bearerToken,
          {
            jsonrpc: "2.0",
            id: badRequestId++,
            method: "tools/call",
            params: { name: "agentvoice_restart_runtime", arguments: args },
          },
          sessionId ?? undefined,
        );
        expect(await mcp.text()).toContain('"isError":true');
      }
      expect(requests).toHaveLength(2);
      const redialPrompt = await socketRequest(server.socketPath, {
        v: CONTROL_PROTOCOL_VERSION,
        type: "request",
        id: "bad-redial",
        method: "agentvoice.redial",
        params: {
          operationId: "bad-redial",
          expectedGeneration: 7,
          expectedInstanceId: "instance-a",
          handoffPrompt: "task",
        },
      });
      expect(redialPrompt).toMatchObject({ ok: false, error: { code: "invalid_params" } });
      const redialArgs = {
        operationId: "redial-1",
        expectedGeneration: 7,
        expectedInstanceId: "instance-a",
      };
      const redial = await socketRequest(server.socketPath, {
        v: CONTROL_PROTOCOL_VERSION,
        type: "request",
        id: "redial",
        method: "agentvoice.redial",
        params: redialArgs,
      });
      expect(redial).toMatchObject({ ok: true, result: { kind: "redial", scope: "voice" } });
      const redialMcp = await mcpRequest(
        server.httpUrl,
        server.bearerToken,
        {
          jsonrpc: "2.0",
          id: badRequestId++,
          method: "tools/call",
          params: { name: "agentvoice_redial", arguments: redialArgs },
        },
        sessionId ?? undefined,
      );
      expect(await redialMcp.text()).toContain('"operationId":"redial-1"');
      expect(requests.at(-1)).toEqual(requests.at(-2));
      expect(toolText).not.toContain("agentvoice_fresh");
      expect(
        await socketRequest(server.socketPath, {
          v: CONTROL_PROTOCOL_VERSION,
          type: "request",
          id: "fresh",
          method: "agentvoice.fresh",
          params: {},
        }),
      ).toMatchObject({ ok: false, error: { code: "unknown_method" } });
      for (const version of [1, 2, 3]) {
        const legacy = await socketRequest(server.socketPath, {
          v: version,
          type: "request",
          id: "legacy",
          method: "agentvoice.status",
        });
        expect(legacy).toMatchObject({ ok: false, error: { code: "invalid_request" } });
      }
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
      expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_params" } });
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
      expect(stale).toMatchObject({ ok: false, error: { code: "stale_generation" } });
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
