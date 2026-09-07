import { lstatSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname } from "node:path";
import { safeAncestors } from "../private-files.ts";

export class SocketFailure extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** A bounded connection shared by the two versioned NDJSON control protocols. */
export class ControlSocket {
  private next = 0;
  private partial = "";
  private failure?: Error;
  private readonly ended = Promise.withResolvers<void>();
  readonly done = this.ended.promise;
  private readonly pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private constructor(
    private readonly socket: Socket,
    private readonly version: number,
    private readonly event: (frame: Record<string, unknown>) => void,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      try {
        this.partial += chunk;
        if (Buffer.byteLength(this.partial) > 4 * 1024 * 1024)
          throw new Error("Oversized socket frame");
        for (;;) {
          const newline = this.partial.indexOf("\n");
          if (newline < 0) break;
          const frame = JSON.parse(this.partial.slice(0, newline));
          this.partial = this.partial.slice(newline + 1);
          if (!frame || frame.v !== version) throw new Error("Incompatible socket protocol");
          if (frame.type !== "response") {
            this.event(frame);
            continue;
          }
          const pending = this.pending.get(frame.id);
          if (!pending) throw new Error("Uncorrelated socket response");
          this.pending.delete(frame.id);
          clearTimeout(pending.timer);
          if (frame.ok === true) pending.resolve(frame.result);
          else
            pending.reject(
              new SocketFailure(
                frame.error?.message ?? "Socket request refused",
                frame.error?.code,
              ),
            );
        }
      } catch (error) {
        this.close(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", (error) => this.close(error));
    socket.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(this.failure ?? new Error("Control socket disconnected"));
      }
      this.pending.clear();
      this.ended.resolve();
    });
  }
  static async connect(
    path: string,
    version: number,
    event: (frame: Record<string, unknown>) => void = () => {},
  ) {
    safeAncestors(dirname(path));
    const info = lstatSync(path);
    if (!info.isSocket() || info.uid !== process.getuid?.() || info.mode & 0o077)
      throw new Error("Unsafe control socket");
    const socket = createConnection({ path });
    const client = new ControlSocket(socket, version, event);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => client.close(new Error("Socket connection timed out")),
          3000,
        );
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("close", () => {
          clearTimeout(timer);
          reject(client.failure ?? new Error("Socket connection failed"));
        });
      });
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.socket.destroyed)
      return Promise.reject(this.failure ?? new Error("Control socket closed"));
    if (this.pending.size >= 32 || this.socket.writableLength > 64 * 1024) {
      this.close(new Error("Control socket write limit exceeded"));
      return Promise.reject(this.failure);
    }
    const id = String(++this.next);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.close(new Error(`Socket request timed out: ${method}`)),
        5000,
      );
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(
        `${JSON.stringify({ v: this.version, type: "request", id, method, ...(params === undefined ? {} : { params }) })}\n`,
      );
    });
  }
  error() {
    return this.failure;
  }
  close(error?: Error) {
    this.failure ??= error;
    this.socket.destroy();
  }
}
