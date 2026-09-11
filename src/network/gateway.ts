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
  CHALLENGE_PATH,
  PAIRING_PATH,
  PairingChallenges,
  PairingControlServer,
  PairingCoordinator,
  PairingFailure,
  type PairingProofReservation,
  pairingSettings,
} from "./pairing.ts";
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  heartbeatSchema,
  MAX_NETWORK_FRAME_BYTES,
  NETWORK_PATH,
  NETWORK_SUBPROTOCOL,
} from "./protocol.ts";

type Peer = {
  authority: { kind: "legacy-grant" | "paired-device"; id: string };
  reservationKey: string;
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
  private readonly pairing: PairingCoordinator;
  private readonly challenges: PairingChallenges;
  private readonly pairingControl: PairingControlServer;
  constructor(
    stateDir: string,
    private readonly socketPath: string,
    private readonly settings: NetworkSettings,
    private readonly timings = { interval: HEARTBEAT_INTERVAL_MS, timeout: HEARTBEAT_TIMEOUT_MS },
  ) {
    this.credentials = new DeviceCredentials(stateDir);
    this.pairing = new PairingCoordinator(stateDir, settings.endpoint);
    this.challenges = new PairingChallenges(this.pairing.paired);
    this.pairingControl = new PairingControlServer(stateDir, this.pairing);
  }
  get port(): number {
    return this.server?.port ?? 0;
  }
  async start(): Promise<void> {
    const { host } = pairingSettings(this.settings);
    await this.pairingControl.start();
    try {
      this.server = Bun.serve<Peer>({
        hostname: "127.0.0.1",
        port: this.settings.port,
        maxRequestBodySize: 8192,
        fetch: async (request, server) => {
          const url = new URL(request.url);
          const requestHost = request.headers.get("host") ?? "";
          const reject = (status: number, code?: string) =>
            code
              ? new Response(JSON.stringify({ v: 1, error: { code } }), {
                  status,
                  headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
                })
              : new Response(null, { status, headers: { "Cache-Control": "no-store" } });
          if (this.stopping) return reject(503, "pairing_unavailable");
          if (url.search || request.headers.has("origin")) return reject(404);
          if (![host, `127.0.0.1:${server.port}`].includes(requestHost)) return reject(421);
          if (url.pathname === PAIRING_PATH || url.pathname === CHALLENGE_PATH) {
            if (
              request.method !== "POST" ||
              request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
                "application/json"
            )
              return reject(400, "invalid_request");
            try {
              const maximum = url.pathname === PAIRING_PATH ? 4096 : 512;
              const text = await request.text();
              if (!text || Buffer.byteLength(text) > maximum)
                throw new PairingFailure("invalid_request", 400);
              let value: unknown;
              try {
                value = JSON.parse(text);
              } catch {
                throw new PairingFailure("invalid_request", 400);
              }
              if (url.pathname === PAIRING_PATH) {
                const result = this.pairing.enroll(value);
                return new Response(JSON.stringify(result.response), {
                  status: result.recovered ? 200 : 201,
                  headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
                });
              }
              return new Response(JSON.stringify(this.challenges.issue(value)), {
                status: 200,
                headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
              });
            } catch (error) {
              const failure =
                error instanceof PairingFailure
                  ? error
                  : new PairingFailure("pairing_unavailable", 503);
              return reject(failure.status, failure.code);
            }
          }
          if (request.method !== "GET" || url.pathname !== NETWORK_PATH) return reject(404);
          if (request.headers.get("sec-websocket-protocol") !== NETWORK_SUBPROTOCOL)
            return reject(426);
          const authorization = request.headers.get("authorization") ?? "";
          const signedHeaders = [
            "x-agentvoice-auth",
            "x-agentvoice-device",
            "x-agentvoice-challenge",
            "x-agentvoice-signature",
          ];
          let proof: PairingProofReservation | undefined;
          let authority: Peer["authority"] | undefined;
          if (
            authorization.startsWith("Bearer ") &&
            !signedHeaders.some((name) => request.headers.has(name))
          ) {
            const id = this.credentials.authenticate(authorization.slice(7));
            if (id) authority = { kind: "legacy-grant", id };
          } else if (!authorization) {
            proof = this.challenges.reserve(request.headers, requestHost);
            if (proof) authority = { kind: "paired-device", id: proof.deviceId };
          }
          if (!authority) return reject(401);
          const reservationKey = `${authority.kind}:${authority.id}`;
          const count = this.deviceReservations.get(reservationKey) ?? 0;
          if (this.reserved >= 16 || count >= 4) {
            proof?.release();
            return reject(429);
          }
          this.reserved++;
          this.deviceReservations.set(reservationKey, count + 1);
          let upgraded = false;
          try {
            upgraded = server.upgrade(request, {
              headers: { "Sec-WebSocket-Protocol": NETWORK_SUBPROTOCOL },
              data: {
                authority,
                reservationKey,
                closed: false,
                sentAt: 0,
                pending: new Set(),
                windowAt: Date.now(),
                messages: 0,
              },
            });
          } catch {
            upgraded = false;
          }
          if (upgraded) {
            proof?.commit();
            return;
          }
          proof?.release();
          this.reserved--;
          this.deviceReservations.set(reservationKey, count);
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
            const count = (this.deviceReservations.get(ws.data.reservationKey) ?? 1) - 1;
            if (count === 0) this.deviceReservations.delete(ws.data.reservationKey);
            else this.deviceReservations.set(ws.data.reservationKey, count);
            ws.data.closed = true;
            ws.data.control?.close();
          },
        },
      });
    } catch (error) {
      this.pairingControl.close();
      throw error;
    }
    this.timer = setInterval(() => {
      for (const ws of this.peers) {
        if (!this.active(ws.data.authority))
          this.closePeer(ws, 4403, "Device credential revoked or expired");
        else if (ws.data.nonce && Date.now() - ws.data.sentAt > this.timings.timeout)
          this.closePeer(ws, 4408, "Heartbeat timeout");
        else if (!ws.data.nonce) this.ping(ws);
      }
    }, this.timings.interval);
  }
  private active(authority: Peer["authority"]): boolean {
    return authority.kind === "legacy-grant"
      ? this.credentials.active(authority.id)
      : this.pairing.paired.active(authority.id);
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
    if (!this.active(ws.data.authority)) {
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
        v: FRONTEND_VERSION,
        type: "response",
        id: request.id,
        ok: true,
        result,
      });
      this.send(ws, frame);
    } catch {
      this.send(ws, {
        v: FRONTEND_VERSION,
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
    this.pairingControl.close();
    clearInterval(this.timer);
    const peers = [...this.peers];
    for (const ws of peers) this.closePeer(ws, 1001, "Server stopping");
    await Promise.allSettled(peers.map((ws) => ws.data.opening));
    for (const ws of peers) ws.data.control?.close();
    await this.server?.stop(true);
  }
}
