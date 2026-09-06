import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttachOptions } from "../../src/core/attach.ts";
import { type ConfigValues, resolveConfig } from "../../src/core/config.ts";
import { ORCHESTRATOR_THREAD_SOURCE } from "../../src/core/params.ts";
import {
  type RuntimeConnection,
  type RuntimeEvents,
  type RuntimeOptions,
  VoiceRuntime,
} from "../../src/core/runtime.ts";
import type { NativeThread } from "../../src/core/thread-selection.ts";
import type { ReadyInfo } from "../../src/core/voice-types.ts";

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export class NativeStub implements RuntimeConnection {
  alive = true;
  closes = 0;
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  threads: NativeThread[] = [];
  /** Opt-in native tier protocol; existing lifecycle tests retain minimal responses. */
  tiers = false;
  nativeConfig: Record<string, unknown> = { model: "native-model", model_provider: "openai" };
  models: Record<string, unknown>[] = [
    { model: "native-model", isDefault: true, serviceTiers: [{ id: "priority", name: "Fast" }] },
    { model: "slow-model", serviceTiers: [] },
  ];
  options!: AttachOptions;
  override?: (method: string, params: Record<string, unknown>) => Promise<unknown> | undefined;
  private counter = 0;
  private turns = 0;

  connect = async (options: AttachOptions): Promise<RuntimeConnection> => {
    this.options = options;
    return this;
  };

  async request<T = unknown>(method: string, input: unknown): Promise<T> {
    const params = input as Record<string, unknown>;
    this.calls.push({ method, params });
    const overridden = this.override?.(method, params);
    if (overridden) return (await overridden) as T;
    let result: unknown = {};
    if (method === "config/read") result = { config: this.nativeConfig };
    if (method === "model/list") result = { data: this.models, nextCursor: null };
    if (method === "thread/list") result = { data: this.threads, nextCursor: null };
    if (method === "thread/start") {
      const thread = {
        id: `thread-${++this.counter}`,
        cwd: params["cwd"] as string,
        threadSource: params["threadSource"] as string,
      };
      this.threads.unshift(thread);
      result = { thread };
    }
    if (method === "thread/read" || method === "thread/resume")
      result = { thread: this.threads.find((t) => t.id === params["threadId"]) };
    if (method === "thread/start" || method === "thread/resume")
      result = { ...(result as object), ...nativeFullAccess };
    if (this.tiers && (method === "thread/start" || method === "thread/resume")) {
      const config = params["config"] as Record<string, unknown> | undefined;
      result = {
        ...(result as object),
        model: params["model"] ?? config?.["model"] ?? this.nativeConfig["model"],
        modelProvider: "openai",
        serviceTier: params["serviceTier"] ?? this.nativeConfig["service_tier"] ?? null,
      };
    }
    if (method === "turn/start") {
      const turn = { id: `turn-${++this.turns}`, status: "inProgress" };
      this.options.onNotification("turn/started", { threadId: params["threadId"], turn });
      result = { turn };
    }
    return result as T;
  }

  async close(): Promise<void> {
    this.alive = false;
    this.closes++;
  }

  main(id: string, cwd: string): void {
    this.threads.push({ id, cwd, threadSource: ORCHESTRATOR_THREAD_SOURCE });
  }
}

export const nativeFullAccess = {
  sandbox: { type: "dangerFullAccess" },
  approvalPolicy: "never",
  activePermissionProfile: { id: ":danger-full-access", extends: null },
};

export function runtimeHarness(values: ConfigValues = {}, options: RuntimeOptions = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "agentvoice-test-")));
  const config = resolveConfig({}, values, {}, directory, {
    configDir: directory,
    launchCwd: directory,
  });
  const native = new NativeStub();
  const ready: ReadyInfo[] = [];
  const fatal: string[] = [];
  const closed: (string | undefined)[] = [];
  const events: RuntimeEvents = {
    onReady: (info) => ready.push(info),
    onAnswer() {},
    onClosed: (reason) => closed.push(reason),
    onError() {},
    onFatal: (message) => fatal.push(message),
    onStatus() {},
  };
  const runtimeOptions = {
    connect: native.connect,
    locksDir: join(directory, "locks"),
    ...options,
  };
  const runtime = new VoiceRuntime(config, "test", events, runtimeOptions);
  return {
    directory,
    config,
    native,
    runtime,
    runtimeOptions,
    ready,
    fatal,
    closed,
    events,
    cleanup: async () => {
      await runtime.shutdown();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
