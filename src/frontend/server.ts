import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { readSessionMarker } from "../core/session-marker.ts";
import type { ClientMediaMessage, ServerMediaMessage } from "../frontend/media-protocol.ts";
import { type JsonPeer, JsonSocketServer } from "../ipc/json-socket.ts";
import { stateDirectory } from "../paths.ts";
import { createCall } from "../runtime-control/controller.ts";
import type { LaunchProvenance } from "../runtime-control/protocol.ts";
import { currentWorkspace, NoDefaultWorkspaceError } from "../workspace.ts";
import {
  type CallParams,
  callParamsSchema,
  FRONTEND_VERSION,
  type FrontendCommand,
  type FrontendState,
  frontendCommandSchema,
  frontendMediaInputSchema,
  frontendSocketPath,
  frontendState,
} from "./protocol.ts";

export interface Call {
  start(): Promise<void>;
  state(): FrontendState;
  identity?(): { workspace: string; threadId: string; generation?: number };
  command(command: FrontendCommand): void;
  clientMedia?(message: ClientMediaMessage): void;
  /** Detach media without stopping native work; reattach starts a fresh media peer. */
  setFrontendAttached(attached: boolean): Promise<void>;
  close(): Promise<void>;
}
type Session = {
  peer: JsonPeer;
  clientId?: string;
  incarnation: number;
  call?: Call;
  closed: boolean;
  done: Promise<void>;
  end(): void;
};

class FrontendFailure extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

type TakeoverChallenge = {
  peer: JsonPeer;
  clientId: string;
  incumbent: number;
  expiresAt: number;
};

