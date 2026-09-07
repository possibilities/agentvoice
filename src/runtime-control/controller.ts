/** Call authority owned by the server. Media and UI modules stay in separate processes. */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { attachmentTargetSchema } from "../attachment/bootstrap.ts";
import type { AttachmentTicket } from "../attachment/gateway.ts";
import { MuteGate } from "../console/audio-control.ts";
import type { VoiceState } from "../console/state.ts";
import { startControlServer } from "../control/index.ts";
import {
  CONTROL_MCP_SERVER_NAME,
  CONTROL_MCP_TOOLS,
  CONTROL_PROTOCOL_VERSION,
  type ControlBackend,
  ControlError,
  type ControlServer,
  type ControlStatus,
} from "../control/types.ts";
import type { ControlMcpRegistration } from "../core/control-mcp.ts";
import { lockThread } from "../core/thread-lock.ts";
import { threadInventorySchema } from "../events/contract.ts";
import {
  type ConversationReadMethod,
  type ConversationReadParams,
  conversationNotification,
  conversationRequestSchemas,
  ObservationError,
  observationErrorCode,
  readResultSchema,
} from "../events/conversation.ts";
import { LifecycleFeed } from "../events/feed.ts";
import { EventSocketServer, eventSocketPath } from "../events/socket.ts";
import { voiceNotification } from "../events/voice.ts";
import { stateDirectory } from "../paths.ts";
import { type RuntimeProcess, spawnRuntimeProcess } from "./process.ts";
import type { CandidateInfo, LaunchProvenance, RuntimeLaunch } from "./protocol.ts";

export interface ControllerOptions {
  instanceId: string;
  stateDir: string;
  provenance: LaunchProvenance;
  version: string;
  control: ControlMcpRegistration;
  lifecycle?: LifecycleFeed;
  changed?(): void;
  spawn?: typeof spawnRuntimeProcess;
  lease?: (threadId: string) => () => void;
}

export class RuntimeController implements ControlBackend {
  readonly lifecycle: LifecycleFeed;
  private readonly leases = new Map<string, () => void>();
  private active: RuntimeProcess | undefined;
  private candidate: RuntimeProcess | undefined;
  private readonly generation = 1;
  private incarnation = 0;
  private activeIncarnation = 0;
  private workspace = "";
  private threadId = "";
  private buildId: string | undefined;
  private phase = "starting";
  private busy = false;
  private started = false;
  private observationPending = 0;
  private closed = false;
  private shutdownPromise: Promise<void> | undefined;
  private voice: VoiceState = {
    available: true,
    phase: "waiting-ready",
    mic: { muted: false, effectiveMuted: false },
    speaker: { muted: false, effectiveMuted: false },
  };
  readonly microphone = new MuteGate();
  readonly speaker = new MuteGate();

