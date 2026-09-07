/** Native WebSocket transport to the Codex child owned by this launch. */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { homedir } from "node:os";
import { stateDirectory } from "../paths.ts";
import { validateCodexConfig } from "./codex-config.ts";
import { nativeHumanRequest } from "./human-input.ts";
import { type NativeEndpoint, NativeListener } from "./native-listener.ts";
import { type OwnedProcessOutcome, OwnedProcessTree } from "./owned-processes.ts";

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 15_000;
const TERMINATE_GRACE_MS = 2_000;

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
 * Legacy v1 approvals have no supported TUI route. Current human requests stay
 * pending in native Codex; unsupported requests receive a refusal or RPC error.
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
  nativeStateDir?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  clientVersion: string;
  onSpawn?(pid: number): void;
  onReaped?(): void;
  shutdownGraceMs?: number;
  optOutNotificationMethods?: readonly string[];
  onNotification(method: string, params: Record<string, unknown>): void;
  onClose(info: { expected: boolean; error?: string }): void;
  onRefusal?(message: string): void;
  onInteraction?(message: string): void;
  debug?(line: string): void;
}

export function appServerArgv(codex: string, overrides: readonly string[] = []): string[] {
  validateCodexConfig(overrides);
  return [
    codex,
    "app-server",
    ...overrides.flatMap((entry) => ["-c", entry]),
    "--enable",
    "realtime_conversation",
    "--listen",
    "ws://127.0.0.1:0",
  ];
}

