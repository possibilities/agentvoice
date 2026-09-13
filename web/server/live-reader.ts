import { randomUUID } from "node:crypto";
import { z } from "zod";
import { observeAttachmentServer, VoiceRecordingTail } from "../../src/attachment/session.ts";
import { discoverControllerStatus } from "../../src/control/discovery.ts";
import { EVENT_PROTOCOL_VERSION } from "../../src/events/contract.ts";
import { readResultSchema } from "../../src/events/conversation.ts";
import { liveSnapshotSchema } from "../../src/events/conversation-projection.ts";
import { eventSnapshotSchema } from "../../src/events/schema.ts";
import { eventSocketPath } from "../../src/events/socket.ts";
import { ControlSocket } from "../../src/ipc/control-client.ts";
import { savedRecordings } from "../../src/recording/store.ts";
import type { LiveView } from "../src/types.ts";
import { type AgentItem, agentMessage, itemKey, VoiceMessages } from "./messages.ts";

const liveSchema = liveSnapshotSchema.extend({ instanceId: z.string(), generation: z.number() });
const historySchema = readResultSchema.options[4]!.extend({
  instanceId: z.string(),
  generation: z.number(),
});
const empty = (phase: LiveView["phase"]): LiveView => ({ phase, id: phase, voice: [], agent: [] });
type Observer = Awaited<ReturnType<typeof observeAttachmentServer>>;
type Identity = {
  workspace: string;
  threadId: string;
  instanceId: string;
  generation: number;
  clientId: string;
};
type HistoryPass = { rows: AgentItem[]; cursor?: string; bytes: number; revision: number };

/** One shared read-only adapter. The browser can neither choose sockets nor submit RPC methods. */
export class LiveReader {
  private observer?: Observer;
  private eventClient?: ControlSocket;
  private identity?: Identity;
  private viewId = "";
  private tail?: VoiceRecordingTail;
  private voice = new VoiceMessages();
  private history: AgentItem[] = [];
  private pass?: HistoryPass;
  private historyRevision = 0;
  private loadedRevision = -1;
  private historyPending = false;
  private historyNotice?: string;
  private closed = false;
  private pending?: Promise<LiveView>;
  private cached = empty("connecting");
  private readAt = 0;

  constructor(private readonly stateDir: string) {}