  constructor(private readonly options: ControllerOptions) {
    this.lifecycle = options.lifecycle ?? new LifecycleFeed(options.instanceId);
  }
  status(): ControlStatus {
    return {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      instanceId: this.options.instanceId,
      workspace: this.workspace,
      threadId: this.threadId,
      generation: this.generation,
      runtime: {
        pid: this.active?.pid,
        buildId: this.buildId,
        phase: this.phase,
        voicePhase: this.voice.phase,
      },
    };
  }
  async attachmentTicket(value: unknown): Promise<AttachmentTicket> {
    const target = attachmentTargetSchema.parse(value);
    const current = () =>
      !this.closed &&
      !this.busy &&
      this.phase === "ready" &&
      target.instanceId === this.options.instanceId &&
      target.generation === this.generation &&
      target.threadId === this.threadId &&
      target.workspace === this.workspace;
    if (!current() || !this.active)
      throw new Error("Attachment unavailable; select the current live thread");
    const active = this.active;
    const ticket = await active.request<AttachmentTicket>("attachment-ticket", {
      threadId: this.threadId,
    });
    if (!current() || active !== this.active) throw new Error("Attachment target changed");
    return ticket;
  }
  state(): VoiceState {
    const ready = this.phase === "ready";
    return {
      ...this.voice,
      available: !this.closed,
      workspace: this.workspace,
      mic: {
        muted: this.microphone.muted,
        effectiveMuted: !ready || this.microphone.effectiveMuted,
      },
      speaker: {
        muted: this.speaker.muted,
        effectiveMuted: !ready || this.speaker.effectiveMuted,
      },
    };
  }
  private changed() {
    this.lifecycle.runtime(this.generation, {
      phase: this.phase,
      workspace: this.workspace,
      mainThreadId: this.threadId,
    });
    this.options.changed?.();
  }
  private notice(message: string) {
    this.voice.notice = message;
    this.changed();
  }
  private assertOpen() {
    if (this.closed) throw new Error("Controller is shutting down");
  }
  private acquire = async (id: string): Promise<void> => {
    this.assertOpen();
    if (!this.leases.has(id))
      this.leases.set(
        id,
        this.options.lease?.(id) ?? lockThread(join(this.options.stateDir, "thread-locks"), id),
      );
  };
  private newProcess(): { process: RuntimeProcess; incarnation: number } {
    const incarnation = ++this.incarnation;
    const process = (this.options.spawn ?? spawnRuntimeProcess)(
      incarnation,
      (method, params) => this.event(incarnation, method, params),
      async (id) => {
        if (incarnation !== this.activeIncarnation)
          throw new Error("Obsolete runtime cannot acquire a thread lease");
        await this.acquire(id);
      },
    );
    return { process, incarnation };
  }
  private event(incarnation: number, method: string, params: unknown) {
    if (incarnation !== this.activeIncarnation || this.closed) return;
    if (method === "conversation") {
      const checked = conversationNotification(params);
      if (checked) this.lifecycle.conversation(checked);
      return;
    }
    if (method === "voice") {
      const checked = voiceNotification(params);
      if (checked) this.lifecycle.voice(checked);
      return;
    }
    if (method === "threads") {
      const checked = threadInventorySchema.safeParse(params);
      if (checked.success) this.lifecycle.update(checked.data);
      else this.lifecycle.update({ threads: this.lifecycle.snapshot().threads, complete: false });
      return;
    }
    if (method === "identity") {
      if (this.phase === "failed") return;
      const identity = params as { threadId: string; workspace: string };
      if (identity.workspace !== this.workspace || !this.leases.has(identity.threadId)) {
        this.phase = "failed";
        this.voice.phase = "failed";
        this.notice("Runtime reported an unleased or foreign identity");
        void this.active?.stop().catch(() => {});
        return;
      }
      this.threadId = identity.threadId;
    } else if (method === "state") {
      if (this.phase === "failed") return;
      const state = params as VoiceState;
      if (state.conversation) {
        if (
          state.conversation.workspace !== this.workspace ||
          !this.leases.has(state.conversation.threadId)
        ) {
          this.notice("Runtime reported an unleased or foreign conversation");
          void this.active?.stop();
          return;
        }
        this.threadId = state.conversation.threadId;
      }
      this.voice = structuredClone(state);
    } else if (method === "fatal" || (method === "exit" && this.phase === "ready")) {
      this.phase = "failed";
      this.voice.phase = "failed";
      this.voice.notice =
        method === "fatal"
          ? (params as { message: string }).message
          : "Runtime exited; close the frontend and start a new call";
    }
    this.changed();
  }
  async start(): Promise<void> {
    this.assertOpen();
    if (this.started) throw new Error("Call already started");
    this.started = true;
    this.busy = true;
    try {
      await this.activate();
    } catch (error) {
      this.phase = "failed";
      this.voice.phase = "failed";
      this.notice(String(error));
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  private async activate(): Promise<void> {
    this.assertOpen();
    const candidate = this.newProcess();
    this.candidate = candidate.process;
    try {
      const launch: RuntimeLaunch = {
        provenance: this.options.provenance,
        version: this.options.version,
        control: this.options.control,
        workspace: this.workspace || undefined,
        nativeStateDir: this.options.stateDir,
      };
      const info = await candidate.process.request<CandidateInfo>("preflight", launch);
      this.assertOpen();
      if (this.workspace && info.workspace !== this.workspace)
        throw new Error("Candidate changed pinned workspace");
      this.workspace = info.workspace;
      this.active = candidate.process;
      this.activeIncarnation = candidate.incarnation;
      this.candidate = undefined;
      this.buildId = info.buildId;
      this.phase = "starting";
      await candidate.process.request(
        "activate",
        {
          mute: { mic: this.microphone.muted, speaker: this.speaker.muted },
        },
        90_000,
      );
      this.assertOpen();
      await candidate.process.request("enable-media", {
        mic: this.microphone.muted,
        speaker: this.speaker.muted,
      });
      this.assertOpen();
      if (this.phase === "failed")
        throw new Error(this.voice.notice ?? "Runtime failed during activation");
      this.phase = "ready";
      this.syncMute();
      this.changed();
    } catch (error) {
      await candidate.process.stop();
      if (this.candidate === candidate.process) this.candidate = undefined;
      if (this.active === candidate.process) this.active = undefined;
      this.activeIncarnation = 0;
      throw error;
    }
  }
  syncMute() {
    if (this.phase === "ready" || this.phase === "starting")
      this.active?.notify("mute", {
        mic: this.microphone.effectiveMuted,
        speaker: this.speaker.effectiveMuted,
      });
    this.changed();
  }
  async readConversation(method: ConversationReadMethod, params: ConversationReadParams) {
    const parsed = conversationRequestSchemas[method].safeParse(params);
    if (!parsed.success) throw new ObservationError("invalid_params");
    if (params.expectedInstanceId !== this.options.instanceId)
      throw new ObservationError("instance_mismatch");
    if (params.expectedGeneration !== this.generation)
      throw new ObservationError("stale_generation");
    if (this.closed || this.phase !== "ready" || !this.active)
      throw new ObservationError("unavailable");
    if (!this.leases.has(params.rootThreadId)) throw new ObservationError("forbidden_thread");
    if (this.observationPending >= 4) throw new ObservationError("busy");
    const active = this.active;
    const incarnation = this.activeIncarnation;
    let value: { ok?: boolean; result?: unknown; error?: { code?: unknown } };
    this.observationPending++;
    try {
      value = await active.request(method, parsed.data, 8_000);
    } catch {
      throw new ObservationError("unavailable");
    } finally {
      this.observationPending--;
    }
    if (
      this.closed ||
      this.phase !== "ready" ||
      this.active !== active ||
      this.activeIncarnation !== incarnation ||
      this.generation !== params.expectedGeneration
    )
      throw new ObservationError("stale_generation");
    if (!value?.ok) {
      const code = observationErrorCode.safeParse(value?.error?.code);
      throw new ObservationError(code.success ? code.data : "unavailable");
    }
    const result = readResultSchema.safeParse(value.result);
    if (
      !result.success ||
      result.data.method !== method ||
      result.data.rootThreadId !== params.rootThreadId ||
      ("threadId" in result.data ? result.data.threadId : undefined) !==
        ("threadId" in params ? params.threadId : undefined)
    )
      throw new ObservationError("unsupported");
    if (method === "conversation.live.get" && "threadId" in params)
      return this.lifecycle.live(params.threadId);
    return { instanceId: this.options.instanceId, generation: this.generation, ...result.data };
  }
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    // Publish only after the promise exists: changed callbacks may request shutdown too.
    this.shutdownPromise = Promise.resolve().then(async () => {
      this.phase = "stopping";
      this.changed();
      this.activeIncarnation = 0;
      const stopped = await Promise.allSettled([this.active?.stop(), this.candidate?.stop()]);
      for (const release of this.leases.values()) release();
      this.leases.clear();
      const failed = stopped.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    });
    return this.shutdownPromise;
  }
}

export async function createCall(
  provenance: LaunchProvenance,
  version: string,
  changed: () => void,
): Promise<{ controller: RuntimeController; close(): Promise<void> }> {
  const instanceId = randomUUID();
  const stateDir = stateDirectory(process.env, homedir());
  let controller: RuntimeController | undefined;
  let control: ControlServer | undefined;
  const lifecycle = new LifecycleFeed(instanceId);
  const current = () => {
    if (!controller) throw new ControlError("unavailable", "Call is initializing");
    return controller;
  };
  const events = new EventSocketServer(
    eventSocketPath(stateDir, instanceId),
    lifecycle,
    (method, params) => current().readConversation(method, params),
  );
  const close = async () => {
    try {
      await controller?.shutdown();
    } finally {
      events.close();
      await control?.close();
    }
  };
  try {
    await events.start();
    control = await startControlServer({
      backend: { status: () => current().status() },
      stateDir,
      instanceId,
      attachment: (value) => current().attachmentTicket(value),
    });
    controller = new RuntimeController({
      instanceId,
      stateDir,
      lifecycle,
      provenance,
      version,
      changed,
      control: {
        name: CONTROL_MCP_SERVER_NAME,
        server: { ...control.mcpServer },
        tools: CONTROL_MCP_TOOLS,
        env: {
          [control.bearerTokenEnvVar]: control.bearerToken,
          [control.socketEnvVar]: control.socketPath,
          AGENTVOICE_EVENTS_SOCKET: events.path,
        },
      },
    });
    return { controller, close };
  } catch (error) {
    await close();
    throw error;
  }
}
