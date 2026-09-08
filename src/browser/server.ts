import { randomBytes, randomUUID } from "node:crypto";
import {
  BROWSER_MEDIA_MAX_FRAME_BYTES,
  type ClientMediaMessage,
  clientMediaMessageSchema,
  type ServerMediaMessage,
  serverMediaMessageSchema,
} from "../frontend/media-protocol.ts";
import { browserMediaPage, browserMediaScript } from "./page.ts";

type SocketData = { ownerId: string };

export type BrowserMediaOwner = { readonly id: string };

export type BrowserMediaServerOptions = {
  token?: string;
  onOwnerOpen: (owner: BrowserMediaOwner) => Promise<void> | void;
  onClientMessage: (message: ClientMediaMessage, owner: BrowserMediaOwner) => Promise<void> | void;
  onOwnerClosed: (owner: BrowserMediaOwner) => Promise<void> | void;
};

function browserHeaders(authority: string): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; media-src blob:; ` +
      `connect-src ws://${authority}; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "microphone=(self), camera=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

export class BrowserMediaServer {
  readonly token: string;
  #options: BrowserMediaServerOptions;
  #server?: Bun.Server<SocketData>;
  #reservedOwnerId: string | null = null;
  #ownerSocket?: Bun.ServerWebSocket<SocketData>;
  #ownerOpening?: Promise<void>;
  #ownerCleanup?: Promise<void>;
  #closePromise?: Promise<void>;

  constructor(options: BrowserMediaServerOptions) {
    this.#options = options;
    this.token = options.token ?? randomBytes(32).toString("hex");
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(this.token))
      throw new Error("invalid browser capability token");
  }

  get url(): string {
    if (!this.#server) throw new Error("browser media server is not started");
    return `http://127.0.0.1:${this.#server.port}/${this.token}/`;
  }

  start(): void {
    if (this.#server) throw new Error("browser media server is already started");
    this.#server = Bun.serve<SocketData>({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: 1024,
      fetch: (request, server) => this.#fetch(request, server),
      websocket: {
        maxPayloadLength: BROWSER_MEDIA_MAX_FRAME_BYTES,
        // A healthy voice call may carry media without any WebSocket control
        // frames for much longer than Bun's default idle window.
        idleTimeout: 0,
        open: (socket) => void this.#opened(socket),
        message: (socket, data) => void this.#message(socket, data),
        close: (socket) => void this.#closed(socket),
      },
    });
  }

  send(message: ServerMediaMessage): boolean {
    const parsed = serverMediaMessageSchema.safeParse(message);
    if (!parsed.success || !this.#ownerSocket) return false;
    return this.#ownerSocket.send(JSON.stringify(parsed.data)) > 0;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    const server = this.#server;
    if (!server) return Promise.resolve();
    const operation = (async () => {
      const socket = this.#ownerSocket;
      const ownerId = this.#reservedOwnerId;
      const opening = this.#ownerOpening;
      try {
        if (socket && ownerId !== null) {
          this.#ownerSocket = undefined;
          this.#reservedOwnerId = null;
          socket.close(1001, "server closing");
          await opening?.catch(() => {});
          await this.#options.onOwnerClosed({ id: ownerId });
        } else {
          await this.#ownerCleanup;
        }
      } finally {
        server.stop(true);
        this.#server = undefined;
        this.#ownerSocket = undefined;
        this.#ownerOpening = undefined;
        this.#reservedOwnerId = null;
      }
    })();
    this.#closePromise = operation;
    const clear = () => {
      if (this.#closePromise === operation) this.#closePromise = undefined;
    };
    void operation.then(clear, clear);
    return operation;
  }

  #fetch(request: Request, server: Bun.Server<SocketData>): Response | undefined {
    const url = new URL(request.url);
    const authority = `127.0.0.1:${server.port}`;
    const headers = browserHeaders(authority);
    if (request.headers.get("host") !== authority)
      return new Response("invalid host", { status: 421 });
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
    const root = `/${this.token}/`;
    if (url.pathname === `${root}ws`) {
      if (request.headers.get("origin") !== `http://${authority}`)
        return new Response("invalid origin", { status: 403 });
      if (this.#reservedOwnerId !== null) return new Response("voice owner busy", { status: 409 });
      const ownerId = randomUUID();
      this.#reservedOwnerId = ownerId;
      if (server.upgrade(request, { data: { ownerId } })) return;
      this.#reservedOwnerId = null;
      return new Response("upgrade required", { status: 426 });
    }
    if (url.pathname === root)
      return new Response(browserMediaPage, {
        headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
      });
    if (url.pathname === `${root}app.js`)
      return new Response(browserMediaScript, {
        headers: { ...headers, "Content-Type": "text/javascript; charset=utf-8" },
      });
    return new Response("not found", { status: 404, headers });
  }

  async #opened(socket: Bun.ServerWebSocket<SocketData>): Promise<void> {
    if (this.#reservedOwnerId !== socket.data.ownerId)
      return socket.close(1008, "owner unavailable");
    this.#ownerSocket = socket;
    const opening = Promise.resolve().then(() =>
      this.#options.onOwnerOpen({ id: socket.data.ownerId }),
    );
    this.#ownerOpening = opening;
    try {
      await opening;
    } catch {
      if (socket === this.#ownerSocket) socket.close(1011, "owner startup failed");
    } finally {
      if (this.#ownerOpening === opening) this.#ownerOpening = undefined;
    }
  }

  async #message(socket: Bun.ServerWebSocket<SocketData>, data: string | Buffer): Promise<void> {
    if (socket !== this.#ownerSocket || socket.data.ownerId !== this.#reservedOwnerId) return;
    const raw = typeof data === "string" ? data : data.toString("utf8");
    if (Buffer.byteLength(raw) > BROWSER_MEDIA_MAX_FRAME_BYTES)
      return socket.close(1009, "frame too large");
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return socket.close(1007, "invalid json");
    }
    const parsed = clientMediaMessageSchema.safeParse(decoded);
    if (!parsed.success) return socket.close(1008, "invalid message");
    try {
      await this.#options.onClientMessage(parsed.data, { id: socket.data.ownerId });
    } catch {
      if (socket === this.#ownerSocket) socket.close(1011, "message handling failed");
    }
  }

  async #closed(socket: Bun.ServerWebSocket<SocketData>): Promise<void> {
    if (socket.data.ownerId !== this.#reservedOwnerId) return;
    this.#ownerSocket = undefined;
    const opening = this.#ownerOpening;
    // Startup may still be allocating the frontend call when the browser goes
    // away. Serialize teardown behind it so a late startup cannot leak a call.
    const cleanup = Promise.resolve()
      .then(() => opening)
      .catch(() => {})
      .then(() => this.#options.onOwnerClosed({ id: socket.data.ownerId }));
    this.#ownerCleanup = cleanup;
    try {
      await cleanup;
    } finally {
      if (this.#reservedOwnerId === socket.data.ownerId) this.#reservedOwnerId = null;
      if (this.#ownerCleanup === cleanup) this.#ownerCleanup = undefined;
    }
  }
}
