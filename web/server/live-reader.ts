import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { observeAttachmentServer, VoiceRecordingTail } from "../../src/attachment/session.ts";
import {
  discoverControllerStatus,
  type ReadableControlProtocol,
} from "../../src/control/discovery.ts";
import { CONTROL_PROTOCOL_VERSION } from "../../src/control/types.ts";
import { EVENT_PROTOCOL_VERSION } from "../../src/events/contract.ts";
import { conversationTurnSchema, readResultSchema } from "../../src/events/conversation.ts";
import { liveSnapshotSchema } from "../../src/events/conversation-projection.ts";
import { eventSnapshotSchema } from "../../src/events/schema.ts";
import { eventSocketPath } from "../../src/events/socket.ts";
import { ControlSocket, SocketFailure } from "../../src/ipc/control-client.ts";
import { savedRecordings } from "../../src/recording/store.ts";
import type { LiveView } from "../src/types.ts";
import { type AgentCommand, AgentControls } from "./agent-controls.ts";
import { sendAgentOperation } from "./agent-sender.ts";
import { type AgentItem, agentMessage, itemKey, VoiceMessages } from "./messages.ts";

const liveSchema = liveSnapshotSchema.extend({ instanceId: z.string(), generation: z.number() });
const historySchema = readResultSchema.options[4]!.extend({
  instanceId: z.string(),
  generation: z.number(),
});
const turnsSchema = readResultSchema.options[3]!.extend({
  instanceId: z.string(),
  generation: z.number(),
});
const empty = (phase: LiveView["phase"]): LiveView => ({ phase, id: phase, voice: [], agent: [] });
const DIAGNOSTIC_BYTES = 256 * 1024;
const DIAGNOSTIC_RATE_MS = 5_000;
const DIAGNOSTIC_CODES = new Set([
  "ENOENT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EACCES",
  "EPERM",
  "invalid_params",
  "unavailable",
  "stale_generation",
  "instance_mismatch",
  "forbidden_thread",
  "unsupported",
  "history_unavailable",
  "busy",
  "oversized",
  "cursor_expired",
  "resync_required",
  "internal_error",
]);
type ReaderStage =
  | "observer.connect"
  | "observer.closed"
  | "observer.identity"
  | "controller.discover"
  | "controller.identity"
  | "events.connect"
  | "events.subscribe"
  | "events.closed"
  | "events.snapshot"
  | "conversation.live"
  | "conversation.turns"
  | "history.connect"
  | "history.page"
  | "history.closed"
  | "voice.tail";

function persistenceScope(workspace: string, threadId: string) {
  return createHash("sha256").update(workspace).update("\0").update(threadId).digest("hex");
}

function systemErrorCode(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === "string") return code;
    current = current.cause;
  }
}

function diagnosticError(error: unknown) {
  const code = systemErrorCode(error);
  if (code && DIAGNOSTIC_CODES.has(code)) return code;
  if (code) return "system_error";
  if (error instanceof SocketFailure && /timed out/iu.test(error.message)) return "timeout";
  if (error instanceof Error && /timed out/iu.test(error.message)) return "timeout";
  if (error instanceof z.ZodError || error instanceof SyntaxError) return "invalid_response";
  if (error instanceof Error) {
    const fixed = [
      [/Oversized socket frame/iu, "oversized_frame"],
      [/Uncorrelated socket response/iu, "uncorrelated_response"],
      [/Incompatible socket protocol/iu, "incompatible_protocol"],
      [/Socket write limit exceeded/iu, "write_limit"],
      [/(?:socket|server).*(?:closed|disconnected|connection failed)/iu, "disconnected"],
      [/Unsafe (?:control )?socket/iu, "unsafe_transport"],
      [/Unsupported controller protocol/iu, "unsupported_protocol"],
      [/no live AgentVoice controller/iu, "controller_unavailable"],
      [/(?:Call|History attempt) changed/iu, "stale_attempt"],
    ] as const;
    for (const [pattern, reason] of fixed) if (pattern.test(error.message)) return reason;
  }
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,31}$/u.test(error.name)
    ? error.name
    : "unknown";
}
type Observer = Awaited<ReturnType<typeof observeAttachmentServer>>;
type Identity = {
  workspace: string;
  threadId: string;
  instanceId: string;
  generation: number;
  controlProtocolVersion: ReadableControlProtocol;
};
type HistoryPass = { rows: AgentItem[]; cursor?: string; bytes: number; revision: number };
type HistoryAttempt = { client?: ControlSocket; closed?: boolean };

