import { chmodSync, existsSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { z } from "zod";

const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 2_000;

export const liveKitTelemetryRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1).max(256),
    sequence: z.number().int().positive(),
    monotonicNs: z.string().regex(/^\d+$/),
    source: z.enum(["livekit", "fx"]),
    type: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();

export type LiveKitTelemetryRecord = z.infer<typeof liveKitTelemetryRecordSchema>;

export class LiveKitTelemetryClient {
  private sequence = 0;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      socketPath: string;
      runId: string;
      timeoutMs?: number;
    },
  ) {}

  emit(
    source: LiveKitTelemetryRecord["source"],
    type: string,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    const record = liveKitTelemetryRecordSchema.parse({
      schemaVersion: 1,
      runId: this.options.runId,
      sequence: ++this.sequence,
      monotonicNs: process.hrtime.bigint().toString(),
      source,
      type,
      data,
    });
    this.pending = this.pending.then(() =>
      sendRecord(this.options.socketPath, record, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    );
    return this.pending;
  }

  flush(): Promise<void> {
    return this.pending;
  }
}

export class LiveKitTelemetryServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private lastSequence = 0;

  constructor(
    private readonly options: {
      socketPath: string;
      runId: string;
      onRecord(record: LiveKitTelemetryRecord): void;
      onProtocolError?(error: Error): void;
    },
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    if (existsSync(this.options.socketPath)) rmSync(this.options.socketPath);
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(this.options.socketPath, () => {
        server.off("error", onError);
        chmodSync(this.options.socketPath, 0o600);
        resolvePromise();
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
    if (existsSync(this.options.socketPath)) rmSync(this.options.socketPath);
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.setTimeout(DEFAULT_TIMEOUT_MS);
    let bytes = Buffer.alloc(0);
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      this.sockets.delete(socket);
      if (error) {
        this.options.onProtocolError?.(error);
        socket.end(`error:${error.message}\n`);
      } else {
        socket.end("ok\n");
      }
    };
    socket.on("data", (chunk: Buffer) => {
      if (finished) return;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_RECORD_BYTES) {
        finish(new Error(`LiveKit telemetry record exceeds ${MAX_RECORD_BYTES} bytes`));
        return;
      }
      const newline = bytes.indexOf(0x0a);
      if (newline < 0) return;
      if (
        bytes
          .subarray(newline + 1)
          .toString("utf8")
          .trim().length > 0
      ) {
        finish(new Error("LiveKit telemetry connection carried more than one record"));
        return;
      }
      try {
        const record = liveKitTelemetryRecordSchema.parse(
          JSON.parse(bytes.subarray(0, newline).toString("utf8")),
        );
        if (record.runId !== this.options.runId) {
          throw new Error("LiveKit telemetry record came from another run");
        }
        if (record.sequence <= this.lastSequence) {
          throw new Error(
            `LiveKit telemetry sequence did not increase: ` +
              `${record.sequence} after ${this.lastSequence}`,
          );
        }
        this.lastSequence = record.sequence;
        this.options.onRecord(record);
        finish();
      } catch (error) {
        finish(asError(error));
      }
    });
    socket.on("timeout", () => finish(new Error("LiveKit telemetry sender timed out")));
    socket.on("error", (error) => {
      this.sockets.delete(socket);
      if (!finished) this.options.onProtocolError?.(error);
      finished = true;
    });
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("end", () => {
      if (!finished) finish(new Error("LiveKit telemetry record had no newline terminator"));
    });
  }
}

function sendRecord(
  socketPath: string,
  record: LiveKitTelemetryRecord,
  timeoutMs: number,
): Promise<void> {
  const payload = Buffer.from(`${JSON.stringify(record)}\n`);
  if (payload.length > MAX_RECORD_BYTES) {
    return Promise.reject(new Error(`LiveKit telemetry record exceeds ${MAX_RECORD_BYTES} bytes`));
  }
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ path: socketPath });
    let settled = false;
    let reply = "";
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolvePromise();
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => socket.end(payload));
    socket.on("data", (chunk: Buffer) => {
      reply += chunk.toString("utf8");
      if (reply.length > 4_096) {
        finish(new Error("LiveKit telemetry acknowledgement exceeded its bound"));
        return;
      }
      const newline = reply.indexOf("\n");
      if (newline < 0) return;
      const message = reply.slice(0, newline);
      if (message === "ok") finish();
      else finish(new Error(`LiveKit telemetry receiver rejected record: ${message}`));
    });
    socket.once("timeout", () => finish(new Error("LiveKit telemetry acknowledgement timed out")));
    socket.once("error", (error) => finish(error));
    socket.once("end", () => {
      if (!settled) finish(new Error("LiveKit telemetry receiver closed without acknowledging"));
    });
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