/** One retained workspace session; a single frontend owns its disposable media attachment. */
export class VoiceServer {
  private readonly socket: JsonSocketServer;
  private session?: Session;
  private call?: Call;
  private creating?: Promise<Call>;
  private boot?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private poisoned = false;
  private nextIncarnation = 0;
  private admission?: { peer: JsonPeer; clientId: string };
  private readonly closedPeers = new WeakSet<JsonPeer>();
  private readonly takeoverChallenges = new Map<string, TakeoverChallenge>();
  private readonly observers = new Set<JsonPeer>();
  constructor(
    readonly path: string,
    private readonly create: (
      changed: () => void,
      params: { clientId: string } | undefined,
      sendMedia: (message: ServerMediaMessage) => void,
    ) => Promise<Call>,
    private readonly report: (message: string) => void = console.error,
    private readonly workspace?: () => string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.socket = new JsonSocketServer(path, {
      version: FRONTEND_VERSION,
      handle: async (request, peer) => {
        const reply = (ok: boolean, result: unknown, code?: string) =>
          peer.send({
            v: FRONTEND_VERSION,
            type: "response",
            id: request.id,
            ok,
            ...(ok
              ? { result }
              : { error: { message: result, ...(code === undefined ? {} : { code }) } }),
          });
        if (request.method === "discover" && request.params === undefined) {
          try {
            const identity = this.call?.identity?.();
            reply(true, {
              busy: !!this.session || !!this.admission,
              workspace: identity?.workspace || this.workspace?.() || null,
              threadId: identity?.threadId || null,
            });
          } catch (error) {
            reply(false, String(error));
          }
          return;
        }
        if (request.method === "observe" && request.params === undefined) {
          if (this.session?.peer === peer || this.admission?.peer === peer) {
            reply(false, "Call owners cannot become observers");
            return;
          }
          this.observers.add(peer);
          reply(true, this.observation());
          return;
        }
        const callParams = callParamsSchema.safeParse(request.params);
        if (request.method === "call" && callParams.success) {
          if (this.observers.has(peer)) {
            reply(false, "Observers cannot own calls");
            return;
          }
          try {
            reply(true, await this.requestCall(peer, callParams.data));
          } catch (error) {
            const failure =
              error instanceof FrontendFailure
                ? error
                : new FrontendFailure("Server is unavailable", "server_unavailable");
            reply(false, failure.message, failure.code);
          }
          return;
        }
        if (request.method === "input" && this.session?.peer === peer && !this.session.closed) {
          const command = frontendCommandSchema.safeParse(request.params);
          if (!command.success || !this.session.call) {
            reply(false, "Call is not ready for input");
            return;
          }
          this.session.call.command(command.data);
          reply(true, null);
          return;
        }
        if (
          request.method === "client-media" &&
          this.session?.peer === peer &&
          !this.session.closed
        ) {
          const message = frontendMediaInputSchema.safeParse(request.params);
          if (!message.success || !this.session.call?.clientMedia) {
            reply(false, "Browser media is not available for this call");
            return;
          }
          this.session.call.clientMedia(message.data);
          reply(true, null);
          return;
        }
        reply(false, "Unknown method or frontend does not own this call");
      },
      closed: (peer) => {
        this.closedPeers.add(peer);
        this.observers.delete(peer);
        for (const [token, challenge] of this.takeoverChallenges)
          if (challenge.peer === peer) this.takeoverChallenges.delete(token);
        if (this.session?.peer !== peer) return;
        this.endSession(this.session, false);
      },
    });
  }
  private unavailable(): void {
    if (this.poisoned)
      throw new FrontendFailure(
        "Previous media cleanup failed. Conversation and agent work are retained; restart the server before connecting again.",
        "media_detach_failed",
      );
    if (this.closed) throw new FrontendFailure("Server is unavailable", "server_unavailable");
  }
  private createChallenge(peer: JsonPeer, clientId: string, incumbent: Session) {
    const now = this.now();
    while (this.takeoverChallenges.size >= 256)
      this.takeoverChallenges.delete(this.takeoverChallenges.keys().next().value!);
    const token = randomBytes(32).toString("base64url");
    this.takeoverChallenges.set(token, {
      peer,
      clientId,
      incumbent: incumbent.incarnation,
      expiresAt: now + 30_000,
    });
    return { takeoverRequired: true as const, token };
  }
  private admit(peer: JsonPeer, clientId: string): null {
    this.unavailable();
    if (this.closedPeers.has(peer))
      throw new FrontendFailure("Requesting frontend disconnected", "requester_closed");
    if (this.observers.has(peer))
      throw new FrontendFailure("Observers cannot own calls", "observer_cannot_call");
    if (this.session) throw new FrontendFailure("Server media is already owned", "server_busy");
    const ended = Promise.withResolvers<void>();
    const session: Session = {
      peer,
      clientId,
      incarnation: ++this.nextIncarnation,
      closed: false,
      done: Promise.resolve(),
      end: ended.resolve,
    };
    this.session = session;
    this.publish();
    session.done = this.run(session, ended.promise);
    return null;
  }
  private endSession(session: Session, closePeer: boolean): void {
    if (!session.closed) {
      session.closed = true;
      this.publish();
      session.end();
      // End a hold immediately, before asynchronous media detachment.
      try {
        session.call?.command({ action: "release" });
      } catch (error) {
        this.report(`Frontend hold release failed: ${String(error)}`);
      }
    }
    if (closePeer) session.peer.close();
  }
  private async replace(peer: JsonPeer, clientId: string, incumbent: Session): Promise<null> {
    if (this.admission)
      throw new FrontendFailure(
        "Another media takeover is already in progress",
        "takeover_in_progress",
      );
    this.admission = { peer, clientId };
    try {
      this.endSession(incumbent, true);
      await incumbent.done;
      this.unavailable();
      if (this.closedPeers.has(peer))
        throw new FrontendFailure("Requesting frontend disconnected", "requester_closed");
      if (this.session)
        throw new FrontendFailure("Media ownership changed during takeover", "takeover_stale");
      return this.admit(peer, clientId);
    } finally {
      if (this.admission?.peer === peer && this.admission.clientId === clientId) {
        this.admission = undefined;
        this.publish();
      }
    }
  }
  private async requestCall(peer: JsonPeer, params: CallParams) {
    const mode = params.takeover;
    // Preserve the exact v3 failure shape and message for clients that do not opt into takeover.
    if (mode === undefined) {
      if (this.closed || this.poisoned || this.session || this.admission)
        throw new FrontendFailure("Server is busy or unavailable");
      return this.admit(peer, params.clientId);
    }
    this.unavailable();
    if (this.closedPeers.has(peer))
      throw new FrontendFailure("Requesting frontend disconnected", "requester_closed");
    const incumbent = this.session;
    if (incumbent?.peer === peer)
      throw new FrontendFailure("Frontend already owns this call", "already_owner");
    if (mode === "confirm") {
      if (this.admission)
        throw new FrontendFailure(
          "Another media takeover is already in progress",
          "takeover_in_progress",
        );
      return incumbent
        ? this.createChallenge(peer, params.clientId, incumbent)
        : this.admit(peer, params.clientId);
    }
    if (mode === "auto") {
      if (this.admission)
        throw new FrontendFailure(
          "Another media takeover is already in progress",
          "takeover_in_progress",
        );
      return incumbent
        ? this.replace(peer, params.clientId, incumbent)
        : this.admit(peer, params.clientId);
    }

    const challenge = this.takeoverChallenges.get(mode.token);
    if (!challenge || challenge.peer !== peer || challenge.clientId !== params.clientId)
      throw new FrontendFailure("Takeover confirmation is invalid", "invalid_takeover_token");
    this.takeoverChallenges.delete(mode.token);
    if (this.admission)
      throw new FrontendFailure(
        "Another media takeover is already in progress",
        "takeover_in_progress",
      );
    if (!incumbent) return this.admit(peer, params.clientId);
    if (challenge.expiresAt <= this.now() || incumbent.incarnation !== challenge.incumbent)
      return this.createChallenge(peer, params.clientId, incumbent);
    return this.replace(peer, params.clientId, incumbent);
  }
  start() {
    return this.socket.start();
  }
  /** Restore native work without reserving media; a later frontend attaches to this call. */
  async restoreWorkspaceSession(): Promise<void> {
    if (this.closed || this.poisoned) throw new Error("Server is unavailable");
    await this.retain(undefined);
    await this.boot;
    this.changed();
  }
  private observation() {
    const session = this.session;
    const identity = this.call?.identity?.();
    return {
      busy: !!session || !!this.admission,
      availability:
        this.closed || this.poisoned
          ? "unavailable"
          : session
            ? session.closed
              ? "closing"
              : "connected"
            : this.admission
              ? "closing"
              : "idle",
      clientId: session?.clientId ?? null,
      workspace: identity?.workspace || null,
      threadId: identity?.threadId || null,
      ...(identity?.generation === undefined ? {} : { generation: identity.generation }),
      state: session?.call && !session.closed ? frontendState(session.call.state()) : null,
    };
  }
  private publish() {
    const observation = this.observation();
    for (const peer of this.observers)
      peer.send({ v: FRONTEND_VERSION, type: "observation", observation });
  }
  private changed() {
    const session = this.session;
    if (session && !session.closed && this.call)
      session.peer.send({
        v: FRONTEND_VERSION,
        type: "state",
        state: frontendState(this.call.state()),
      });
    this.publish();
  }
  private retain(params: { clientId: string } | undefined): Promise<Call> {
    if (this.creating) return this.creating;
    this.creating = this.create(
      () => this.changed(),
      params,
      (message) => {
        const session = this.session;
        if (session && !session.closed)
          session.peer.send({ v: FRONTEND_VERSION, type: "client-media", message });
      },
    )
      .then((call) => {
        this.call = call;
        if (!this.closed) {
          this.boot = call.start();
          // Observe rejection even if the first frontend has already detached.
          void this.boot.catch((error) => this.report(`Session startup failed: ${String(error)}`));
        }
        return call;
      })
      .catch((error) => {
        // Factory failure owns its cleanup; a later frontend may retry creation.
        if (!this.call) this.creating = undefined;
        throw error;
      });
    return this.creating;
  }
  private async run(session: Session, ended: Promise<void>) {
    try {
      session.call = await this.retain(
        session.clientId ? { clientId: session.clientId } : undefined,
      );
      if (session.closed) return;
      await session.call.setFrontendAttached(true);
      this.changed();
      await Promise.race([this.boot, ended]);
      this.changed();
      await ended;
    } catch (error) {
      this.report(`Frontend attachment failed: ${String(error)}`);
      session.peer.close();
    } finally {
      session.closed = true;
      this.publish();
      try {
        // Admission remains reserved until the old realtime session has been fenced/stopped.
        await session.call?.setFrontendAttached(false);
      } catch (error) {
        this.poisoned = true;
        this.report(`Media detach failed; workspace work is retained: ${String(error)}`);
      }
      if (this.session === session) this.session = undefined;
      this.publish();
    }
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true;
      this.publish();
      const session = this.session;
      try {
        if (session) {
          this.endSession(session, true);
          await session.done;
        }
        const call = await this.creating?.catch(() => undefined);
        await call?.close();
        await this.boot?.catch(() => {});
      } finally {
        this.socket.close();
      }
    })();
    return this.closing;
  }
}