/** Shared default-call adapter. The browser can neither choose sockets nor submit RPC methods. */
export class LiveReader {
  private observer?: Observer;
  private eventClient?: ControlSocket;
  private verifiedClient?: ControlSocket;
  private historyClient?: ControlSocket;
  private historyConnectPending?: Promise<ControlSocket>;
  private identity?: Identity;
  private viewId = "";
  private tail?: VoiceRecordingTail;
  private voice = new VoiceMessages();
  private history: AgentItem[] = [];
  private pass?: HistoryPass;
  private historyRevision = 0;
  private loadedRevision = -1;
  private initialHistorySettled = false;
  private historyTimer?: ReturnType<typeof setTimeout>;
  private historyRetryAt = 0;
  private historyPending = false;
  private historyAttempt?: HistoryAttempt;
  private historyNotice?: string;
  private closed = false;
  private pending?: Promise<LiveView>;
  private cached = empty("connecting");
  private readAt = 0;
  private retryAt = 0;
  private retryDelay = 250;
  private stage: ReaderStage = "observer.connect";
  private readonly diagnosticAt = new Map<string, number>();
  private readonly controls: AgentControls;

  constructor(
    private readonly stateDir: string,
    private readonly initialHistoryBudgetMs = 5_000,
    private readonly historyRetryMs = 5_000,
  ) {
    this.controls = new AgentControls(stateDir, (target, operation, current) =>
      sendAgentOperation(
        stateDir,
        target,
        operation,
        () => current() && !!this.identity && this.actionable(this.identity),
      ),
    );
  }

  async agentCommand(command: AgentCommand) {
    await this.read();
    if (!this.identity || !this.actionable(this.identity))
      throw new Error("The call changed. Nothing was sent.");
    await this.controls.command(command);
    this.readAt = 0;
  }

