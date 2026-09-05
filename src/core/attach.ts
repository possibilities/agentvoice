/** Native JSONL transport to the Codex child owned by this launch. */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 1_000;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export class AppServerError extends Error {
  readonly code?: number;
  readonly timedOut: boolean;
  constructor(message: string, code?: number, timedOut = false) {
    super(message);
    this.code = code;
    this.timedOut = timedOut;
  }
}

/**
 * Fail-closed answers for approval-bearing server→client requests. The console
 * runs unattended, so an unanswered request would park the agent turn forever;
 * Requests without a native refusal shape receive a JSON-RPC error, not an
 * empty success or fabricated answers to a tool's questions.
 */
export function buildDenialResponse(method: string): Record<string, unknown> | null {
  switch (method) {
    case "execCommandApproval":
    case "applyPatchApproval":
      return {
        decision: {
          denied: { rejection: "agentvoice runs unattended and never approves" },
        },
      };
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn" };
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null };
    default:
      return null;
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: AppServerError): void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export interface AttachOptions {
  argv: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  clientVersion: string;
  onNotification(method: string, params: Record<string, unknown>): void;
  onClose(info: { expected: boolean; error?: string }): void;
  onRefusal?(message: string): void;
  debug?(line: string): void;
}

export function appServerArgv(codex: string): string[] {
  return [codex, "app-server", "--enable", "realtime_conversation", "--listen", "stdio://"];
}

export class AppServerConnection {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private buffered = "";
  private exited: Promise<void> = Promise.resolve();
  private reaped = false;

  private constructor(private readonly options: AttachOptions) {}

