import { EventEmitter } from "node:events";
import { frontendServerFrameSchema } from "../frontend/protocol.ts";
import { type ConnectionProfile, connectionProfileSchema } from "./credentials.ts";
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  heartbeatSchema,
  MAX_NETWORK_FRAME_BYTES,
  NETWORK_SUBPROTOCOL,
} from "./protocol.ts";

/** Adapts one authenticated WSS connection to the existing bounded frontend parser. */
export class NetworkClientSocket extends EventEmitter {
  private readonly ws: WebSocket;
  private watchdog: ReturnType<typeof setTimeout>;
  destroyed = false;
  constructor(profile: ConnectionProfile) {
    super();
    const parsed = connectionProfileSchema.safeParse(profile);
    if (!parsed.success) throw new Error("Invalid network connection profile");
    try {
      this.ws = new WebSocket(profile.endpoint, {
        protocols: [NETWORK_SUBPROTOCOL],
        headers: { Authorization: `Bearer ${profile.token}` },
      });
    } catch {
      throw new Error("Secure connection could not be created");
    }
    this.watchdog = this.arm();
    this.ws.addEventListener("open", () => {
      if (this.destroyed) {
        this.ws.terminate();
        return;
      }
      if (this.ws.protocol !== NETWORK_SUBPROTOCOL) {
        this.fail("Server did not negotiate client API v2");
        return;
      }
      this.emit("connect");
    });
    this.ws.addEventListener("message", (event) => {
      if (this.destroyed) return;
      if (
        typeof event.data !== "string" ||
        Buffer.byteLength(event.data) > MAX_NETWORK_FRAME_BYTES
      ) {
        this.fail("Invalid network server frame");
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(event.data);
      } catch {
        this.fail("Invalid network server JSON");
        return;
      }
      const heartbeat = heartbeatSchema.safeParse(value);
      if (heartbeat.success) {
        if (heartbeat.data.type !== "ping") {
          this.fail("Unexpected network heartbeat");
          return;
        }
        clearTimeout(this.watchdog);
        this.watchdog = this.arm();
        this.ws.send(JSON.stringify({ ...heartbeat.data, type: "pong" }));
      } else {
        if (!frontendServerFrameSchema.safeParse(value).success) {
          this.fail("Invalid network server frame");
          return;
        }
        this.emit("data", `${event.data}\n`);
      }
    });
    this.ws.addEventListener("error", () =>
      this.fail("Secure connection failed; check endpoint, TLS trust and device credential"),
    );
    this.ws.addEventListener("close", (event) => {
      if (!this.destroyed)
        this.fail(`Network call ended (code ${event.code}); reconnect explicitly`);
    });
  }
  private arm() {
    return setTimeout(
      () => this.fail("Server heartbeat lost; call closed"),
      HEARTBEAT_INTERVAL_MS + HEARTBEAT_TIMEOUT_MS,
    );
  }
  private fail(message: string): void {
    if (!this.destroyed) this.emit("error", new Error(message));
    this.destroy();
  }
  get writableLength(): number {
    return this.ws.bufferedAmount;
  }
  setEncoding(_encoding: string): void {}
  write(data: string): void {
    if (this.destroyed) return;
    if (
      this.ws.readyState !== WebSocket.OPEN ||
      Buffer.byteLength(data) > MAX_NETWORK_FRAME_BYTES ||
      this.ws.bufferedAmount > MAX_NETWORK_FRAME_BYTES
    ) {
      this.fail("Network server not reading input");
      return;
    }
    this.ws.send(data.trimEnd());
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.watchdog);
    this.ws.close();
    const timer = setTimeout(() => this.ws.terminate(), 1000);
    timer.unref();
    queueMicrotask(() => this.emit("close"));
  }
}