  read(): Promise<LiveView> {
    if (this.closed) return Promise.resolve(empty("offline"));
    if (this.pending) return this.pending;
    if (Date.now() < this.retryAt) {
      if (this.identity && this.observedReplacement(this.identity)) {
        this.resetCall();
        this.retryAt = 0;
      } else return Promise.resolve(this.cached);
    }
    if (Date.now() - this.readAt < 250) return Promise.resolve(this.cached);
    this.pending = this.update()
      .then((view) => {
        if (view.phase === "live" || view.phase === "detached" || view.phase === "empty") {
          this.retryAt = 0;
          this.retryDelay = 250;
        }
        return view;
      })
      .catch((error) => {
        this.diagnose(this.stage, error);
        if (
          this.replacementFailure(error) ||
          (this.identity && this.observedReplacement(this.identity))
        )
          this.resetCall();
        else this.disconnectLive();
        this.scheduleRetry();
        return this.retained("unavailable", "Agent transcript unavailable. Reconnecting…");
      })
      .then((view) => {
        this.cached = view;
        this.readAt = Date.now();
        return view;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private disconnectLive() {
    this.controls.disconnect();
    this.eventClient?.close();
    this.eventClient = undefined;
    this.verifiedClient = undefined;
    this.historyClient?.close();
    this.historyClient = undefined;
    this.historyConnectPending = undefined;
    this.pass = undefined;
    this.historyRevision++;
    this.loadedRevision = -1;
    clearTimeout(this.historyTimer);
    this.historyTimer = undefined;
    this.historyRetryAt = 0;
    this.historyPending = false;
    this.historyAttempt = undefined;
    this.readAt = 0;
  }

  private scheduleRetry() {
    this.retryAt = Date.now() + this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, 5_000);
  }

  private resetCall() {
    this.disconnectLive();
    this.identity = undefined;
    this.viewId = "";
    this.tail?.close();
    this.tail = undefined;
    this.voice = new VoiceMessages();
    this.history = [];
    this.historyRevision = 0;
    this.loadedRevision = -1;
    this.initialHistorySettled = false;
    this.historyNotice = undefined;
    this.cached = empty("connecting");
  }

  close() {
    this.closed = true;
    this.resetCall();
    this.observer?.socket.close();
    this.observer = undefined;
  }

  private current(identity: Identity) {
    const state = this.observer?.latest();
    return (
      !this.closed &&
      this.identity === identity &&
      !!state &&
      state.workspace === identity.workspace &&
      state.threadId === identity.threadId &&
      (state.generation === undefined || state.generation === identity.generation)
    );
  }

  private observedReplacement(identity: Identity) {
    const state = this.observer?.latest();
    if (!state) return false;
    if (!state.workspace || !state.threadId) return state.availability === "idle";
    return (
      state.workspace !== identity.workspace ||
      state.threadId !== identity.threadId ||
      (state.generation !== undefined && state.generation !== identity.generation)
    );
  }

  private attached(identity: Identity) {
    const state = this.observer?.latest();
    return this.current(identity) && state?.availability === "connected" && !!state.clientId;
  }

  private actionable(identity: Identity) {
    const state = this.observer?.latest();
    return (
      this.eventClient !== undefined &&
      this.verifiedClient === this.eventClient &&
      state?.availability !== "unavailable" &&
      this.current(identity)
    );
  }

  private bindControls(identity: Identity) {
    if (!this.viewId) this.viewId = randomUUID();
    this.controls.bind({ ...identity, viewId: this.viewId });
  }

  private sessionPhase(identity: Identity): LiveView["phase"] {
    const state = this.observer?.latest();
    if (!state || !this.current(identity) || state.availability === "unavailable")
      return "unavailable";
    return this.attached(identity) ? "live" : "detached";
  }

  private interruptedRead(identity: Identity, client: ControlSocket): LiveView | undefined {
    if (this.eventClient === client && this.observer) return;
    if (this.observedReplacement(identity)) {
      this.diagnose(
        "observer.identity",
        new SocketFailure("Call identity changed", "stale_generation"),
      );
      this.resetCall();
      return empty("connecting");
    }
    return this.retained("unavailable", "Agent transcript disconnected. Reconnecting…");
  }

  private retained(phase: LiveView["phase"], notice?: string): LiveView {
    if (!this.identity || !this.viewId) return empty(phase);
    const controls = this.controls.view();
    return {
      ...this.cached,
      phase,
      id: this.viewId,
      persistenceScope: persistenceScope(this.identity.workspace, this.identity.threadId),
      agentControls: { ...controls, available: false },
      ...(notice ? { agentNotice: notice } : {}),
    };
  }

  private replacementFailure(error: unknown) {
    return (
      error instanceof SocketFailure &&
      ["instance_mismatch", "stale_generation"].includes(error.code ?? "")
    );
  }

  private diagnose(stage: ReaderStage, error: unknown) {
    const reason = diagnosticError(error);
    const key = `${stage}:${reason}`;
    const now = Date.now();
    if (now - (this.diagnosticAt.get(key) ?? 0) < DIAGNOSTIC_RATE_MS) return;
    this.diagnosticAt.set(key, now);
    if (this.diagnosticAt.size > 64)
      this.diagnosticAt.delete(this.diagnosticAt.keys().next().value!);
    const line = `${JSON.stringify({ observedAt: new Date(now).toISOString(), stage, error: reason })}\n`;
    try {
      const directory = join(this.stateDir, "web");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const directoryInfo = lstatSync(directory);
      if (
        !directoryInfo.isDirectory() ||
        directoryInfo.isSymbolicLink() ||
        directoryInfo.uid !== process.getuid?.()
      )
        return;
      chmodSync(directory, 0o700);
      const path = join(directory, "reader-diagnostics.jsonl");
      const previous = join(directory, "reader-diagnostics.previous.jsonl");
      const previousInfo = lstatSync(previous, { throwIfNoEntry: false });
      if (
        previousInfo &&
        (!previousInfo.isFile() ||
          previousInfo.isSymbolicLink() ||
          previousInfo.uid !== process.getuid?.() ||
          previousInfo.nlink !== 1)
      )
        return;
      if (previousInfo && previousInfo.size > DIAGNOSTIC_BYTES) rmSync(previous);
      const info = lstatSync(path, { throwIfNoEntry: false });
      if (
        info &&
        (!info.isFile() ||
          info.isSymbolicLink() ||
          info.uid !== process.getuid?.() ||
          info.nlink !== 1)
      )
        return;
      if (info && info.size + Buffer.byteLength(line) > DIAGNOSTIC_BYTES) {
        if (lstatSync(previous, { throwIfNoEntry: false })) rmSync(previous);
        renameSync(path, previous);
      }
      const fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.uid !== process.getuid?.() || opened.nlink !== 1) return;
        fchmodSync(fd, 0o600);
        writeSync(fd, line);
      } finally {
        closeSync(fd);
      }
    } catch {
      /* Diagnostics must never make transcript recovery fail. */
    }
  }

