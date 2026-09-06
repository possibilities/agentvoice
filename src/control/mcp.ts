import { randomBytes, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CONTROL_METHODS, dispatchControl } from "./contract.ts";
import {
  CONTROL_MCP_PATH,
  CONTROL_PROTOCOL_VERSION,
  type ControlBackend,
  ControlError,
} from "./types.ts";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_SESSIONS = 32;
const SESSION_IDLE_MS = 5 * 60_000;

type Session = {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  lastUsed: number;
};

export type ControlMcpHttpOptions = {
  attachment?: (value: unknown) => Promise<unknown>;
  maxRequestBytes?: number;
  maxSessions?: number;
  sessionIdleMs?: number;
};

/** Loopback-only Streamable HTTP MCP projection of the exact socket dispatch. */
export class ControlMcpHttpHost {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly sessions = new Map<string, Session>();
  private pendingSessions = 0;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly backend: ControlBackend,
    readonly token = randomBytes(32).toString("base64url"),
    private readonly options: ControlMcpHttpOptions = {},
  ) {}

  start(): string {
    if (this.server) return this.url;
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      maxRequestBodySize: this.options.maxRequestBytes ?? MAX_REQUEST_BYTES,
      fetch: (request) => this.handle(request),
    });
    this.cleanupTimer = setInterval(() => void this.expireSessions(), this.sessionIdleMs);
    this.cleanupTimer.unref?.();
    return this.url;
  }

  get url(): string {
    if (!this.server) throw new Error("MCP host is not started");
    return `http://127.0.0.1:${this.server.port}${CONTROL_MCP_PATH}`;
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    for (const session of this.sessions.values()) await session.server.close().catch(() => {});
    this.sessions.clear();
    this.server?.stop(true);
    this.server = null;
  }

  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== CONTROL_MCP_PATH && path !== "/tui/attach")
      return new Response("not found", { status: 404 });
    if (request.headers.get("authorization") !== `Bearer ${this.token}`)
      return new Response("unauthorized", { status: 401 });
    if (!this.loopbackHeadersAllowed(request)) return new Response("forbidden", { status: 403 });
    if (path === "/tui/attach") {
      if (request.headers.has("origin") || request.method !== "POST" || !this.options.attachment)
        return new Response("forbidden", { status: 403 });
      try {
        const result = await this.options.attachment(await request.json());
        return Response.json(result, { headers: { "Cache-Control": "no-store" } });
      } catch {
        return new Response("Attachment unavailable; select the current live thread", {
          status: 409,
        });
      }
    }
    await this.expireSessions();
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) return new Response("unknown session", { status: 404 });
      session.lastUsed = Date.now();
      return await session.transport.handleRequest(request);
    }
    if (request.method !== "POST") return new Response("session required", { status: 400 });
    if (this.sessions.size + this.pendingSessions >= this.maxSessions)
      return new Response("too many MCP sessions", { status: 429 });
    let session: Session | undefined;
    let initialized = false;
    this.pendingSessions += 1;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        if (session) {
          initialized = true;
          this.pendingSessions -= 1;
          this.sessions.set(id, session);
        }
      },
      allowedHosts: [this.hostHeader],
      allowedOrigins: [`http://${this.hostHeader}`],
      enableDnsRebindingProtection: true,
    });
    const server = buildMcpServer(this.backend);
    session = { server, transport, lastUsed: Date.now() };
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) this.sessions.delete(id);
    };
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      if (!initialized) await server.close().catch(() => {});
      return response;
    } catch (error) {
      if (!initialized) await server.close().catch(() => {});
      throw error;
    } finally {
      if (!initialized) this.pendingSessions -= 1;
    }
  }

  private get maxSessions(): number {
    return this.options.maxSessions ?? MAX_SESSIONS;
  }

  private get sessionIdleMs(): number {
    return this.options.sessionIdleMs ?? SESSION_IDLE_MS;
  }

  private get hostHeader(): string {
    if (!this.server) throw new Error("MCP host is not started");
    return `127.0.0.1:${this.server.port}`;
  }

  private loopbackHeadersAllowed(request: Request): boolean {
    const host = request.headers.get("host");
    const origin = request.headers.get("origin");
    return host === this.hostHeader && (origin === null || origin === `http://${this.hostHeader}`);
  }

  private async expireSessions(): Promise<void> {
    const deadline = Date.now() - this.sessionIdleMs;
    for (const [id, session] of this.sessions) {
      if (session.lastUsed > deadline) continue;
      this.sessions.delete(id);
      await session.server.close().catch(() => {});
    }
  }
}

function buildMcpServer(backend: ControlBackend): McpServer {
  const server = new McpServer(
    { name: "agentvoice-control", version: String(CONTROL_PROTOCOL_VERSION) },
    {
      instructions:
        "Control the AgentVoice controller bound to this exact conversation. Restart and redial return durable accepted operations; use agentvoice_status to recover completion after an interrupted tool call.",
    },
  );
  for (const [method, entry] of Object.entries(CONTROL_METHODS)) {
    server.registerTool(
      entry.tool,
      {
        title: method,
        description: entry.description,
        inputSchema: entry.params,
        outputSchema: entry.result,
        annotations: {
          readOnlyHint: entry.readOnly,
          idempotentHint: entry.readOnly,
          openWorldHint: false,
        },
      },
      async (params: unknown) => {
        try {
          const result = await dispatchControl(backend, method, params);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result as Record<string, unknown>,
          };
        } catch (error) {
          const code = error instanceof ControlError ? error.code : "internal_error";
          const message = error instanceof Error ? error.message : String(error);
          return { isError: true, content: [{ type: "text", text: `${code}: ${message}` }] };
        }
      },
    );
  }
  return server;
}
