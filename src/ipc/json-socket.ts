import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Socket } from "bun";
import { z } from "zod";

const requestSchema = z
  .object({
    v: z.number().int(),
    type: z.literal("request"),
    id: z.string().min(1).max(128),
    method: z.string().min(1).max(128),
    params: z.unknown().optional(),
  })
  .strict();
export type SocketRequest = z.infer<typeof requestSchema>;
export interface JsonPeer {
  id: number;
  send(frame: unknown): void;
  close(): void;
}
export interface JsonSocketOptions {
  version: number;
  handle(request: SocketRequest, peer: JsonPeer): void | Promise<void>;
  closed?(peer: JsonPeer): void;
}

const MAX_FRAME_BYTES = 1 << 20;
const MAX_PENDING = 128;
const MAX_OUTGOING_BYTES = 4 * 1024 * 1024;

type State = {
  id: number;
  partial: string;
  decoder: TextDecoder;
  pending: number;
  outgoing: Uint8Array[];
  outgoingBytes: number;
  peer: JsonPeer;
};

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error(`control directory is not private: ${path}`);
  chmodSync(path, 0o700);
}

function socketAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    let peer: Socket | undefined;
    let finished = false;
    const finish = (answers: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      peer?.terminate();
      resolve(answers);
    };
    const timer = setTimeout(() => finish(true), 500);
    void Bun.connect({
      unix: path,
      socket: {
        data: () => {},
        open: (socket) => {
          peer = socket;
          if (finished) socket.terminate();
          else finish(true);
        },
        error: () => finish(false),
        close: () => finish(false),
      },
    }).catch(() => finish(false));
  });
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** An atomic, stale-aware local ownership guard for probe/unlink/bind. */
class SocketOwner {
  private readonly path: string;
  private held = false;

  constructor(socketPath: string) {
    this.path = `${socketPath}.lock`;
  }

  acquire(): void {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.path, "wx", 0o600);
        try {
          writeFileSync(fd, `${process.pid}\n`, "utf8");
        } finally {
          closeSync(fd);
        }
        this.held = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = Number.parseInt(readFileSync(this.path, "utf8"), 10);
        if (Number.isInteger(owner) && owner > 0) {
          try {
            process.kill(owner, 0);
            throw new Error(`another AgentVoice controller owns ${this.path}`);
          } catch (probe) {
            if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
          }
        }
        removeIfPresent(this.path);
      }
    }
    throw new Error(`could not acquire control socket ownership for ${this.path}`);
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    removeIfPresent(this.path);
  }
}

/** Shared private NDJSON framing and bounded writes; each endpoint owns its methods. */
export class JsonSocketServer {
  private server: ReturnType<typeof Bun.listen<State>> | null = null;
  private readonly clients = new Map<number, Socket<State>>();
  private nextId = 1;
  private readonly owner: SocketOwner;

  constructor(
    readonly path: string,
    private readonly options: JsonSocketOptions,
  ) {
    this.owner = new SocketOwner(path);
  }

