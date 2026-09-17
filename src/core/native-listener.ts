import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function resolveNativeExecutable(binary: string, cwd: string): string {
  const found = binary.includes("/") ? resolve(cwd, binary) : Bun.which(binary, { cwd });
  if (!found) throw new Error("Configured Codex executable was not found");
  return realpathSync(found);
}

export type NativeEndpoint = { url: string; token: string };
const MAX_NATIVE_FRAME_BYTES = 32 * 1024 * 1024;

function responseIdFromPrefix(text: string): number | undefined {
  const match = text
    .slice(0, 1024)
    .match(/^\s*\{\s*(?:"jsonrpc"\s*:\s*"2\.0"\s*,\s*)?"id"\s*:\s*(\d+)\s*,/u);
  if (!match) return;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : undefined;
}

/** Runtime-private native listener. Only the guarded gateway receives its credential. */
export class NativeListener {
  private readonly directory: string;
  private readonly token = randomBytes(32).toString("base64url");
  private readonly listening = Promise.withResolvers<string>();
  private socket: WebSocket | undefined;
  private buffered = "";
  private endpointValue: NativeEndpoint | undefined;
  private closed = false;
  readonly tokenFile: string;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.directory = mkdtempSync(join(stateDir, "native-ws-"));
    this.tokenFile = join(this.directory, "token");
    try {
      writeFileSync(this.tokenFile, this.token, { mode: 0o600 });
    } catch (error) {
      rmSync(this.directory, { recursive: true, force: true });
      throw error;
    }
    void this.listening.promise.catch(() => {});
  }

  argv(argv: string[]): string[] {
    return [...argv, "--ws-auth", "capability-token", "--ws-token-file", this.tokenFile];
  }

  observe(chunk: string): void {
    this.buffered = (this.buffered + chunk).slice(-16_384);
    const match = this.buffered.match(/listening on:\s+(ws:\/\/127\.0\.0\.1:\d+)/);
    if (match) this.listening.resolve(match[1]!);
  }

  get endpoint(): NativeEndpoint | undefined {
    return this.endpointValue;
  }

  async connect(
    onText: (text: string) => void,
    onClose: (error: Error) => void,
    onOversizedResponse: (id: number, bytes: number) => boolean,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          const url = await this.listening.promise;
          if (this.closed) throw new Error("Native listener closed");
          const socket = new WebSocket(url, {
            headers: { Authorization: `Bearer ${this.token}` },
          });
          this.socket = socket;
          let transportFailure: Error | undefined;
          const fail = (error: Error) => {
            if (transportFailure) return;
            transportFailure = error;
            onClose(error);
          };
          socket.addEventListener("message", ({ data }) => {
            if (typeof data !== "string") {
              fail(new Error("Native WebSocket sent a binary frame"));
              socket.close(1003, "text frames required");
              return;
            }
            const bytes = Buffer.byteLength(data);
            if (bytes > MAX_NATIVE_FRAME_BYTES) {
              const id = responseIdFromPrefix(data);
              if (id !== undefined && onOversizedResponse(id, bytes)) return;
              fail(new Error(`Native WebSocket frame exceeded 32 MiB (${bytes} bytes)`));
              socket.close(1009, "frame too large");
              return;
            }
            onText(data);
          });
          socket.addEventListener("close", (event) => {
            fail(
              new Error(
                `Native WebSocket closed (code ${event.code}${event.wasClean ? ", clean" : ""})`,
              ),
            );
          });
          await new Promise<void>((resolve, reject) => {
            socket.addEventListener("open", () => resolve(), { once: true });
            socket.addEventListener("error", () => reject(new Error("Native WebSocket failed")), {
              once: true,
            });
            socket.addEventListener("close", () => reject(new Error("Native WebSocket closed")), {
              once: true,
            });
          });
          this.endpointValue = { url, token: this.token };
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Native listener startup timed out")), 10_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  send(text: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Native socket is closed");
    if (this.socket.bufferedAmount > MAX_NATIVE_FRAME_BYTES)
      throw new Error("Native socket is congested");
    this.socket.send(text);
  }

  close(error = new Error("Native listener closed")): void {
    this.closed = true;
    this.listening.reject(error);
    this.socket?.close();
    this.endpointValue = undefined;
  }

  cleanup(): void {
    this.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}