  read(): Promise<LiveView> {
    if (this.closed) return Promise.resolve(empty("offline"));
    if (this.pending) return this.pending;
    if (Date.now() - this.readAt < 250) return Promise.resolve(this.cached);
    this.pending = this.update()
      .catch(() => {
        this.resetCall();
        this.observer?.socket.close();
        this.observer = undefined;
        return empty("unavailable");
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

  private resetCall() {
    this.eventClient?.close();
    this.eventClient = undefined;
    this.identity = undefined;
    this.tail?.close();
    this.tail = undefined;
    this.voice = new VoiceMessages();
    this.history = [];
    this.pass = undefined;
    this.historyRevision = 0;
    this.loadedRevision = -1;
    this.historyPending = false;
    this.historyNotice = undefined;
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
      state?.availability === "connected" &&
      state.clientId === identity.clientId &&
      state.workspace === identity.workspace &&
      state.threadId === identity.threadId &&
      (state.generation === undefined || state.generation === identity.generation)
    );
  }

  private async update(): Promise<LiveView> {
    if (!this.observer) {
      try {
        const observer = await observeAttachmentServer(this.stateDir);
        if (this.closed) {
          observer.socket.close();
          return empty("offline");
        }
        this.observer = observer;
        void observer.socket.done.then(() => {
          if (this.observer === observer) {
            this.observer = undefined;
            this.resetCall();
          }
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ECONNREFUSED") return empty("offline");
        throw error;
      }
    }
    const state = this.observer.latest();
    if (
      state.availability !== "connected" ||
      !state.clientId ||
      !state.workspace ||
      !state.threadId
    ) {
      this.resetCall();
      return empty(
        state.availability === "unavailable"
          ? "unavailable"
          : state.busy
            ? "connecting"
            : "waiting",
      );
    }
    if (this.identity && !this.current(this.identity)) this.resetCall();
    if (!this.identity) {
      const selected = await discoverControllerStatus(
        this.stateDir,
        state.workspace,
        state.threadId,
      ).catch((error: unknown) => {
        // Protocol 6 added mutations; the read-only status/event contracts of 5 remain usable.
        if (!(error instanceof Error) || !error.message.startsWith("no live AgentVoice controller"))
          throw error;
        return discoverControllerStatus(this.stateDir, state.workspace!, state.threadId!, 5);
      });
      if (this.closed) return empty("offline");
      const identity: Identity = {
        workspace: state.workspace,
        threadId: state.threadId,
        clientId: state.clientId,
        instanceId: selected.status.instanceId,
        generation: selected.status.generation,
      };
      this.identity = identity;
      this.viewId = randomUUID();
      const client = await ControlSocket.connect(
        eventSocketPath(this.stateDir, identity.instanceId),
        EVENT_PROTOCOL_VERSION,
        (frame) => {
          const data = frame["data"] as Record<string, unknown> | undefined;
          if (
            !this.current(identity) ||
            data?.["instanceId"] !== identity.instanceId ||
            data?.["generation"] !== identity.generation
          )
            return;
          if (data?.["threadId"] != null && data["threadId"] !== identity.threadId) return;
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
        },
      );
      if (!this.current(identity)) {
        client.close();
        this.resetCall();
        return empty("connecting");
      }
      this.eventClient = client;
      void client.done.then(() => {
        if (this.eventClient === client) this.resetCall();
      });
      await client.request("event.subscribe", { events: ["conversation.*"] });
    }
    const identity = this.identity!;
    const client = this.eventClient!;
    const before = eventSnapshotSchema.parse(await client.request("state.get", {}));
    if (
      before.instanceId !== identity.instanceId ||
      before.generation !== identity.generation ||
      before.runtime.workspace !== identity.workspace ||
      before.runtime.mainThreadId !== identity.threadId ||
      !this.current(identity)
    ) {
      this.resetCall();
      return empty("connecting");
    }
    const params = {
      expectedInstanceId: identity.instanceId,
      expectedGeneration: identity.generation,
      rootThreadId: identity.threadId,
      threadId: identity.threadId,
    };
    this.loadHistoryPage(identity, client, params);
    const live = liveSchema.parse(await client.request("conversation.live.get", params));
    if (
      live.instanceId !== identity.instanceId ||
      live.generation !== identity.generation ||
      live.threadId !== identity.threadId ||
      !this.current(identity)
    ) {
      this.resetCall();
      return empty("connecting");
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
          if (lines.length === 0) break;
        }
      } else voiceNotice = "Waiting for the voice transcript.";
    } catch {
      voiceNotice = "Voice transcript unavailable. Reconnecting…";
      this.tail?.close();
      this.tail = undefined;
    }
    if (!this.current(identity)) {
      this.resetCall();
      return empty("connecting");
    }
    return {
      phase: "live",
      id: this.viewId,
      voice: this.voice.messages(),
      agent: [...messages.values()].filter((message) => message !== undefined),
      agentHistoryLoading: this.loadedRevision === -1,
      voiceNotice: voiceNotice ?? this.voice.notice,
      agentNotice:
        this.historyNotice ??
        (live.items.some((entry) => !entry.complete)
          ? "Some live text is incomplete; waiting for the completed item."
          : undefined),
    };
  }

  private loadHistoryPage(
    identity: Identity,
    client: ControlSocket,
    params: Record<string, unknown>,
  ) {
    if (this.historyPending || this.loadedRevision === this.historyRevision) return;
    this.pass ??= { rows: [], bytes: 0, revision: this.historyRevision };
    const pass = this.pass;
    this.historyPending = true;
    this.historyNotice = "Loading earlier messages…";
    void client
      .request("conversation.items.list", {
        ...params,
        sortDirection: "desc",
        limit: 50,
        ...(pass.cursor ? { cursor: pass.cursor } : {}),
      })
      .then((raw) => {
        if (!this.current(identity) || this.pass !== pass) return;
        const page = historySchema.parse(raw);
        if (
          page.instanceId !== identity.instanceId ||
          page.generation !== identity.generation ||
          page.threadId !== identity.threadId ||
          page.rootThreadId !== identity.threadId
        )
          throw new Error("History identity changed");
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
          this.history = pass.rows.reverse();
          this.loadedRevision = pass.revision;
          this.pass = undefined;
        } else pass.cursor = page.nextCursor;
      })
      .catch(() => {
        if (!this.current(identity)) return;
        this.pass = undefined;
        this.historyNotice = "Agent history unavailable. Retrying…";
      })
      .finally(() => {
        if (this.current(identity)) this.historyPending = false;
      });
  }
}
