/** Foreground coordination: one owned Codex child and workspace-local native history. */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AttachmentGateway, type AttachmentTicket } from "../attachment/gateway.ts";
import type { ThreadInventory } from "../events/contract.ts";
import {
  type ConversationNotification,
  type ConversationReadMethod,
  type ConversationReadParams,
  projectNotification,
} from "../events/conversation.ts";
import { nativeConversationSchemas } from "../events/conversation-native.ts";
import { nativeVoiceNotification, type VoiceNotification } from "../events/voice.ts";
import { stateDirectory } from "../paths.ts";
import {
  AppServerConnection,
  AppServerError,
  type AttachOptions,
  appServerArgv,
} from "./attach.ts";
import { type Prompts, readPrompts, type ServerConfig } from "./config.ts";
import {
  type ControlMcpRegistration,
  injectControlMcp,
  requireControlMcpReady,
} from "./control-mcp.ts";
import { ConversationReader } from "./conversation-reader.ts";
import { fullAccessStartupConfig } from "./full-access.ts";
import {
  type HandoffRequest,
  type HandoffResult,
  handoffFailure,
  handoffRequestSchema,
  handoffUnknown,
} from "./handoff.ts";
import { resolveNativeExecutable } from "./native-listener.ts";
import {
  ORCHESTRATOR_THREAD_SOURCE,
  passthroughWarnings,
  realtimeParams,
  threadParams,
} from "./params.ts";
import { type RoleAssets, readRoleAssets } from "./role.ts";
import { ServiceTierSelection, type TierObservation } from "./service-tier.ts";
import { VoiceSessionManager } from "./session.ts";
import { lockThread } from "./thread-lock.ts";
import { ThreadObserver } from "./thread-observer.ts";
import { type SessionSelection, selectThread } from "./thread-selection.ts";
import type { ReadyInfo } from "./voice-types.ts";

export type { ReadyInfo } from "./voice-types.ts";

// These streams have no runtime consumer. Debug launches retain them for diagnosis.
const UNUSED_STREAM_NOTIFICATIONS = [
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "turn/diff/updated",
  "turn/plan/updated",
  "thread/tokenUsage/updated",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "thread/realtime/outputAudio/delta",
] as const;

export interface RuntimeEvents {
  onReady(info: ReadyInfo): void;
  onAnswer(sdp: string): void;
  onClosed(reason?: string): void;
  onError(message: string, fatal: boolean): void;
  onFatal(message: string): void;
  onStatus(line: string): void;
  /** Non-fatal launch/config warnings; displayed without treating media as failed. */
  onWarning?(message: string): void;
  debug?(line: string): void;
}

export type RuntimeConnection = Pick<AppServerConnection, "request" | "close" | "alive"> & {
  readonly shutdownForced?: boolean;
  readonly nativeEndpoint?: import("./native-listener.ts").NativeEndpoint;
};
export interface RuntimeOptions extends SessionSelection {
  /** Launch-only tier override; omitted preserves native configuration. */
  fast?: boolean;
  nativeStateDir?: string;
  onAttachmentReady?: (issue: () => AttachmentTicket, revoke: () => void) => void;
  /** Dependency boundaries for protocol and lifecycle tests; never CLI options. */
  connect?: (options: AttachOptions) => Promise<RuntimeConnection>;
  locksDir?: string;
  /** Controller-held lease; retained after this generation exits. */
  acquireLease?: (threadId: string) => Promise<void>;
  /** Restart uses exact thread/read+resume, never history inventory selection. */
  exactResume?: string;
  snapshot?: RuntimeSnapshot;
  controlMcp?: ControlMcpRegistration;
  controlReadinessTimeoutMs?: number;
  onVerifiedThread?: (identity: { threadId: string; workspace: string }) => void;
  onChildPid?: (pid: number) => void;
  onChildReaped?: () => void;
  onThreads?: (inventory: ThreadInventory) => void;
  onVoice?: (notification: VoiceNotification) => void;
  onConversation?: (notification: ConversationNotification) => void;
  onShutdownOutcome?: (forced: boolean) => void;
}