  private sameIdentity(left: Identity, right: Identity) {
    return (
      left.workspace === right.workspace &&
      left.threadId === right.threadId &&
      left.instanceId === right.instanceId &&
      left.generation === right.generation &&
      left.controlProtocolVersion === right.controlProtocolVersion
    );
  }

  private async discoverIdentity(workspace: string, threadId: string): Promise<Identity> {
    this.stage = "controller.discover";
    const selected = await discoverControllerStatus(this.stateDir, workspace, threadId).catch(
      (error: unknown) => {
        // Older loaded controllers retain compatible status/event/attachment contracts.
        if (!(error instanceof Error) || !error.message.startsWith("no live AgentVoice controller"))
          throw error;
        return discoverControllerStatus(this.stateDir, workspace, threadId, 6).catch(
          (legacyError: unknown) => {
            if (
              !(legacyError instanceof Error) ||
              !legacyError.message.startsWith("no live AgentVoice controller")
            )
              throw legacyError;
            return discoverControllerStatus(this.stateDir, workspace, threadId, 5);
          },
        );
      },
    );
    const controlProtocolVersion = selected.status.protocolVersion;
    if (
      controlProtocolVersion !== 5 &&
      controlProtocolVersion !== 6 &&
      controlProtocolVersion !== CONTROL_PROTOCOL_VERSION
    )
      throw new Error("Unsupported controller protocol");
    return {
      workspace,
      threadId,
      instanceId: selected.status.instanceId,
      generation: selected.status.generation,
      controlProtocolVersion,
    };
  }

  private async connectEvents(identity: Identity) {
    this.stage = "events.connect";
    let client!: ControlSocket;
    client = await ControlSocket.connect(
      eventSocketPath(this.stateDir, identity.instanceId),
      EVENT_PROTOCOL_VERSION,
      (frame) => this.event(identity, client, frame),
    );
    if (!this.current(identity)) {
      client.close();
      throw new SocketFailure(
        this.observedReplacement(identity)
          ? "Call changed while reconnecting"
          : "Observer unavailable while reconnecting",
        this.observedReplacement(identity) ? "stale_generation" : "unavailable",
      );
    }
    this.eventClient = client;
    void client.done.then(() => {
      if (this.eventClient !== client) return;
      this.eventClient = undefined;
      this.verifiedClient = undefined;
      this.controls.disconnect();
      this.diagnose("events.closed", client.error() ?? new Error("Event socket disconnected"));
      this.cached = this.retained("unavailable", "Agent transcript disconnected. Reconnecting…");
      this.readAt = 0;
    });
    try {
      this.stage = "events.subscribe";
      await client.request("event.subscribe", { events: ["conversation.*"] });
    } catch (error) {
      if (this.eventClient === client) this.eventClient = undefined;
      client.close();
      throw error;
    }
  }