export class AppServerConnection {
  private child: ChildProcessWithoutNullStreams | null = null;
  private listener: NativeListener | undefined;
  get nativeEndpoint(): NativeEndpoint | undefined {
    return this.listener?.endpoint;
  }
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private exited: Promise<void> = Promise.resolve();
  private reaped = false;
  private ownedProcesses: OwnedProcessTree | null = null;
  shutdownForced = false;
  shutdownCleanup: OwnedProcessOutcome | null = null;

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
      await connection.listener!.connect(
        (text) => {
          try {
            connection.dispatchText(text);
          } catch (error) {
            connection.fail(
              error instanceof AppServerError ? error.message : "Invalid native WebSocket frame",
            );
          }
        },
        () => connection.fail("Native WebSocket closed"),
      );
      await connection.request("initialize", {
        clientInfo: { name: "agentvoice", title: "AgentVoice", version: options.clientVersion },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          ...(options.optOutNotificationMethods
            ? { optOutNotificationMethods: options.optOutNotificationMethods }
            : {}),
        },
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
    this.listener = new NativeListener(
      this.options.nativeStateDir ?? stateDirectory(process.env, homedir()),
    );
    const [bin, ...args] = this.listener.argv(this.options.argv);
    if (!bin) throw new AppServerError("no Codex executable configured");
    const child = spawn(bin, args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.child = child;
    if (child.pid) {
      this.ownedProcesses = new OwnedProcessTree(child.pid, { debug: this.options.debug });
      void this.ownedProcesses.snapshotNow().catch((error) => this.options.debug?.(String(error)));
      this.options.onSpawn?.(child.pid);
    }
    this.exited = new Promise<void>((resolve) => {
      child.once("exit", (code, signal) => {
        const expected = this.closing;
        this.reaped = true;
        this.options.onReaped?.();
        this.finish(expected, expected ? undefined : `Codex exited (${signal ?? code})`);
        resolve();
        if (!expected) void this.close().catch((error) => this.options.debug?.(String(error)));
      });
      child.once("error", (error) => {
        this.reaped = true;
        this.options.onReaped?.();
        this.finish(false, `could not start Codex: ${error.message}`);
        resolve();
      });
    });
    child.stdin.on("error", (error) => this.fail(`Codex stdin: ${error.message}`));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.listener!.observe(chunk));
    child.stdout.on("end", () => {
      if (!this.closing && !this.closed) this.fail("Codex stdout closed");
    });
    child.stdout.on("error", (error) => this.fail(error.message));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.listener?.observe(chunk);
    });
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
      let failure: unknown;
      let cleanup: OwnedProcessOutcome | undefined;
      try {
        await this.ownedProcesses?.snapshotNow();
        this.listener?.close();
        if (!this.reaped) this.child?.kill("SIGTERM");
        await this.waitForExit(this.options.shutdownGraceMs ?? CLOSE_GRACE_MS);
        cleanup = await this.ownedProcesses?.waitForCapturedExit(0);
        this.shutdownForced = !this.reaped || cleanup?.complete === false;
        if (!this.reaped || cleanup?.complete === false) {
          await this.ownedProcesses?.signalCaptured("SIGTERM");
          if (!this.reaped) this.child?.kill("SIGTERM");
          const [, outcome] = await Promise.all([
            this.waitForExit(TERMINATE_GRACE_MS),
            this.ownedProcesses?.waitForCapturedExit(TERMINATE_GRACE_MS),
          ]);
          cleanup = outcome;
        }
        if (!this.reaped || cleanup?.complete === false) {
          await this.ownedProcesses?.signalCaptured("SIGKILL");
          if (!this.reaped) this.child?.kill("SIGKILL");
          const [, outcome] = await Promise.all([
            this.waitForExit(TERMINATE_GRACE_MS),
            this.ownedProcesses?.waitForCapturedExit(TERMINATE_GRACE_MS),
          ]);
          cleanup = outcome;
        }
      } catch (error) {
        failure = error;
        this.shutdownForced = true;
        this.child?.stdin.destroy();
        if (!this.reaped) {
          this.child?.kill("SIGTERM");
          await this.waitForExit(TERMINATE_GRACE_MS);
        }
        if (!this.reaped) {
          this.child?.kill("SIGKILL");
          await this.waitForExit(TERMINATE_GRACE_MS);
        }
      } finally {
        this.shutdownCleanup = cleanup ?? null;
        this.ownedProcesses?.stopTracking();
        this.child?.stdout.destroy();
        this.child?.stderr.destroy();
        this.listener?.cleanup();
      }
      if (failure) throw failure;
      if (!this.reaped || cleanup?.complete === false) {
        const survivors = cleanup?.survivors.join(", ") || "none";
        const uncertain = cleanup?.uncertain.join(", ") || "none";
        throw new AppServerError(
          `Owned Codex process cleanup could not be verified (survivors: ${survivors}; uncertain: ${uncertain})`,
        );
      }
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

  private send(message: Record<string, unknown>): void {
    if (!this.alive || !this.child) throw new AppServerError("Codex connection is closed");
    const text = JSON.stringify(message);
    this.options.debug?.(`-> ${text}`);
    this.listener!.send(text);
  }

  private dispatchText(text: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      throw new AppServerError("Codex WebSocket contained invalid JSON");
    }
    if (typeof frame !== "object" || frame === null) return;
    const message = frame as Record<string, unknown>;
    const { id, method } = message;
    if (typeof method === "string" && method.startsWith("thread/realtime/item/"))
      this.options.debug?.(`<- ${method} [voice item content omitted]`);
    else this.options.debug?.(`<- ${text}`);

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
      // Native owns pending human requests and replays them when a TUI resumes.
      if (nativeHumanRequest(method)) {
        try {
          this.options.onInteraction?.(
            "Codex requested your input. Run agentvoice attach agent in this workspace to respond.",
          );
        } catch {
          this.options.debug?.("interaction notice callback failed");
        }
        return;
      }
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
      ? `Refused ${tool}: AgentVoice's custom worker tools have been retired. This saved conversation may retain their definitions; start a new call on an AgentVoice server launched without --continue/--resume for a conversation without them. Native Codex tools and voice handoffs are unchanged; no work was started or cancelled.`
      : method === "item/tool/call"
        ? "Refused item/tool/call: AgentVoice does not implement client-defined dynamic tools. Use a Codex client that implements this tool."
        : `Refused ${method}: AgentVoice does not support this client request. Use a Codex client that implements it.`;
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
    this.listener?.close(new AppServerError(error ?? "Codex connection closed"));
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