  async start(): Promise<void> {
    if (this.server) return;
    privateDirectory(dirname(this.path));
    this.owner.acquire();
    let bound = false;
    try {
      try {
        const info = lstatSync(this.path);
        if (
          !info.isSocket() ||
          info.isSymbolicLink() ||
          info.uid !== process.getuid?.() ||
          (info.mode & 0o077) !== 0
        )
          throw new Error(`unsafe Unix socket path: ${this.path}`);
        if (await socketAnswers(this.path))
          throw new Error(`another AgentVoice controller answers at ${this.path}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      removeIfPresent(this.path);
      this.server = Bun.listen<State>({
        unix: this.path,
        socket: {
          open: (socket) => this.open(socket),
          data: (socket, data) => this.data(socket, data),
          drain: (socket) => this.flush(socket),
          close: (socket) => this.forget(socket),
          error: (socket) => this.forget(socket),
        },
      });
      bound = true;
      chmodSync(this.path, 0o600);
    } catch (error) {
      this.server?.stop(true);
      this.server = null;
      if (bound) removeIfPresent(this.path);
      this.owner.release();
      throw error;
    }
  }

  close(): void {
    if (!this.server) return;
    this.server.stop(true);
    this.server = null;
    for (const socket of [...this.clients.values()]) {
      socket.terminate();
      this.forget(socket);
    }
    this.clients.clear();
    removeIfPresent(this.path);
    this.owner.release();
  }

  private open(socket: Socket<State>): void {
    if (this.clients.size >= 128) {
      socket.terminate();
      return;
    }
    const state: State = {
      id: this.nextId++,
      partial: "",
      decoder: new TextDecoder(),
      pending: 0,
      outgoing: [],
      outgoingBytes: 0,
      peer: {
        id: this.nextId - 1,
        send: (frame) => this.send(socket, frame),
        close: () => {
          socket.terminate();
          this.forget(socket);
        },
      },
    };
    socket.data = state;
    this.clients.set(state.id, socket);
  }

  private forget(socket: Socket<State>): void {
    if (!socket.data || !this.clients.has(socket.data.id)) return;
    this.options.closed?.(socket.data.peer);
    socket.data.partial = "";
    socket.data.outgoing = [];
    socket.data.outgoingBytes = 0;
    this.clients.delete(socket.data.id);
  }

  private data(socket: Socket<State>, chunk: Buffer): void {
    const state = socket.data;
    if (!state || !this.clients.has(state.id)) return;
    state.partial += state.decoder.decode(chunk, { stream: true });
    for (;;) {
      const index = state.partial.indexOf("\n");
      if (index < 0) {
        if (Buffer.byteLength(state.partial) > MAX_FRAME_BYTES) {
          this.failure(socket, null, "invalid_request", "frame exceeds 1 MiB");
          state.peer.close();
        }
        return;
      }
      const line = state.partial.slice(0, index);
      state.partial = state.partial.slice(index + 1);
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
        this.failure(socket, null, "invalid_request", "frame exceeds 1 MiB");
        state.peer.close();
        return;
      }
      if (!line.trim()) continue;
      if (state.pending >= MAX_PENDING) {
        socket.terminate();
        this.forget(socket);
        return;
      }
      state.pending += 1;
      void this.handle(socket, line).finally(() => {
        state.pending -= 1;
      });
    }
  }

  private async handle(socket: Socket<State>, line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.failure(socket, null, "invalid_request", "expected one JSON object per line");
      return;
    }
    const checked = requestSchema.safeParse(parsed);
    if (!checked.success || checked.data.v !== this.options.version) {
      const rawId = (parsed as { id?: unknown } | null)?.id;
      const id = typeof rawId === "string" && rawId.length <= 128 ? rawId : null;
      this.failure(socket, id, "invalid_request", "invalid socket request");
      return;
    }
    try {
      await this.options.handle(checked.data, socket.data.peer);
    } catch {
      this.failure(socket, checked.data.id, "internal_error", "request failed");
    }
  }

  private failure(socket: Socket<State>, id: string | null, code: string, message: string) {
    this.send(socket, {
      v: this.options.version,
      type: "response",
      id,
      ok: false,
      error: { code, message },
    });
  }

  private send(socket: Socket<State>, response: unknown): void {
    const state = socket.data;
    if (!state || !this.clients.has(state.id)) return;
    const data = new TextEncoder().encode(`${JSON.stringify(response)}\n`);
    if (state.outgoingBytes + data.byteLength > MAX_OUTGOING_BYTES) {
      socket.terminate();
      this.forget(socket);
      return;
    }
    state.outgoing.push(data);
    state.outgoingBytes += data.byteLength;
    this.flush(socket);
  }

  private flush(socket: Socket<State>): void {
    const state = socket.data;
    if (!state || !this.clients.has(state.id)) return;
    while (state.outgoing.length) {
      const data = state.outgoing[0]!;
      let written: number;
      try {
        written = socket.write(data);
      } catch {
        socket.terminate();
        this.forget(socket);
        return;
      }
      if (written < 0) {
        socket.terminate();
        this.forget(socket);
        return;
      }
      state.outgoingBytes -= written;
      if (written < data.byteLength) {
        state.outgoing[0] = data.subarray(written);
        return;
      }
      state.outgoing.shift();
    }
  }
}