  private event(identity: Identity, client: ControlSocket, frame: Record<string, unknown>) {
    const data = frame["data"] as Record<string, unknown> | undefined;
    if (
      this.eventClient !== client ||
      !this.current(identity) ||
      data?.["instanceId"] !== identity.instanceId ||
      data?.["generation"] !== identity.generation
    )
      return;
    if (data?.["threadId"] != null && data["threadId"] !== identity.threadId) return;
    if (
      frame["event"] === "conversation.turn.started" ||
      frame["event"] === "conversation.turn.completed"
    ) {
      const turn = conversationTurnSchema.safeParse(data?.["turn"]);
      if (turn.success && typeof data?.["sequence"] === "number") {
        this.controls.observe(turn.data, this.actionable(identity), data["sequence"]);
        // Queued input belongs to the host and still runs when the page stops polling.
        if (frame["event"] === "conversation.turn.completed" && this.actionable(identity))
          void this.controls.drain();
      }
    }
    if (
      [
        "conversation.item.completed",
        "conversation.turn.completed",
        "conversation.gap",
        "conversation.thread.reverted",
      ].includes(String(frame["event"]))
    ) {
      this.historyRevision++;
      if (frame["event"] === "conversation.thread.reverted") {
        this.history = [];
        this.pass = undefined;
      }
    }
  }

