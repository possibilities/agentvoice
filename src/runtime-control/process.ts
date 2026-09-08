/** Disposable Bun worker; inherited IPC and direct child ownership only. */
import { type ChildProcess, spawn } from "node:child_process";
import { OwnedProcessTree } from "../core/owned-processes.ts";
import { IPC_VERSION, type IpcMessage, ipcMessage } from "./protocol.ts";

export interface RuntimeProcess {
  readonly pid: number | undefined;
  readonly exited: Promise<void>;
  readonly nativePid: number | undefined;
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: unknown): void;
  stop(): Promise<boolean>;
}

export function spawnRuntimeProcess(
  generation: number,
  onEvent: (method: string, params: unknown) => void,
  onLease: (id: string) => Promise<void>,
  worker?: string,
): RuntimeProcess {
  const child = spawn(...runtimeWorkerCommand(generation, worker), {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    serialization: "json",
  });
  return new WorkerProcess(child, generation, onEvent, onLease);
}

export function runtimeWorkerCommand(
  generation: number,
  worker?: string,
  executable = process.execPath,
  moduleUrl = import.meta.url,
): [string, string[]] {
  if (worker) return [executable, [worker, String(generation)]];
  const main = new URL("../main.ts", moduleUrl).pathname;
  // A compiled Bun executable embeds module paths under /$bunfs; dispatch the
  // worker through the executable instead of trying to execute that virtual path.
  if (main.includes("$bunfs")) return [executable, ["__runtime-worker", String(generation)]];
  return [executable, [main, "__runtime-worker", String(generation)]];
}

class WorkerProcess implements RuntimeProcess {
  private next = 1;
  private dead = false;
  private forcedExit = false;
  private stopping: Promise<boolean> | undefined;
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private native: number | undefined;
  private outgoing = 0;
  private readonly owned: OwnedProcessTree | undefined;
  readonly exited: Promise<void>;
  get pid() {
    return this.child.pid;
  }
  get nativePid() {
    return this.native;
  }

  constructor(
    private readonly child: ChildProcess,
    private readonly generation: number,
    private readonly onEvent: (method: string, params: unknown) => void,
    private readonly onLease: (id: string) => Promise<void>,
  ) {
    // stderr is drained but not forwarded: inherited secrets may appear in dependency errors.
    child.stderr?.resume();
    this.owned = child.pid ? new OwnedProcessTree(child.pid) : undefined;
    void this.owned?.snapshotNow().catch(() => {});
    this.exited = new Promise((resolve) => {
      const finish = () => {
        if (this.dead) return;
        this.dead = true;
        this.forcedExit = !this.stopping || this.native !== undefined;
        for (const request of this.pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error("Runtime process exited"));
        }
        this.pending.clear();
        this.onEvent("exit", {});
        resolve();
        if (!this.stopping)
          void this.stop().catch((error) => this.onEvent("fatal", { message: String(error) }));
      };
      child.once("exit", finish);
      child.once("error", finish);
    });
    child.on("message", (value) => {
      if (!ipcMessage(value, generation)) {
        void this.stop();
        return;
      }
      if (value.method === "lease" && value.id) {
        const threadId = (value.params as { threadId?: unknown })?.threadId;
        const acquire =
          typeof threadId === "string" && threadId.length > 0
            ? this.onLease(threadId)
            : Promise.reject(new Error("Invalid lease request"));
        void acquire.then(
          () => this.send({ id: value.id, result: null }),
          (error) => this.send({ id: value.id, error: String(error) }),
        );
      } else if (value.method) {
        if (value.method === "native-pid") {
          const pid = (value.params as { pid?: number })?.pid;
          if (Number.isSafeInteger(pid) && pid! > 0) this.native = pid;
        }
        if (value.method === "native-reaped") this.native = undefined;
        this.onEvent(value.method, value.params);
      } else if (value.id) {
        const pending = this.pending.get(value.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(value.id);
        if (value.error) pending.reject(new Error(value.error));
        else pending.resolve(value.result);
      }
    });
  }

  private send(message: Omit<IpcMessage, "version" | "generation">): void {
    if (this.dead || !this.child.connected) return;
    if (this.outgoing >= 64) {
      this.child.kill("SIGTERM");
      return;
    }
    const frame = { ...message, version: IPC_VERSION, generation: this.generation };
    if (!ipcMessage(frame, this.generation)) {
      this.child.kill("SIGTERM");
      return;
    }
    this.outgoing++;
    try {
      this.child.send(frame, (error) => {
        this.outgoing--;
        if (error && !this.dead) this.child.kill("SIGTERM");
      });
    } catch {
      this.outgoing--;
      this.child.kill("SIGTERM");
    }
  }
  request<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.dead) return Promise.reject(new Error("Runtime process is not running"));
    if (this.pending.size >= 32)
      return Promise.reject(new Error("Runtime IPC request limit exceeded"));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Runtime ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.send({ id, method, params });
    });
  }
  notify(method: string, params?: unknown): void {
    this.send({ method, params });
  }
  stop(): Promise<boolean> {
    if (this.stopping) return this.stopping;
    const stopping = (async () => {
      try {
        let forced = this.forcedExit;
        let trackingError: unknown;
        try {
          await this.owned?.snapshotNow();
        } catch (error) {
          trackingError = error;
        }
        if (!this.dead) {
          try {
            const result = await this.request<{ forced: boolean }>("shutdown", {}, 24_000);
            forced = result.forced;
          } catch {
            forced = true;
          }
          if (!(await settlesWithin(this.exited, 1_000))) {
            forced = true;
            try {
              await this.owned?.signalCaptured("SIGTERM");
            } catch (error) {
              trackingError = error;
            }
            this.child.kill("SIGTERM");
            if (!(await settlesWithin(this.exited, 1_000))) {
              try {
                await this.owned?.signalCaptured("SIGKILL");
              } catch (error) {
                trackingError = error;
              }
              this.child.kill("SIGKILL");
            }
            if (!(await settlesWithin(this.exited, 1_000)))
              throw new Error("Runtime process could not be reaped");
          }
        }
        let cleanup = await this.owned?.waitForCapturedExit(0);
        if (cleanup && !cleanup.complete) {
          forced = true;
          await this.owned!.signalCaptured("SIGTERM");
          cleanup = await this.owned!.waitForCapturedExit(1_000);
        }
        if (cleanup && !cleanup.complete) {
          await this.owned!.signalCaptured("SIGKILL");
          cleanup = await this.owned!.waitForCapturedExit(1_000);
        }
        if (cleanup && !cleanup.complete)
          throw new Error(
            "Runtime-owned descendant cleanup could not be verified; replacement was stopped",
          );
        if (trackingError)
          throw new Error(`Runtime ownership snapshot failed: ${String(trackingError)}`);
        this.native = undefined;
        return forced;
      } finally {
        this.owned?.stopTracking();
      }
    })();
    this.stopping = stopping;
    void stopping.catch(() => {
      if (this.stopping === stopping) this.stopping = undefined;
    });
    return stopping;
  }
}

export async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
