/** Foreground coordination: one owned Codex child and workspace-local native history. */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateDirectory } from "../paths.ts";
import {
  type AccountSelection,
  accountsDirectory,
  balancerCliPresent,
  discoverProfiles,
  listPoolAccounts,
  maxUsedPercent,
  onboardingFailureMessage,
  reconcileFarm,
  runBalancerCommand,
  selectAccount,
} from "./accounts.ts";
import {
  AppServerConnection,
  AppServerError,
  type AttachOptions,
  appServerArgv,
} from "./attach.ts";
import { PROMPT_FILES, promptFilenames, readPrompts, type ServerConfig } from "./config.ts";
import { ConfigWatcher, configWithVoiceName, type WatchedConfigSource } from "./config-watch.ts";
import { confirmFullAccess, FullAccessError } from "./full-access.ts";
import { ORCHESTRATOR_THREAD_SOURCE, realtimeParams, threadParams } from "./params.ts";
import { ServiceTierSelection, type TierObservation } from "./service-tier.ts";
import { VoiceSessionManager } from "./session.ts";
import { lockThread } from "./thread-lock.ts";
import { type SessionSelection, selectThread } from "./thread-selection.ts";
import type { ReadyInfo } from "./voice-types.ts";

export type { ReadyInfo } from "./voice-types.ts";

export interface RuntimeEvents {
  onReady(info: ReadyInfo): void;
  onAnswer(sdp: string): void;
  onClosed(reason?: string): void;
  onRedial(reason: string): void;
  onError(message: string, fatal: boolean): void;
  onFatal(message: string): void;
  onStatus(line: string): void;
  debug?(line: string): void;
}

export type RuntimeConnection = Pick<AppServerConnection, "request" | "close" | "alive">;
export interface RuntimeOptions extends SessionSelection {
  /** Launch-only tier override; omitted preserves native configuration. */
  fast?: boolean;
  configSource?: WatchedConfigSource;
  /** Dependency boundaries for protocol and lifecycle tests; never CLI options. */
  connect?: (options: AttachOptions) => Promise<RuntimeConnection>;
  locksDir?: string;
  pickAccount?: () => Promise<AccountSelection>;
}

export class VoiceRuntime {
  private attachment: RuntimeConnection | null = null;
  private threadId: string | null = null;
  private threadReady = false;
  private prompts: Awaited<ReturnType<typeof readPrompts>> = {};
  private foundPrompts: string[] = [];
  private activeVoiceName: string | undefined;
  private activeAccount: string | null = null;
  private exhaustedPercent: number | null = null;
  private rotating = false;
  private rotationPromise: Promise<void> | null = null;
  private freshInFlight = false;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private readonly abort = new AbortController();
  private readonly locks = new Map<string, () => void>();
  private readonly activeTurns = new Map<string, string>();
  private readonly sessions: VoiceSessionManager;
  private configWatcher: ConfigWatcher | null = null;
  private tierSelection: ServiceTierSelection | null = null;
  private tier: TierObservation = {};

  constructor(
    private readonly config: ServerConfig,
    private readonly version: string,
    private readonly events: RuntimeEvents,
    private readonly options: RuntimeOptions = {},
  ) {
    this.activeVoiceName = config.voice.name;
    this.sessions = new VoiceSessionManager({
      sendAnswer: (sdp) => this.events.onAnswer(sdp),
      sendClosed: (reason) => this.events.onClosed(reason),
      sendFailed: (message) => this.events.onError(message, true),
      sendReady: () => this.emitReady(),
      startRealtime: async (sessionId, sdp) => {
        const connection = this.attachment;
        const threadId = this.threadId;
        if (!connection || !threadId || this.shuttingDown)
          throw new AppServerError("Codex is not ready");
        await connection.request(
          "thread/realtime/start",
          realtimeParams(
            configWithVoiceName(this.config, this.activeVoiceName),
            this.prompts,
            threadId,
            sessionId,
            sdp,
          ),
        );
      },
      stopRealtime: async () => {
        const connection = this.attachment;
        const threadId = this.threadId;
        if (connection && threadId)
          await connection.request("thread/realtime/stop", { threadId }, 1_000);
      },
      debug: (line) => this.events.debug?.(line),
    });
  }