  private async update(): Promise<LiveView> {
    if (!this.observer) {
      try {
        this.stage = "observer.connect";
        const observer = await observeAttachmentServer(this.stateDir);
        if (this.closed) {
          observer.socket.close();
          return empty("offline");
        }
        this.observer = observer;
        void observer.socket.done.then(() => {
          if (this.observer === observer) {
            this.observer = undefined;
            const error = observer.socket.error() ?? new Error("Observer socket disconnected");
            this.diagnose("observer.closed", error);
            this.disconnectLive();
            this.cached = this.retained(
              "unavailable",
              "AgentVoice observer disconnected. Reconnecting…",
            );
          }
        });
      } catch (error) {
        const code = systemErrorCode(error);
        if (code === "ENOENT" || code === "ECONNREFUSED") {
          this.diagnose("observer.connect", error);
          this.scheduleRetry();
          return this.retained("offline", "AgentVoice server is offline. Reconnecting…");
        }
        throw error;
      }
    }
    const state = this.observer.latest();
    if (!state.workspace || !state.threadId) {
      if (this.identity && state.availability !== "idle") {
        return this.retained(
          state.availability === "unavailable" ? "unavailable" : "connecting",
          state.availability === "unavailable"
            ? "AgentVoice server is unavailable. Reconnecting…"
            : "AgentVoice session identity is changing…",
        );
      }
      this.resetCall();
      return empty(
        state.availability === "unavailable" ? "unavailable" : state.busy ? "connecting" : "empty",
      );
    }
    if (this.identity && !this.current(this.identity)) {
      this.diagnose(
        "observer.identity",
        new SocketFailure("Call identity changed", "stale_generation"),
      );
      this.resetCall();
    }
    if (!this.eventClient) {
      const discovered = await this.discoverIdentity(state.workspace, state.threadId);
      if (this.closed) return empty("offline");
      if (this.identity && !this.sameIdentity(this.identity, discovered)) {
        this.diagnose(
          "controller.identity",
          new SocketFailure("Controller identity changed", "stale_generation"),
        );
        this.resetCall();
      }
      const identity = this.identity ?? discovered;
      if (!this.identity) this.identity = identity;
      this.bindControls(identity);
      await this.connectEvents(identity);
    } else this.bindControls(this.identity!);
    const identity = this.identity!;
    const client = this.eventClient!;
    this.stage = "events.snapshot";
    const before = eventSnapshotSchema.parse(await client.request("state.get", {}));
    const interruptedSnapshot = this.interruptedRead(identity, client);
    if (interruptedSnapshot) return interruptedSnapshot;
    if (!this.current(identity)) {
      if (!this.observedReplacement(identity))
        return this.retained("unavailable", "AgentVoice observer disconnected. Reconnecting…");
      this.diagnose(
        "observer.identity",
        new SocketFailure("Call identity changed", "stale_generation"),
      );
      this.resetCall();
      return empty("connecting");
    }
    if (
      before.instanceId !== identity.instanceId ||
      before.generation !== identity.generation ||
      before.runtime.workspace !== identity.workspace ||
      before.runtime.mainThreadId !== identity.threadId ||
      !this.current(identity)
    ) {
      this.diagnose(
        "events.snapshot",
        new SocketFailure("Event snapshot identity changed", "stale_generation"),
      );
      this.resetCall();
      return empty("connecting");
    }
    const root = before.threads.find((thread) => thread.id === identity.threadId);
    const params = {
      expectedInstanceId: identity.instanceId,
      expectedGeneration: identity.generation,
      rootThreadId: identity.threadId,
      threadId: identity.threadId,
    };
    this.loadHistoryPage(identity, params);
    this.stage = "conversation.live";
    const live = liveSchema.parse(await client.request("conversation.live.get", params));
    const interruptedLive = this.interruptedRead(identity, client);
    if (interruptedLive) return interruptedLive;
    if (!this.current(identity)) {
      if (!this.observedReplacement(identity))
        return this.retained("unavailable", "AgentVoice observer disconnected. Reconnecting…");
      this.diagnose(
        "observer.identity",
        new SocketFailure("Call identity changed", "stale_generation"),
      );
      this.resetCall();
      return empty("connecting");
    }
    if (
      live.instanceId !== identity.instanceId ||
      live.generation !== identity.generation ||
      live.threadId !== identity.threadId ||
      !this.current(identity)
    ) {
      this.diagnose(
        "conversation.live",
        new SocketFailure("Live conversation identity changed", "stale_generation"),
      );
      this.resetCall();
      return empty("connecting");
    }
    this.verifiedClient = client;
    this.controls.observe(
      root?.turn ?? undefined,
      this.actionable(identity) &&
        (root?.status === "idle" ||
          (root?.status === "active" && root.turn?.status === "inProgress")),
      before.sequence,
    );
    if (root?.status === "active" && !root.turn) {
      try {
        this.stage = "conversation.turns";
        const turns = turnsSchema.parse(
          await this.readTurns(identity, {
            ...params,
            limit: 1,
            sortDirection: "desc",
          }),
        );
        if (
          turns.instanceId !== identity.instanceId ||
          turns.generation !== identity.generation ||
          turns.threadId !== identity.threadId ||
          turns.rootThreadId !== identity.threadId
        )
          throw new SocketFailure("Turn read identity changed", "stale_generation");
        if (this.current(identity))
          this.controls.observe(turns.data[0], this.actionable(identity), live.throughSequence);
        else if (this.observedReplacement(identity))
          throw new SocketFailure("Turn read identity changed", "stale_generation");
      } catch (error) {
        this.diagnose("conversation.turns", error);
        if (this.replacementFailure(error)) throw error;
        /* Transcript reads remain available while the active turn cannot be confirmed. */
      }
    }
    const messages = new Map(this.history.map((entry) => [itemKey(entry), agentMessage(entry)]));
    for (const entry of live.items) {
      // Incomplete live text cannot replace canonical history or establish delta overlap.
      if (entry.complete || !messages.has(itemKey(entry)))
        messages.set(itemKey(entry), agentMessage(entry, entry.completed));
    }
    let voiceNotice = this.voice.notice;
    try {
      if (!this.tail) {
        const recording = savedRecordings(this.stateDir, identity.workspace).find(
          (row) => row.threadId === identity.threadId,
        );
        if (recording) this.tail = new VoiceRecordingTail(recording.path, identity);
      }
      if (this.tail) {
        // Drain available chunks, including a long record split across reads, with a per-poll budget.
        for (let count = 0; count < 32; count++) {
          const lines = this.tail.read();
          for (const line of lines) this.voice.accept(line, identity.threadId);
          if (lines.length === 0 && this.tail.initialHistoryLoaded) break;
        }
      } else voiceNotice = "Waiting for the voice transcript.";
    } catch (error) {
      this.diagnose("voice.tail", error);
      voiceNotice = "Voice transcript unavailable. Reconnecting…";
      this.tail?.close();
      this.tail = undefined;
    }
    const interruptedFinal = this.interruptedRead(identity, client);
    if (interruptedFinal) return interruptedFinal;
    if (!this.current(identity)) {
      if (!this.observedReplacement(identity))
        return this.retained("unavailable", "AgentVoice observer disconnected. Reconnecting…");
      this.resetCall();
      return empty("connecting");
    }
    if (this.actionable(identity)) void this.controls.drain();
    return {
      phase: this.sessionPhase(identity),
      id: this.viewId,
      persistenceScope: persistenceScope(identity.workspace, identity.threadId),
      voice: this.voice.messages(),
      agent: [...messages.values()].filter((message) => message !== undefined),
      agentHistoryLoading: !this.initialHistorySettled,
      voiceHistoryLoading: this.tail ? !this.tail.initialHistoryLoaded : false,
      agentControls: this.controls.view(),
      voiceNotice: voiceNotice ?? this.voice.notice,
      agentNotice:
        this.historyNotice ??
        (live.items.some((entry) => !entry.complete)
          ? "Some live text is incomplete; waiting for the completed item."
          : undefined),
    };
  }