export interface RuntimeSnapshot {
  prompts: Prompts;
  foundPrompts: string[];
  role: RoleAssets | null;
  warnings: string[];
}

/** Pure local preflight is retained in the candidate process through activation. */
export async function prepareRuntime(
  config: ServerConfig,
  control?: ControlMcpRegistration,
): Promise<RuntimeSnapshot> {
  const workspace = config.orchestrator.workspace;
  if (!statSync(workspace).isDirectory() || realpathSync(workspace) !== workspace)
    throw new Error("Workspace must be an existing canonical absolute directory");
  const warnings: string[] = [];
  const loaded = await readPrompts(config, (message) => warnings.push(message));
  const role = config.role === undefined ? null : await readRoleAssets(config.role);
  if (role) warnings.push(`role: ${role.dir}`);
  realtimeParams(config, loaded.prompts, "", "", "");
  warnings.push(...passthroughWarnings(config, loaded.prompts));
  for (const kind of ["start", "resume"] as const) {
    const params = threadParams(config, loaded.prompts, kind, role ?? {});
    if (control) {
      // Reject hidden reserved entries even when raw config would discard them.
      for (const servers of [config.orchestrator.config?.["mcp_servers"], role?.mcpServers]) {
        if (servers && typeof servers === "object" && Object.hasOwn(servers, control.name))
          throw new Error(`MCP server name "${control.name}" is reserved for AgentVoice control`);
      }
      injectControlMcp(params, control);
    }
    if (kind === "start" && params["baseInstructions"] != null)
      warnings.push("warning: explicit baseInstructions replaces Codex's entire base prompt");
  }
  // Validate startup -c invariants before replacing a live generation.
  appServerArgv(config.codex, config.codexConfig);
  return { prompts: loaded.prompts, foundPrompts: loaded.paths, role, warnings };
}

export class VoiceRuntime {
  private attachment: RuntimeConnection | null = null;
  private threadId: string | null = null;
  private threadReady = false;
  private prompts: Prompts = {};
  private foundPrompts: string[] = [];
  private role: RoleAssets | null = null;
  private effort: string | null = null;
  private conversationMode: "started" | "continued" = "started";
  private freshInFlight = false;
  private shuttingDown = false;
  private tuiGateway: AttachmentGateway | undefined;
  private shutdownPromise: Promise<void> | null = null;
  private readonly abort = new AbortController();
  private readonly locks = new Map<string, () => void>();
  private readonly activeTurns = new Map<string, string>();
  private privateHandoffPrompt: { raw: string; escaped: string } | undefined;
  private readonly sessions: VoiceSessionManager;
  private readonly threadObserver: ThreadObserver | undefined;
  private conversationRevision = 0;
  private readonly conversationReader: ConversationReader;
  private tierSelection: ServiceTierSelection | null = null;
  private tier: TierObservation = {};