  get currentReady(): ReadyInfo | null {
    if (!this.threadReady || !this.threadId || this.shuttingDown) return null;
    return {
      threadId: this.threadId,
      workspace: this.config.orchestrator.workspace,
      ...this.tier,
      model: this.tier.model ?? this.config.orchestrator.model ?? null,
      effort: this.config.orchestrator.effort ?? null,
      voiceModel: this.config.voice.model ?? null,
      voice: this.activeVoiceName ?? null,
      prompts: this.foundPrompts,
    };
  }

  async start(): Promise<void> {
    try {
      const workspace = this.config.orchestrator.workspace;
      if (!statSync(workspace).isDirectory())
        throw new Error(`Workspace is not a directory: ${workspace}`);
      // The launch resolver canonicalizes once; do not silently retarget here.
      if (realpathSync(workspace) !== workspace)
        throw new Error("Workspace must be a canonical absolute directory");
      this.prompts = await readPrompts(this.config.configDir);
      // Pure preflight: these placeholder IDs/SDP never leave this process.
      // Reject known option conflicts before spawning Codex or resuming history.
      realtimeParams(this.config, this.prompts, "", "", "");
      this.foundPrompts = promptFilenames(this.prompts);
      if (this.prompts.orchestratorBaseInstructions !== undefined) {
        this.events.onStatus(
          `warning: ${PROMPT_FILES.orchestratorBaseInstructions} replaces Codex's entire system prompt`,
        );
      }
      if (this.config.accounts.balance && !this.options.pickAccount && balancerCliPresent()) {
        if (!discoverProfiles(accountsDirectory(process.env, homedir())).some((p) => p.identity)) {
          throw new Error(
            onboardingFailureMessage(
              await listPoolAccounts((argv, ms) => runBalancerCommand(argv, ms, this.abort.signal)),
            ),
          );
        }
      }
      await this.openConnection(await this.pickAccount());
      const connection = this.requireConnection();
      const id = await selectThread(
        (method, params) => connection.request(method, params),
        workspace,
        this.options,
      );
      this.assertRunning();
      this.threadId = id ? await this.resumeThread(id) : await this.startThread();
      this.threadReady = true;
      this.emitReady();
      if (this.options.configSource) {
        this.configWatcher = new ConfigWatcher(this.options.configSource, this.config, {
          voiceNameChanged: (name) => {
            if (this.shuttingDown) return;
            this.activeVoiceName = name;
            this.events.onStatus(`voice changed to ${name ?? "upstream default"}`);
            this.emitReady();
            if (this.sessions.hasSession) this.events.onRedial("voice-name-changed");
          },
          rejected: (error) => this.events.onStatus(`config change ignored: ${String(error)}`),
        });
        this.configWatcher.start();
        void this.configWatcher.reload();
      }
    } catch (error) {
      await this.shutdown();
      throw error;
    }
  }

  offer(sdp: string): void {
    if (!this.threadReady || this.shuttingDown || this.rotating) return;
    this.sessions.handleOffer(sdp);
  }