  private loadHistoryPage(identity: Identity, params: Record<string, unknown>) {
    if (
      this.historyPending ||
      Date.now() < this.historyRetryAt ||
      (this.loadedRevision === this.historyRevision && this.historyRetryAt === 0)
    )
      return;
    if (!this.pass) {
      this.pass = { rows: [], bytes: 0, revision: this.historyRevision };
      if (!this.initialHistorySettled) {
        const initial = this.pass;
        this.historyTimer = setTimeout(() => {
          if (!this.current(identity) || this.pass !== initial) return;
          this.publishHistory(initial, "Showing recent messages while earlier history loads.");
          this.historyRetryAt = Date.now() + this.historyRetryMs;
        }, this.initialHistoryBudgetMs);
      }
    }
    const pass = this.pass;
    const attempt: HistoryAttempt = {};
    this.historyAttempt = attempt;
    this.historyPending = true;
    if (!this.initialHistorySettled) this.historyNotice = "Loading earlier messages…";
    void this.historyPage(identity, pass, attempt, params)
      .then(({ raw, client }) => {
        if (
          !this.current(identity) ||
          this.pass !== pass ||
          this.historyAttempt !== attempt ||
          attempt.client !== client ||
          this.historyClient !== client
        )
          return;
        const page = historySchema.parse(raw);
        if (
          page.instanceId !== identity.instanceId ||
          page.generation !== identity.generation ||
          page.threadId !== identity.threadId ||
          page.rootThreadId !== identity.threadId
        )
          throw new SocketFailure("History identity changed", "stale_generation");
        pass.rows.push(...page.data);
        pass.bytes += Buffer.byteLength(JSON.stringify(page.data));
        const bounded = pass.rows.length >= 10_000 || pass.bytes >= 8 * 1024 * 1024;
        this.historyNotice = bounded
          ? "Showing the latest available history (viewer limit reached)."
          : page.nextCursor
            ? "Loading earlier messages…"
            : undefined;
        if (!page.nextCursor || bounded) {
          // Keep incomplete passes private: prepending every page makes the following scroller walk.
          this.publishHistory(pass, this.historyNotice);
        } else pass.cursor = page.nextCursor;
      })
      .catch((error) => {
        if (
          !this.current(identity) ||
          this.pass !== pass ||
          this.historyAttempt !== attempt ||
          (attempt.client !== undefined && this.historyClient !== attempt.client)
        )
          return;
        this.diagnose("history.page", error);
        if (this.replacementFailure(error)) {
          this.resetCall();
          this.retryAt = 0;
          return;
        }
        const notice = "Earlier Agent history is unavailable. Retrying in the background.";
        if (!this.initialHistorySettled) this.publishHistory(pass, notice);
        else {
          this.pass = undefined;
          this.historyNotice = notice;
        }
        this.historyRetryAt = Date.now() + this.historyRetryMs;
      })
      .finally(() => {
        if (
          this.historyAttempt !== attempt ||
          (attempt.client !== undefined && this.historyClient !== attempt.client)
        )
          return;
        if (attempt.closed && this.historyClient === attempt.client) this.historyClient = undefined;
        this.historyAttempt = undefined;
        this.historyPending = false;
        // Paging is a host task, not one page per browser poll.
        if (this.current(identity) && this.pass === pass) this.loadHistoryPage(identity, params);
      });
  }

