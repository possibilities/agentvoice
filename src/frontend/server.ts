import { homedir } from "node:os";
import { type JsonPeer, JsonSocketServer } from "../ipc/json-socket.ts";
import { stateDirectory } from "../paths.ts";
import { createCall } from "../runtime-control/controller.ts";
import type { LaunchProvenance } from "../runtime-control/protocol.ts";
import { currentWorkspace } from "../workspace.ts";
import {
  FRONTEND_VERSION,
  type FrontendCommand,
  type FrontendState,
  frontendCommandSchema,
  frontendSocketPath,
  frontendState,
} from "./protocol.ts";

export interface Call {
  start(): Promise<void>;
  state(): FrontendState;
  identity?(): { workspace: string; threadId: string };
  command(command: FrontendCommand): void;
  close(): Promise<void>;
}
type Session = { peer: JsonPeer; call?: Call; closed: boolean; done: Promise<void>; end(): void };

/** One socket owner per workspace; one frontend owns each complete call lifetime. */
export class VoiceServer {
  private readonly socket: JsonSocketServer;
  private session?: Session;
  private closed = false;
  private poisoned = false;
  constructor(
    readonly path: string,
    private readonly create: (changed: () => void) => Promise<Call>,
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
        if (request.method === "call" && request.params === undefined) {
          if (this.closed || this.poisoned || this.session) {
            reply(false, "Server is busy or unavailable");
            return;
          }
          const ended = Promise.withResolvers<void>();
          const session: Session = {
            peer,
            closed: false,
            done: Promise.resolve(),
            end: ended.resolve,
          };
          this.session = session;
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
        reply(false, "Unknown method or frontend does not own this call");
      },
      closed: (peer) => {
        if (this.session?.peer !== peer) return;
        this.session.closed = true;
        this.session.end();
        // End a hold immediately, before asynchronous owned-process cleanup.
        this.session.call?.command({ action: "release" });
      },
    });
  }
  start() {
    return this.socket.start();
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
    };
    let boot: Promise<void> | undefined;
    try {
      session.call = await this.create(changed);
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
      try {
        await session.call?.close();
        await boot?.catch(() => {});
      } catch (error) {
        this.poisoned = true;
        this.report(`Call cleanup failed; restart the server: ${String(error)}`);
      }
      if (this.session === session) this.session = undefined;
    }
  }
  async close() {
    this.closed = true;
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
    async (changed) => {
      let notice: string | undefined;
      const pinned = pinCallWorkspace(provenance, workspace ?? currentWorkspace(stateDir));
      const call = await createCall(pinned, version, () => {
        const next = call.controller.state().notice;
        if (next && next !== notice) {
          notice = next;
          console.error(next);
        }
        changed();
      });
      const controller = call.controller;
      return {
        start: () => controller.start(),
        state: () => controller.state(),
        identity: () => ({
          workspace: controller.status().workspace || pinned.parsed.values["workspace"]!,
          threadId: controller.status().threadId,
        }),
        close: call.close,
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
  const stop = () => stopped.resolve();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);
  try {
    await server.start();
    console.log(`AgentVoice server waiting in ${workspace ?? "the current default workspace"}`);
    await stopped.promise;
  } finally {
    await server.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("SIGHUP", stop);
  }
}
