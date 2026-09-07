import { lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import type { VoiceHost, VoiceView } from "../console/state.ts";
import { createVoiceTui } from "../console/tui.ts";
import { stateDirectory } from "../paths.ts";
import {
  FRONTEND_VERSION,
  type FrontendCommand,
  type FrontendState,
  frontendSocketPath,
  frontendStateSchema,
} from "./protocol.ts";

export async function connectFrontend(
  path: string,
  changed: () => void = () => {},
  clientId?: string,
) {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(
        "No AgentVoice server is waiting. Check agentvoice service status, or run agentvoice server with matching --workspace selection.",
      );
    throw error;
  }
  if (
    !info.isSocket() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("Unsafe AgentVoice server socket");
  const ready = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  let accepted = false;
  let closed = false;
  let error: Error | undefined;
  let next = 0;
  let partial = "";
  let state: FrontendState = {
    available: false,
    phase: "waiting-ready",
    mic: { muted: false, effectiveMuted: true },
    speaker: { muted: false, effectiveMuted: true },
  };
  const socket = createConnection({ path });
  const fail = (cause: Error) => {
    error ??= cause;
    socket.destroy();
  };
  const timer = setTimeout(
    () => fail(new Error("AgentVoice server did not accept the call")),
    5000,
  );
  function send(method: string, params?: FrontendCommand | { clientId: string }) {
    if (closed || socket.destroyed) return;
    if (socket.writableLength > 64 * 1024) {
      fail(new Error("AgentVoice server is not reading input"));
      return;
    }
    socket.write(
      `${JSON.stringify({ v: FRONTEND_VERSION, type: "request", id: String(++next), method, ...(params ? { params } : {}) })}\n`,
    );
  }
  socket.setEncoding("utf8");
  socket.on("connect", () => send("call", clientId ? { clientId } : undefined));
  socket.on("data", (chunk) => {
    partial += chunk;
    if (Buffer.byteLength(partial) > 64 * 1024) {
      fail(new Error("Invalid AgentVoice server frame"));
      return;
    }
    for (;;) {
      const newline = partial.indexOf("\n");
      if (newline < 0) return;
      const line = partial.slice(0, newline);
      partial = partial.slice(newline + 1);
      try {
        const frame = JSON.parse(line);
        if (frame.v !== FRONTEND_VERSION) throw new Error("Incompatible AgentVoice server");
        if (frame.type === "response") {
          if (!frame.ok)
            throw new Error(
              typeof frame.error?.message === "string" ? frame.error.message : "Call refused",
            );
          if (frame.id === "1") {
            accepted = true;
            clearTimeout(timer);
            ready.resolve();
          }
        } else if (frame.type === "state") {
          state = frontendStateSchema.parse(frame.state);
          changed();
        } else throw new Error("Invalid AgentVoice server frame");
      } catch (cause) {
        fail(cause instanceof Error ? cause : new Error(String(cause)));
        return;
      }
    }
  });
  socket.on("error", fail);
  socket.on("close", () => {
    closed = true;
    clearTimeout(timer);
    if (!accepted)
      ready.reject(error ?? new Error("AgentVoice server disconnected before accepting the call"));
    state = { ...state, available: false, phase: "stopped" };
    changed();
    ended.resolve();
  });
  await ready.promise;
  return {
    state: () => state,
    command: (command: FrontendCommand) => send("input", command),
    close: () => {
      socket.destroy();
      return ended.promise;
    },
    done: ended.promise,
    error: () => error,
  };
}

export async function runFrontend(workspace?: string) {
  let tui: VoiceView | undefined;
  const client = await connectFrontend(
    frontendSocketPath(stateDirectory(process.env, homedir()), workspace),
    () => tui?.refresh(),
    process.env["AGENTVOICE_CLIENT_ID"],
  );
  const host: VoiceHost = {
    state: client.state,
    setMuted: (target, muted) => client.command({ action: "mute", target, muted }),
    beginUnmute: () => client.command({ action: "hold" }),
    releaseUnmute: () => client.command({ action: "release" }),
    shutdown: client.close,
  };
  try {
    tui = await createVoiceTui(host);
    void client.done.then(() => tui?.shutdown());
    await tui.done;
    if (client.error()) throw client.error();
  } finally {
    await client.close();
    await tui?.shutdown();
  }
}