  private async historyPage(
    identity: Identity,
    pass: HistoryPass,
    attempt: HistoryAttempt,
    params: Record<string, unknown>,
  ) {
    const client = await this.backgroundClient(identity);
    if (!this.current(identity) || this.pass !== pass || this.historyAttempt !== attempt)
      throw new Error("History attempt changed");
    attempt.client = client;
    const raw = await client.request("conversation.items.list", {
      ...params,
      sortDirection: "desc",
      limit: 50,
      ...(pass.cursor ? { cursor: pass.cursor } : {}),
    });
    return { raw, client };
  }

  private async readTurns(identity: Identity, params: Record<string, unknown>) {
    const client = await ControlSocket.connect(
      eventSocketPath(this.stateDir, identity.instanceId),
      EVENT_PROTOCOL_VERSION,
    );
    try {
      if (!this.current(identity)) throw new Error("Turn read attempt changed");
      return await client.request("conversation.turns.list", params);
    } finally {
      client.close();
    }
  }

  private backgroundClient(identity: Identity): Promise<ControlSocket> {
    if (this.historyClient) return Promise.resolve(this.historyClient);
    if (this.historyConnectPending) return this.historyConnectPending;
    const pending = ControlSocket.connect(
      eventSocketPath(this.stateDir, identity.instanceId),
      EVENT_PROTOCOL_VERSION,
    ).then((client) => {
      if (this.historyConnectPending !== pending || !this.current(identity)) {
        client.close();
        throw new Error("History attempt changed");
      }
      this.historyClient = client;
      void client.done.then(() => {
        if (this.historyClient !== client) return;
        const attempt = this.historyAttempt;
        if (attempt?.client === client) attempt.closed = true;
        else this.historyClient = undefined;
        this.diagnose("history.closed", client.error() ?? new Error("History socket disconnected"));
      });
      return client;
    });
    this.historyConnectPending = pending;
    void pending.then(
      () => {
        if (this.historyConnectPending === pending) this.historyConnectPending = undefined;
      },
      (error) => {
        if (this.historyConnectPending === pending) this.historyConnectPending = undefined;
        this.diagnose("history.connect", error);
      },
    );
    return pending;
  }

  private publishHistory(pass: HistoryPass, notice?: string) {
    this.history = [...pass.rows].reverse();
    this.loadedRevision = pass.revision;
    this.initialHistorySettled = true;
    this.historyNotice = notice;
    this.historyRetryAt = 0;
    this.pass = undefined;
    clearTimeout(this.historyTimer);
    this.historyTimer = undefined;
    this.readAt = 0;
  }
}