  static async connect(options: AttachOptions): Promise<AppServerConnection> {
    const connection = new AppServerConnection(options);
    const abort = () => {
      void connection.close();
    };
    try {
      if (options.signal?.aborted) throw new AppServerError("Codex startup cancelled");
      connection.open();
      options.signal?.addEventListener("abort", abort, { once: true });
      await connection.request("initialize", {
        clientInfo: { name: "agentvoice", title: "AgentVoice", version: options.clientVersion },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      connection.notify("initialized", {});
      return connection;
    } catch (error) {
      await connection.close();
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }

  get alive(): boolean {
    return this.child !== null && !this.closed && !this.closing;
  }
  get pid(): number | undefined {
    return this.child?.pid;
  }

  private open(): void {
    const [bin, ...args] = this.options.argv;
    if (!bin) throw new AppServerError("no Codex executable configured");
    const child = spawn(bin, args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.child = child;
    this.exited = new Promise<void>((resolve) => {
      child.once("exit", (code, signal) => {
        this.signalGroup("SIGKILL");
        this.reaped = true;
        this.finish(this.closing, this.closing ? undefined : `Codex exited (${signal ?? code})`);
        resolve();
      });
      child.once("error", (error) => {
        this.reaped = true;
        this.finish(false, `could not start Codex: ${error.message}`);
        resolve();
      });
    });
    child.stdin.on("error", (error) => this.fail(`Codex stdin: ${error.message}`));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleData(chunk));
    child.stdout.on("end", () => {
      if (!this.closing && !this.closed) this.fail("Codex stdout closed");
    });
    child.stdout.on("error", (error) => this.fail(error.message));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) =>
      this.options.debug?.(`codex stderr: ${chunk.trimEnd()}`),
    );
    child.stderr.on("error", (error) => this.options.debug?.(`Codex stderr: ${error.message}`));
  }

  request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.alive)
      return Promise.reject(new AppServerError(`${method}: not attached to the app-server`));
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerError(`${method} timed out after ${timeoutMs}ms`, undefined, true));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, method });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new AppServerError(String(error)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    // Publish the promise before onClose can re-enter close().
    this.closePromise = Promise.resolve().then(async () => {
      this.finish(true);
      this.child?.stdin.end();
      await this.waitForExit(CLOSE_GRACE_MS);
      this.signalGroup("SIGTERM");
      await this.waitForExit(CLOSE_GRACE_MS);
      this.signalGroup("SIGKILL");
      await this.waitForExit(CLOSE_GRACE_MS);
      this.child?.stdout.destroy();
      this.child?.stderr.destroy();
    });
    return this.closePromise;
  }

  private async waitForExit(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
    clearTimeout(timer);
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (!pid || this.reaped) return;
    try {
      process.kill(-pid, signal);
    } catch {
      /* already reaped */
    }
  }

  private send(message: Record<string, unknown>): void {
    if (!this.alive || !this.child) throw new AppServerError("Codex connection is closed");
    const text = JSON.stringify(message);
    this.options.debug?.(`-> ${text}`);
    // Writable owns buffering/backpressure; a false return is not a partial write.
    this.child.stdin.write(`${text}\n`);
  }

  private handleData(chunk: string): void {
    if (this.closed) return;
    this.buffered += chunk;
    for (;;) {
      const newline = this.buffered.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
        this.fail("Codex frame exceeds 32 MiB");
        return;
      }
      try {
        this.dispatchText(line);
      } catch (error) {
        this.fail(String(error));
        return;
      }
    }
    if (Buffer.byteLength(this.buffered) > MAX_FRAME_BYTES) this.fail("Codex frame exceeds 32 MiB");
  }

  private dispatchText(text: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      throw new AppServerError("Codex stdout contained invalid JSON");
    }
    if (typeof frame !== "object" || frame === null) return;
    const message = frame as Record<string, unknown>;
    this.options.debug?.(`<- ${text}`);
    const { id, method } = message;

    if (id !== undefined && method === undefined) {
      const pending = this.pending.get(id as number);
      if (!pending) return;
      this.pending.delete(id as number);
      clearTimeout(pending.timer);
      const error = message["error"] as { code?: number; message?: string } | undefined;
      if (error) {
        pending.reject(
          new AppServerError(
            `${pending.method}: ${error.message ?? "unknown app-server error"}`,
            error.code,
          ),
        );
      } else {
        pending.resolve(message["result"]);
      }
      return;
    }

    if (id !== undefined && typeof method === "string") {
      // This client supplies no tools or human-input UI. Refuse immediately
      // rather than leaving an unsupported server request parked indefinitely.
      const requestId = id as number | string;
      const params = (message["params"] ?? {}) as Record<string, unknown>;
      this.refuse(requestId, method, params);
      return;
    }

    if (typeof method === "string") {
      this.options.onNotification(method, (message["params"] ?? {}) as Record<string, unknown>);
    }
  }

  private respond(id: number | string, result: unknown): void {
    try {
      this.send({ jsonrpc: "2.0", id, result });
    } catch {
      // detached mid-answer; the request dies with the connection
    }
  }

  private refuse(id: number | string, method: string, params: Record<string, unknown>): void {
    const tool = params["tool"];
    const retired =
      method === "item/tool/call" &&
      (tool === "dispatch_worker" || tool === "check_workers" || tool === "cancel_worker");
    const message = retired
      ? `Refused ${tool}: AgentVoice's custom worker tools have been retired. This saved conversation may retain their definitions; use Fresh or --no-continue for a conversation without them. Native Codex tools and voice handoffs are unchanged; no work was started or cancelled.`
      : method === "item/tool/call"
        ? "Refused item/tool/call: AgentVoice does not implement client-defined dynamic tools. Use a Codex client that implements this tool."
        : `Refused ${method}: AgentVoice has no approval/input UI. Full access does not grant connector consent or answer tool questions. Use a supported Codex client for required interaction.`;
    const result = retired
      ? { success: false, contentItems: [{ type: "inputText", text: message }] }
      : buildDenialResponse(method);
    try {
      if (result !== null) this.respond(id, result);
      else this.send({ jsonrpc: "2.0", id, error: { code: -32601, message } });
    } catch {
      // The pending request dies with its connection.
    }
    try {
      this.options.onRefusal?.(message);
    } catch {
      this.options.debug?.("refusal notice callback failed");
    }
  }

  private fail(error: string): void {
    if (this.closing || this.closed) return;
    this.finish(false, error);
    void this.close();
  }

  private finish(expected: boolean, error?: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new AppServerError(`${pending.method}: ${error ?? "Codex connection closed"}`),
      );
    }
    this.pending.clear();
    this.options.onClose({ expected, ...(error !== undefined ? { error } : {}) });
  }
}