  constructor(
    private readonly config: ServerConfig,
    private readonly version: string,
    private readonly events: RuntimeEvents,
    private readonly options: RuntimeOptions = {},
  ) {
    this.conversationReader = new ConversationReader(
      (method, params, timeout) => this.requireConnection().request(method, params, timeout),
      config.orchestrator.workspace,
      () => this.conversationRevision,
      Object.values(options.controlMcp?.env ?? {}),
    );
    this.threadObserver = options.onThreads
      ? new ThreadObserver(
          (method, params, timeout) => this.requireConnection().request(method, params, timeout),
          options.onThreads,
        )
      : undefined;
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
          realtimeParams(this.config, this.prompts, threadId, sessionId, sdp),
        );
      },
      stopRealtime: async () => {
        const connection = this.attachment;
        const threadId = this.threadId;
        if (connection && threadId)
          await connection.request("thread/realtime/stop", { threadId }, 1_000);
      },
      debug: this.events.debug ? (line) => this.debug(line) : undefined,
    });
  }

  get currentReady(): ReadyInfo | null {
    if (!this.threadReady || !this.threadId || this.shuttingDown) return null;
    return {
      threadId: this.threadId,
      workspace: this.config.orchestrator.workspace,
      ...this.tier,
      model: this.tier.model ?? null,
      effort: this.effort,
      conversationMode: this.conversationMode,
      voiceVersion: this.sessions.version,
      prompts: this.foundPrompts,
    };
  }

  async start(): Promise<void> {
    try {
      const workspace = this.config.orchestrator.workspace;
      if (!statSync(workspace).isDirectory() || realpathSync(workspace) !== workspace)
        throw new Error("Workspace changed after runtime preflight");
      const snapshot =
        this.options.snapshot ?? (await prepareRuntime(this.config, this.options.controlMcp));
      this.prompts = snapshot.prompts;
      this.foundPrompts = snapshot.foundPrompts;
      this.role = snapshot.role;
      const warnings = snapshot.warnings;
      if (warnings.length > 0) {
        for (const message of warnings) this.events.onStatus(message);
        this.events.onWarning?.(warnings.join("\n"));
      }
      await this.openConnection();
      const connection = this.requireConnection();
      // Process-local to this owned child: no other Codex process sees the root.
      if (this.role?.skillsRoot !== undefined) {
        try {
          await connection.request("skills/extraRoots/set", {
            extraRoots: [this.role.skillsRoot],
          });
        } catch (error) {
          throw new Error(
            `role skills could not be registered with Codex (skills/extraRoots/set): ${String(error)}`,
          );
        }
        this.assertRunning();
      }
      const id =
        this.options.exactResume ??
        (await selectThread(
          (method, params) => connection.request(method, params),
          workspace,
          this.options,
        ));
      this.assertRunning();
      this.threadId = id ? await this.resumeThread(id) : await this.startThread();
      this.options.onVerifiedThread?.({
        threadId: this.threadId,
        workspace: this.config.orchestrator.workspace,
      });
      await this.confirmControlReady();
      this.threadReady = true;
      void this.threadObserver?.start();
      this.emitReady();
    } catch (error) {
      await this.shutdown();
      throw error;
    }
  }

  async offer(sdp: string): Promise<void> {
    if (!this.threadReady || this.shuttingDown) return;
    await this.sessions.handleOffer(sdp);
  }

  async fresh(): Promise<void> {
    if (!this.threadReady || this.freshInFlight || this.shuttingDown) return;
    this.tuiGateway?.revoke();
    this.freshInFlight = true;
    this.threadReady = false;
    try {
      // Cut media before changing identity; no old audio or SDP enters the new conversation.
      this.events.onClosed("fresh-thread");
      await this.sessions.shutdown();
      this.assertRunning();
      const threadId = await this.startThread();
      this.threadId = threadId;
      this.options.onVerifiedThread?.({
        threadId: this.threadId,
        workspace: this.config.orchestrator.workspace,
      });
      await this.confirmControlReady();
      this.sessions.reset();
      this.events.onStatus(`new conversation: ${this.threadId}`);
    } catch (error) {
      if (this.options.controlMcp) {
        this.events.onFatal(error instanceof Error ? error.message : String(error));
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

  async submitHandoff(input: HandoffRequest): Promise<HandoffResult> {
    const checked = handoffRequestSchema.safeParse(input);
    if (
      !checked.success ||
      this.shuttingDown ||
      this.freshInFlight ||
      !this.threadReady ||
      !this.attachment?.alive ||
      this.threadId !== input.threadId ||
      this.config.orchestrator.workspace !== input.workspace
    )
      return handoffFailure("not_ready");
    const connection = this.attachment;
    if (this.events.debug)
      this.privateHandoffPrompt = {
        raw: input.prompt,
        escaped: JSON.stringify(input.prompt).slice(1, -1),
      };
    try {
      // This native method starts an idle thread or steers an active regular turn.
      // clientUserMessageId is correlation, not native deduplication.
      const result = await connection.request(
        "turn/start",
        {
          threadId: input.threadId,
          clientUserMessageId: input.clientUserMessageId,
          input: [
            {
              type: "text",
              text: `AgentVoice restart handoff (agent-provided task):\n\n${input.prompt}`,
            },
          ],
        },
        10_000,
      );
      const turn = (result as { turn?: { id?: unknown; status?: unknown } } | null)?.turn;
      if (
        typeof turn?.id !== "string" ||
        !turn.id ||
        turn.id.length > 256 ||
        turn.status !== "inProgress"
      )
        return handoffUnknown();
      return { status: "accepted", turnId: turn.id };
    } catch (error) {
      return error instanceof AppServerError && typeof error.code === "number" && !error.timedOut
        ? handoffFailure("native_refused")
        : handoffUnknown();
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.tuiGateway?.close();
    this.shuttingDown = true;
    this.threadObserver?.stop();
    this.threadReady = false;
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
        this.options.onShutdownOutcome?.(this.attachment?.shutdownForced === true);
        this.attachment = null;
        this.sessions.reset();
        for (const release of this.locks.values()) release();
        this.locks.clear();
      }
    })();
    return this.shutdownPromise;
  }

  private threadParams(kind: "start" | "resume"): Record<string, unknown> {
    const params = threadParams(this.config, this.prompts, kind, this.role ?? {});
    return this.options.controlMcp ? injectControlMcp(params, this.options.controlMcp) : params;
  }

  private assertRunning(): void {
    if (this.shuttingDown) throw new Error("AgentVoice is shutting down");
  }

  private debug(line: string): void {
    if (!this.events.debug) return;
    const prompt = this.privateHandoffPrompt;
    if (prompt && (line.includes(prompt.raw) || line.includes(prompt.escaped)))
      this.events.debug?.("[restart handoff content omitted]");
    else this.events.debug?.(line);
  }

  private requireConnection(): RuntimeConnection {
    this.assertRunning();
    if (!this.attachment?.alive) throw new AppServerError("Codex connection is closed");
    return this.attachment;
  }

  private async confirmControlReady(): Promise<void> {
    if (this.options.controlMcp && this.threadId) {
      const connection = this.requireConnection();
      await requireControlMcpReady(
        connection.request.bind(connection),
        this.threadId,
        this.options.controlMcp,
        this.options.controlReadinessTimeoutMs,
      );
      this.assertRunning();
    }
  }

  private async acquire(id: string): Promise<void> {
    if (this.locks.has(id)) return;
    if (this.options.acquireLease) {
      await this.options.acquireLease(id);
      this.assertRunning();
      this.locks.set(id, () => {});
      return;
    }
    const directory =
      this.options.locksDir ?? join(stateDirectory(process.env, homedir()), "thread-locks");
    this.locks.set(id, lockThread(directory, id));
  }

  private async startThread(): Promise<string> {
    const selection = this.tierSelection!;
    const params = await selection.prepare(this.threadParams("start"));
    const result = await this.requireConnection().request("thread/start", params);
    this.assertRunning();
    const id = extractThreadId(result);
    await this.acquire(id);
    this.threadObserver?.seed((result as { thread?: unknown }).thread);
    const tier = await selection.confirm(result, params);
    this.assertRunning();
    this.tier = tier;
    this.effort = reportedEffort(result);
    this.conversationMode = "started";
    return id;
  }

  private async resumeThread(id: string): Promise<string> {
    await this.acquire(id);
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
        ...this.threadParams("resume"),
        threadId: id,
        excludeTurns: true,
      },
      read.thread,
    );
    this.assertRunning();
    const result = await connection.request("thread/resume", params);
    this.assertRunning();
    if (extractThreadId(result) !== id) throw new Error("Codex resumed a different conversation");
    this.threadObserver?.seed((result as { thread?: unknown }).thread);
    const tier = await selection.confirm(result, params);
    this.assertRunning();
    this.tier = tier;
    this.effort = reportedEffort(result);
    this.conversationMode = "continued";
    this.events.onStatus(`continued conversation: ${id}`);
    return id;
  }

  private emitReady(): void {
    const info = this.currentReady;
    if (info) this.events.onReady(info);
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (this.shuttingDown) return;
    if (Object.hasOwn(nativeConversationSchemas, method)) {
      const revision = ++this.conversationRevision;
      if (this.options.onConversation) {
        const notification = projectNotification(
          method,
          params,
          revision,
          Object.values(this.options.controlMcp?.env ?? {}),
        );
        if (notification) this.options.onConversation(notification);
      }
    }
    this.threadObserver?.notification(method, params);
    if (this.options.onVoice) {
      const notification = nativeVoiceNotification(method, params);
      if (notification) this.options.onVoice(notification);
    }
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
        if (settings && id === this.threadId) {
          if (typeof settings["model"] === "string") this.tier.model = settings["model"];
          if (typeof settings["serviceTier"] === "string" || settings["serviceTier"] === null)
            this.tier.serviceTier = settings["serviceTier"] as string | null;
          if (Object.hasOwn(settings, "reasoningEffort")) this.effort = reportedEffort(settings);
          this.emitReady();
        }
      }
    }
  }

  private async openConnection(): Promise<void> {
    this.assertRunning();
    const codex = this.options.connect
      ? this.config.codex
      : resolveNativeExecutable(this.config.codex, this.config.orchestrator.workspace);
    let connection: RuntimeConnection | null = null;
    connection = await (this.options.connect ?? AppServerConnection.connect)({
      argv: appServerArgv(codex, fullAccessStartupConfig(this.config)),
      nativeStateDir: this.options.nativeStateDir,
      cwd: this.config.orchestrator.workspace,
      env: { ...process.env, ...this.options.controlMcp?.env },
      onSpawn: this.options.onChildPid,
      onReaped: this.options.onChildReaped,
      signal: this.abort.signal,
      clientVersion: this.version,
      optOutNotificationMethods: this.events.debug
        ? undefined
        : UNUSED_STREAM_NOTIFICATIONS.filter(
            (method) =>
              !this.options.onConversation || !Object.hasOwn(nativeConversationSchemas, method),
          ),
      onNotification: (method, params) => this.handleNotification(method, params),
      onRefusal: (message) => this.events.onError(message, false),
      onInteraction: (message) => this.events.onError(message, false),
      onClose: (info) => {
        if (this.shuttingDown || this.attachment !== connection || info.expected) return;
        this.threadReady = false;
        this.sessions.reset();
        this.events.onFatal(info.error ?? "Codex connection closed");
      },
      debug: this.events.debug ? (line) => this.debug(line) : undefined,
    });
    if (this.shuttingDown || !connection.alive) {
      await connection.close();
      throw new Error("Codex stopped during startup");
    }
    this.attachment = connection;
    if (connection.nativeEndpoint) {
      this.tuiGateway = new AttachmentGateway(
        connection.nativeEndpoint,
        resolveNativeExecutable(codex, this.config.orchestrator.workspace),
      );
      this.options.onAttachmentReady?.(
        () => {
          if (!this.threadReady || this.shuttingDown || this.freshInFlight || !this.threadId)
            throw new Error("Voice thread is not ready for attachment");
          return this.tuiGateway!.issue({
            threadId: this.threadId,
            workspace: this.config.orchestrator.workspace,
          });
        },
        () => this.tuiGateway?.revoke(),
      );
    }
    this.tierSelection = new ServiceTierSelection(
      (method, params) => {
        this.assertRunning();
        return connection!.request(method, params);
      },
      this.config.orchestrator.workspace,
      this.options.fast,
    );
  }
  readConversation(method: ConversationReadMethod, params: ConversationReadParams) {
    this.assertRunning();
    return this.conversationReader.read(method, params);
  }
}

function extractThreadId(result: unknown): string {
  const shape = result as { thread?: { id?: string }; threadId?: string };
  const id = shape?.thread?.id ?? shape?.threadId;
  if (typeof id !== "string" || !id) throw new AppServerError("app-server returned no thread id");
  return id;
}

function reportedEffort(result: unknown): string | null {
  const effort = (result as Record<string, unknown> | null)?.["reasoningEffort"];
  return typeof effort === "string" ? effort : null;
}
