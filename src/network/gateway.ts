import { randomBytes } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";
import {
  FRONTEND_VERSION,
  frontendRequestSchema,
  frontendServerFrameSchema,
} from "../frontend/protocol.ts";
import { ControlSocket } from "../ipc/control-client.ts";
import { DeviceCredentials, type NetworkSettings } from "./credentials.ts";
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  heartbeatSchema,
  MAX_NETWORK_FRAME_BYTES,
  NETWORK_PATH,
  NETWORK_SUBPROTOCOL,
} from "./protocol.ts";

type Peer = {
  device: string;
  control?: ControlSocket;
  opening?: Promise<void>;
  closed: boolean;
  nonce?: string;
  sentAt: number;
  pending: Set<string>;
  windowAt: number;
  messages: number;
};

/** Loopback-only TLS-proxy backend. Every network peer has one ordinary local API connection. */
export class NetworkGateway {
  private server?: Server<Peer>;
  private readonly peers = new Set<ServerWebSocket<Peer>>();
  private reserved = 0;
  private readonly deviceReservations = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  private readonly credentials: DeviceCredentials;
  constructor(
    stateDir: string,
    private readonly socketPath: string,
    private readonly settings: NetworkSettings,
    private readonly timings = { interval: HEARTBEAT_INTERVAL_MS, timeout: HEARTBEAT_TIMEOUT_MS },
  ) {
    this.credentials = new DeviceCredentials(stateDir);
  }
  get port(): number {
    return this.server?.port ?? 0;
  }
  start(): void {
    const host = new URL(this.settings.endpoint).host;
    this.server = Bun.serve<Peer>({
      hostname: "127.0.0.1",
      port: this.settings.port,
      maxRequestBodySize: 0,
      fetch: (request, server) => {
        const url = new URL(request.url);
        const reject = (status: number) =>
          new Response(null, { status, headers: { "Cache-Control": "no-store" } });
        if (this.stopping) return reject(503);
        if (
          request.method !== "GET" ||
          url.pathname !== NETWORK_PATH ||
          url.search ||
          request.headers.has("origin")
        )
          return reject(404);
        if (![host, `127.0.0.1:${server.port}`].includes(request.headers.get("host") ?? ""))
          return reject(421);
        if (request.headers.get("sec-websocket-protocol") !== NETWORK_SUBPROTOCOL)
          return reject(426);
        const authorization = request.headers.get("authorization") ?? "";
        const device = authorization.startsWith("Bearer ")
          ? this.credentials.authenticate(authorization.slice(7))
          : undefined;
        if (!device) return reject(401);
        const count = this.deviceReservations.get(device) ?? 0;
        if (this.reserved >= 16 || count >= 4) return reject(429);
        this.reserved++;
        this.deviceReservations.set(device, count + 1);
        if (
          server.upgrade(request, {
            headers: { "Sec-WebSocket-Protocol": NETWORK_SUBPROTOCOL },
            data: {
              device,
              closed: false,
              sentAt: 0,
              pending: new Set(),
              windowAt: Date.now(),
              messages: 0,
            },
          })
        )
          return;
        this.reserved--;
        this.deviceReservations.set(device, count);
        return reject(400);
      },
      websocket: {
        maxPayloadLength: MAX_NETWORK_FRAME_BYTES,
        backpressureLimit: MAX_NETWORK_FRAME_BYTES,
        closeOnBackpressureLimit: true,
        idleTimeout: 60,
        open: (ws) => {
          this.peers.add(ws);
          ws.data.opening = (async () => {
            try {
              const control = await ControlSocket.connect(
                this.socketPath,
                FRONTEND_VERSION,
                (frame) => {
                  const parsed = frontendServerFrameSchema.safeParse(frame);
                  if (!parsed.success) {
                    this.closePeer(ws, 1011, "Invalid local server frame");
                    return;
                  }
                  this.send(ws, parsed.data);
                },
              );
              ws.data.control = control;
              if (ws.data.closed) {
                control.close();
                return;
              }
              void control.done.then(() => this.closePeer(ws, 1011, "Server call ended"));
            } catch {
              this.closePeer(ws, 1013, "Local server unavailable");
            }
          })();
          this.ping(ws);
        },
        message: (ws, data) => {
          void this.message(ws, data);
        },
        close: (ws) => {
          this.peers.delete(ws);
          this.reserved--;
          const count = (this.deviceReservations.get(ws.data.device) ?? 1) - 1;
          if (count === 0) this.deviceReservations.delete(ws.data.device);
          else this.deviceReservations.set(ws.data.device, count);
          ws.data.closed = true;
          ws.data.control?.close();
        },
      },
    });
    this.timer = setInterval(() => {
      for (const ws of this.peers) {
        if (!this.credentials.active(ws.data.device))
          this.closePeer(ws, 4403, "Device credential revoked or expired");
        else if (ws.data.nonce && Date.now() - ws.data.sentAt > this.timings.timeout)
          this.closePeer(ws, 4408, "Heartbeat timeout");
        else if (!ws.data.nonce) this.ping(ws);
      }
    }, this.timings.interval);
  }
  private ping(ws: ServerWebSocket<Peer>): void {
    ws.data.nonce = randomBytes(16).toString("hex");
    ws.data.sentAt = Date.now();
    this.send(ws, { v: 2, type: "ping", nonce: ws.data.nonce });
  }
  private send(ws: ServerWebSocket<Peer>, frame: unknown): void {
    if (ws.data.closed) return;
    const data = JSON.stringify(frame);
    if (Buffer.byteLength(data) > MAX_NETWORK_FRAME_BYTES || ws.send(data) <= 0)
      this.closePeer(ws, 4413, "Client not reading");
  }
  private closePeer(ws: ServerWebSocket<Peer>, code: number, reason: string): void {
    if (ws.data.closed) return;
    ws.data.closed = true;
    ws.data.control?.close(); // Teardown authority does not wait for a network close handshake.
    ws.close(code, reason);
    const timer = setTimeout(() => {
      if (this.peers.has(ws)) ws.terminate();
    }, 1000);
    timer.unref();
  }
  private async message(ws: ServerWebSocket<Peer>, data: string | Buffer): Promise<void> {
    if (ws.data.closed) return;
    if (!this.credentials.active(ws.data.device)) {
      this.closePeer(ws, 4403, "Credential unavailable");
      return;
    }
    if (typeof data !== "string" || Buffer.byteLength(data) > MAX_NETWORK_FRAME_BYTES) {
      this.closePeer(ws, 4400, "Invalid frame");
      return;
    }
    if (Date.now() - ws.data.windowAt > 10_000) {
      ws.data.windowAt = Date.now();
      ws.data.messages = 0;
    }
    if (++ws.data.messages > 256) {
      this.closePeer(ws, 4429, "Request rate exceeded");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      this.closePeer(ws, 4400, "Invalid JSON");
      return;
    }
    const heartbeat = heartbeatSchema.safeParse(value);
    if (heartbeat.success) {
      if (heartbeat.data.type !== "pong" || heartbeat.data.nonce !== ws.data.nonce)
        this.closePeer(ws, 4400, "Invalid heartbeat");
      else ws.data.nonce = undefined;
      return;
    }
    const parsed = frontendRequestSchema.safeParse(value);
    if (!parsed.success) {
      this.closePeer(ws, 4400, "Invalid API request");
      return;
    }
    const request = parsed.data;
    if (ws.data.pending.size >= 32 || ws.data.pending.has(request.id)) {
      this.closePeer(ws, 4429, "Duplicate or excessive pending request");
      return;
    }
    ws.data.pending.add(request.id);
    try {
      await ws.data.opening;
      if (ws.data.closed || !ws.data.control) return;
      const result = await ws.data.control.request(
        request.method,
        "params" in request ? request.params : undefined,
      );
      const frame = frontendServerFrameSchema.parse({
        v: 2,
        type: "response",
        id: request.id,
        ok: true,
        result,
      });
      this.send(ws, frame);
    } catch {
      this.send(ws, {
        v: 2,
        type: "response",
        id: request.id,
        ok: false,
        error: {
          message:
            "Request refused: server busy, unavailable, or connection does not own this call",
        },
      });
    } finally {
      ws.data.pending.delete(request.id);
    }
  }
  async close(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    const peers = [...this.peers];
    for (const ws of peers) this.closePeer(ws, 1001, "Server stopping");
    await Promise.allSettled(peers.map((ws) => ws.data.opening));
    for (const ws of peers) ws.data.control?.close();
    await this.server?.stop(true);
  }
}