export function pinCallWorkspace(
  provenance: LaunchProvenance,
  workspace: string,
): LaunchProvenance {
  return {
    ...provenance,
    parsed: { ...provenance.parsed, values: { ...provenance.parsed.values, workspace } },
  };
}

export async function runServer(
  provenance: LaunchProvenance,
  version: string,
  workspace?: string,
  endpointWorkspace?: string,
) {
  const stateDir = stateDirectory(process.env, homedir());
  let pinnedWorkspace = workspace;
  let restoreWorkspace: string | undefined;
  try {
    const selected = pinnedWorkspace ?? currentWorkspace(stateDir, false);
    if (readSessionMarker(selected)) {
      pinnedWorkspace = selected;
      restoreWorkspace = selected;
    }
  } catch (error) {
    if (!(error instanceof NoDefaultWorkspaceError))
      console.error(`Existing workspace session was not restored: ${String(error)}`);
  }
  const selectedWorkspace = () => (pinnedWorkspace ??= currentWorkspace(stateDir));
  const server = new VoiceServer(
    frontendSocketPath(stateDir, endpointWorkspace),
    async (changed, _params, sendMedia) => {
      let notice: string | undefined;
      const pinned = pinCallWorkspace(provenance, selectedWorkspace());
      const call = await createCall(
        pinned,
        version,
        () => {
          const next = call.controller.state().notice;
          if (next && next !== notice) {
            notice = next;
            console.error(next);
          }
          changed();
        },
        {
          onMedia: sendMedia,
          frontendAttached: false,
        },
      );
      const controller = call.controller;
      return {
        start: () => controller.start(),
        state: () => controller.state(),
        identity: () => ({
          workspace: controller.status().workspace || pinned.parsed.values["workspace"]!,
          threadId: controller.status().threadId,
          generation: controller.status().generation,
        }),
        close: call.close,
        setFrontendAttached: (attached) => controller.setFrontendAttached(attached),
        clientMedia: (message) => call.controller.clientMedia(message),
        command: (command) => {
          if (command.action === "mute") {
            (command.target === "mic" ? controller.microphone : controller.speaker).setMuted(
              command.muted,
            );
          } else if (command.action === "release") controller.microphone.releaseUnmute("frontend");
          else if (controller.status().runtime.phase === "ready")
            controller.microphone.beginUnmute("frontend");
          controller.syncMute();
        },
      };
    },
    console.error,
    () => pinnedWorkspace ?? currentWorkspace(stateDir, false),
  );
  const stopped = Promise.withResolvers<void>();
  let network: import("../network/gateway.ts").NetworkGateway | undefined;
  const stop = () => stopped.resolve();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);
  try {
    await server.start();
    if (restoreWorkspace)
      void server
        .restoreWorkspaceSession()
        .catch((error) => console.error(`Workspace session restore failed: ${String(error)}`));
    const { loadNetworkSettings } = await import("../network/credentials.ts");
    const settings = loadNetworkSettings(stateDir, endpointWorkspace);
    if (settings) {
      const { NetworkGateway } = await import("../network/gateway.ts");
      network = new NetworkGateway(
        stateDir,
        frontendSocketPath(stateDir, endpointWorkspace),
        settings,
        undefined,
        endpointWorkspace,
      );
      await network.start();
      console.log(
        `Authenticated client API available behind TLS proxy on loopback port ${network.port}`,
      );
    }
    console.log(`AgentVoice server waiting in ${workspace ?? "the current default workspace"}`);
    await stopped.promise;
  } finally {
    await network?.close();
    await server.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("SIGHUP", stop);
  }
}
