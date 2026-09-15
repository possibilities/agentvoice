import { homedir } from "node:os";
import { readSessionMarker } from "../core/session-marker.ts";
import type { ClientMediaMessage, ServerMediaMessage } from "../frontend/media-protocol.ts";
import { type JsonPeer, JsonSocketServer } from "../ipc/json-socket.ts";
import { stateDirectory } from "../paths.ts";
import { createCall } from "../runtime-control/controller.ts";
import type { LaunchProvenance } from "../runtime-control/protocol.ts";
import { currentWorkspace, NoDefaultWorkspaceError } from "../workspace.ts";
import {
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
  call?: Call;
  closed: boolean;
  done: Promise<void>;
  end(): void;
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
  ) {
    this.socket = new JsonSocketServer(path, {
      version: FRONTEND_VERSION,
      handle: (request, peer) => {
        const reply = (ok: boolean, result: unknown) =>
          peer.send({
            v: FRONTEND_VERSION,
            type: "response",
            id: request.id,
            ok,
            ...(ok ? { result } : { error: { message: result } }),
          });
        if (request.method === "discover" && request.params === undefined) {
          try {
            const identity = this.call?.identity?.();
            reply(true, {
              busy: !!this.session,
              workspace: identity?.workspace || this.workspace?.() || null,
              threadId: identity?.threadId || null,
            });
          } catch (error) {
            reply(false, String(error));
          }
          return;
        }
        if (request.method === "observe" && request.params === undefined) {
          if (this.session?.peer === peer) {
            reply(false, "Call owners cannot become observers");
            return;
          }
          this.observers.add(peer);
          reply(true, this.observation());
          return;
        }
        if (request.method === "call" && callParamsSchema.safeParse(request.params).success) {
          if (this.observers.has(peer)) {
            reply(false, "Observers cannot own calls");
            return;
          }
          if (this.closed || this.poisoned || this.session) {
            reply(false, "Server is busy or unavailable");
            return;
          }
          const ended = Promise.withResolvers<void>();
          const session: Session = {
            peer,
            clientId:
              request.params === undefined
                ? undefined
                : callParamsSchema.parse(request.params).clientId,
            closed: false,
            done: Promise.resolve(),
            end: ended.resolve,
          };
          this.session = session;
          this.publish();
          session.done = this.run(session, ended.promise);
          reply(true, null);
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
        this.observers.delete(peer);
        if (this.session?.peer !== peer) return;
        this.session.closed = true;
        this.publish();
        this.session.end();
        // End a hold immediately, before asynchronous media detachment.
        this.session.call?.command({ action: "release" });
      },
    });
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
      busy: !!session,
      availability:
        this.closed || this.poisoned
          ? "unavailable"
          : session
            ? session.closed
              ? "closing"
              : "connected"
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
          session.closed = true;
          session.peer.close();
          session.end();
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
    if (endpointWorkspace === undefined) {
      const { loadNetworkSettings } = await import("../network/credentials.ts");
      const settings = loadNetworkSettings(stateDir);
      if (settings) {
        const { NetworkGateway } = await import("../network/gateway.ts");
        network = new NetworkGateway(stateDir, frontendSocketPath(stateDir), settings);
        await network.start();
        console.log(
          `Authenticated client API available behind TLS proxy on loopback port ${network.port}`,
        );
      }
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
