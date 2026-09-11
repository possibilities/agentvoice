import { homedir } from "node:os";
import type { ClientMediaMessage, ServerMediaMessage } from "../frontend/media-protocol.ts";
import { type JsonPeer, JsonSocketServer } from "../ipc/json-socket.ts";
import { stateDirectory } from "../paths.ts";
import { createCall } from "../runtime-control/controller.ts";
import type { LaunchProvenance } from "../runtime-control/protocol.ts";
import { currentWorkspace } from "../workspace.ts";
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
  identity?(): { workspace: string; threadId: string };
  command(command: FrontendCommand): void;
  clientMedia?(message: ClientMediaMessage): void;
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

/** One socket owner per workspace; one frontend owns each complete call lifetime. */
export class VoiceServer {
  private readonly socket: JsonSocketServer;
  private session?: Session;
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
            const identity = this.session?.call?.identity?.();
            reply(true, {
              busy: !!this.session,
              workspace: this.session ? identity?.workspace || null : this.workspace?.() || null,
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
        // End a hold immediately, before asynchronous owned-process cleanup.
        this.session.call?.command({ action: "release" });
      },
    });
  }
  start() {
    return this.socket.start();
  }
  private observation() {
    const session = this.session;
    const identity = session?.call?.identity?.();
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
      state: session?.call && !session.closed ? frontendState(session.call.state()) : null,
    };
  }
  private publish() {
    const observation = this.observation();
    for (const peer of this.observers)
      peer.send({ v: FRONTEND_VERSION, type: "observation", observation });
  }
  private async run(session: Session, ended: Promise<void>) {
    let lastState = "";
    const changed = () => {
      if (session.closed || !session.call) return;
      const state = frontendState(session.call.state());
      const serialized = JSON.stringify(state);
      if (serialized === lastState) return;
      lastState = serialized;
      session.peer.send({ v: FRONTEND_VERSION, type: "state", state });
      this.publish();
    };
    let boot: Promise<void> | undefined;
    try {
      const params = session.clientId
        ? {
            clientId: session.clientId,
          }
        : undefined;
      session.call = await this.create(changed, params, (message) => {
        if (!session.closed)
          session.peer.send({ v: FRONTEND_VERSION, type: "client-media", message });
      });
      if (session.closed) return;
      changed();
      boot = session.call.start();
      await Promise.race([boot, ended]);
      changed();
      await ended;
    } catch (error) {
      this.report(`Call failed: ${String(error)}`);
      session.peer.close();
    } finally {
      session.closed = true;
      this.publish();
      try {
        await session.call?.close();
        await boot?.catch(() => {});
      } catch (error) {
        this.poisoned = true;
        this.report(`Call cleanup failed; restart the server: ${String(error)}`);
      }
      if (this.session === session) this.session = undefined;
      this.publish();
    }
  }
  async close() {
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
    } finally {
      this.socket.close();
    }
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
  const server = new VoiceServer(
    frontendSocketPath(stateDir, endpointWorkspace),
    async (changed, _params, sendMedia) => {
      let notice: string | undefined;
      const pinned = pinCallWorkspace(provenance, workspace ?? currentWorkspace(stateDir));
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
        },
      );
      const controller = call.controller;
      return {
        start: () => controller.start(),
        state: () => controller.state(),
        identity: () => ({
          workspace: controller.status().workspace || pinned.parsed.values["workspace"]!,
          threadId: controller.status().threadId,
        }),
        close: call.close,
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
    () => workspace ?? currentWorkspace(stateDir, false),
  );
  const stopped = Promise.withResolvers<void>();
  let network: import("../network/gateway.ts").NetworkGateway | undefined;
  const stop = () => stopped.resolve();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);
  try {
    await server.start();
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