  async fresh(): Promise<void> {
    if (!this.threadReady || this.freshInFlight || this.rotating || this.shuttingDown) return;
    this.freshInFlight = true;
    this.threadReady = false;
    try {
      // Cut media before changing identity; no old audio or SDP enters the new conversation.
      this.events.onClosed("fresh-thread");
      await this.sessions.shutdown();
      this.sessions.reset();
      this.assertRunning();
      this.threadId = await this.startThread();
      this.events.onStatus(`new conversation: ${this.threadId}`);
    } catch (error) {
      if (error instanceof FullAccessError) {
        this.events.onFatal(error.message);
        await this.shutdown();
      } else if (!this.shuttingDown)
        this.events.onError(`fresh conversation failed: ${String(error)}`, false);
    } finally {
      this.freshInFlight = false;
      this.threadReady =
        !this.shuttingDown && this.threadId !== null && this.attachment?.alive === true;
      this.emitReady();
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.threadReady = false;
    this.configWatcher?.stop();
    this.shutdownPromise = (async () => {
      try {
        await this.sessions.shutdown();
        const connection = this.attachment;
        if (connection) {
          await Promise.allSettled(
            [...this.activeTurns].map(([threadId, turnId]) =>
              connection.request("turn/interrupt", { threadId, turnId }, 500),
            ),
          );
        }
      } finally {
        this.abort.abort();
        await this.attachment?.close();
        // Rotation may own an old child that is no longer the attachment,
        // or a new child still initializing. Do not exit before it is reaped.
        await this.rotationPromise;
        this.attachment = null;
        this.sessions.reset();
        for (const release of this.locks.values()) release();
        this.locks.clear();
      }
    })();
    return this.shutdownPromise;
  }

  private assertRunning(): void {
    if (this.shuttingDown) throw new Error("AgentVoice is shutting down");
  }

  private requireConnection(): RuntimeConnection {
    this.assertRunning();
    if (!this.attachment?.alive) throw new AppServerError("Codex connection is closed");
    return this.attachment;
  }

  private acquire(id: string): void {
    if (this.locks.has(id)) return;
    const directory =
      this.options.locksDir ?? join(stateDirectory(process.env, homedir()), "thread-locks");
    this.locks.set(id, lockThread(directory, id));
  }

  private async startThread(): Promise<string> {
    const selection = this.tierSelection!;
    const params = await selection.prepare(threadParams(this.config, this.prompts, "start"));
    const result = await this.requireConnection().request("thread/start", params);
    this.assertRunning();
    const id = extractThreadId(result);
    this.acquire(id);
    confirmFullAccess(result);
    const tier = await selection.confirm(result, params);
    this.assertRunning();
    this.tier = tier;
    return id;
  }

  private async resumeThread(id: string): Promise<string> {
    this.acquire(id);
    const connection = this.requireConnection();
    const read = await connection.request<{
      thread?: {
        id?: string;
        cwd?: string;
        threadSource?: string;
        parentThreadId?: string | null;
        ephemeral?: boolean;
        model?: string | null;
        modelProvider?: string;
      };
    }>("thread/read", { threadId: id });
    this.assertRunning();
    if (
      read.thread?.id !== id ||
      read.thread.cwd !== this.config.orchestrator.workspace ||
      read.thread.threadSource !== ORCHESTRATOR_THREAD_SOURCE ||
      read.thread.parentThreadId ||
      read.thread.ephemeral
    ) {
      throw new Error(`Conversation ${id} no longer matches this AgentVoice workspace`);
    }
    const selection = this.tierSelection!;
    const params = await selection.prepare(
      {
        ...threadParams(this.config, this.prompts, "resume"),
        threadId: id,
        excludeTurns: true,
      },
      read.thread,
    );
    this.assertRunning();
    const result = await connection.request("thread/resume", params);
    this.assertRunning();
    if (extractThreadId(result) !== id) throw new Error("Codex resumed a different conversation");
    confirmFullAccess(result);
    const tier = await selection.confirm(result, params);
    this.assertRunning();
    this.tier = tier;
    this.events.onStatus(`continued conversation: ${id}`);
    return id;
  }

  private emitReady(): void {
    const info = this.currentReady;
    if (info) this.events.onReady(info);
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (this.shuttingDown) return;
    const id = params["threadId"];
    const turn = (params["turn"] ?? {}) as Record<string, unknown>;
    if (typeof id === "string") {
      if (method === "turn/started" && typeof turn["id"] === "string")
        this.activeTurns.set(id, turn["id"]);
      if (method === "turn/completed") this.activeTurns.delete(id);
      if (id === this.threadId && method.startsWith("thread/realtime/"))
        this.sessions.handleNotification(method, params);
      if (method === "thread/settings/updated" && this.locks.has(id)) {
        const settings = params["threadSettings"] as Record<string, unknown> | undefined;
        try {
          confirmFullAccess(settings, true);
        } catch (error) {
          this.threadReady = false;
          this.events.onFatal(String(error));
          void this.shutdown();
          return;
        }
        if (settings && id === this.threadId) {
          if (typeof settings["model"] === "string") this.tier.model = settings["model"];
          if (typeof settings["serviceTier"] === "string" || settings["serviceTier"] === null)
            this.tier.serviceTier = settings["serviceTier"] as string | null;
          this.emitReady();
        }
      }
    }
    if (method === "account/rateLimits/updated" && this.config.accounts.balance) {
      const used = maxUsedPercent(params);
      this.exhaustedPercent =
        used !== null && used >= this.config.accounts.switchThreshold ? used : null;
    }
    this.maybeRotate();
  }

  private async pickAccount(): Promise<AccountSelection> {
    this.assertRunning();
    if (!this.config.accounts.balance) return { kind: "canonical", reason: "balancing disabled" };
    if (this.options.pickAccount) return this.options.pickAccount();
    return selectAccount(discoverProfiles(accountsDirectory(process.env, homedir())), (argv, ms) =>
      runBalancerCommand(argv, ms, this.abort.signal),
    );
  }

  private async openConnection(selection: AccountSelection): Promise<void> {
    this.assertRunning();
    const env = { ...process.env };
    if (selection.kind === "profile") {
      reconcileFarm(
        env["CODEX_HOME"] ?? join(homedir(), ".codex"),
        selection.profile.directory,
        (line) => this.events.onStatus(line),
      );
      env["CODEX_HOME"] = selection.profile.directory;
    }
    let connection: RuntimeConnection | null = null;
    connection = await (this.options.connect ?? AppServerConnection.connect)({
      argv: appServerArgv(this.config.codex),
      cwd: this.config.orchestrator.workspace,
      env,
      signal: this.abort.signal,
      clientVersion: this.version,
      onNotification: (method, params) => this.handleNotification(method, params),
      onRefusal: (message) => this.events.onError(message, false),
      onClose: (info) => {
        if (this.shuttingDown || this.attachment !== connection || info.expected) return;
        this.threadReady = false;
        this.sessions.reset();
        this.events.onFatal(info.error ?? "Codex connection closed");
      },
      debug: (line) => this.events.debug?.(line),
    });
    if (this.shuttingDown || !connection.alive) {
      await connection.close();
      throw new Error("Codex stopped during startup");
    }
    this.attachment = connection;
    this.tierSelection = new ServiceTierSelection(
      (method, params) => {
        this.assertRunning();
        return connection!.request(method, params);
      },
      this.config.orchestrator.workspace,
      this.options.fast,
    );
    this.activeAccount = selection.kind === "profile" ? selection.email : null;
    this.exhaustedPercent = null;
  }

  private idle(): boolean {
    return (
      !this.shuttingDown &&
      !this.freshInFlight &&
      this.threadReady &&
      !this.sessions.hasSession &&
      this.activeTurns.size === 0
    );
  }

  private maybeRotate(): void {
    if (
      !this.config.accounts.balance ||
      this.exhaustedPercent === null ||
      this.rotating ||
      !this.idle()
    )
      return;
    this.rotating = true;
    this.rotationPromise = (async () => {
      try {
        const selection = await this.pickAccount();
        if (!this.idle()) return;
        if (selection.kind === "canonical" || selection.email === this.activeAccount) {
          this.exhaustedPercent = null;
          return;
        }
        this.threadReady = false;
        const old = this.attachment;
        this.attachment = null;
        await old?.close();
        await this.openConnection(selection);
        if (this.threadId) await this.resumeThread(this.threadId);
        this.threadReady = true;
        this.events.onStatus(`rotated to ${selection.email}`);
        this.rotating = false;
        this.emitReady();
      } catch (error) {
        if (!this.shuttingDown) this.events.onFatal(`account rotation failed: ${String(error)}`);
      } finally {
        this.rotating = false;
      }
    })();
  }
}

function extractThreadId(result: unknown): string {
  const shape = result as { thread?: { id?: string }; threadId?: string };
  const id = shape?.thread?.id ?? shape?.threadId;
  if (typeof id !== "string" || !id) throw new AppServerError("app-server returned no thread id");
  return id;
}
