import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import type { MediaOptions } from "../console/host.ts";
import type { VoiceHost, VoiceView } from "../console/state.ts";
import { createVoiceTui } from "../console/tui.ts";
import type { ClientMediaMessage, ServerMediaMessage } from "../frontend/media-protocol.ts";
import { NetworkClientSocket } from "../network/client.ts";
import type { ConnectionProfile } from "../network/credentials.ts";
import { stateDirectory } from "../paths.ts";
import { observeFrontend } from "./observer.ts";
import {
  FRONTEND_VERSION,
  type FrontendCommand,
  type FrontendState,
  frontendMediaOutputSchema,
  frontendServerFrameSchema,
  frontendSocketPath,
  frontendStateSchema,
} from "./protocol.ts";

export async function connectFrontend(
  path: string | ConnectionProfile,
  changed: () => void = () => {},
  clientId?: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    waiting?: () => void;
    onMedia?: (message: ServerMediaMessage) => void;
  } = {},
) {
  if (typeof path === "string") {
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
    const observation = await observeFrontend(path, () => {});
    try {
      await observation.waitUntilAvailable(options);
    } finally {
      observation.socket.close();
    }
  }
  options.signal?.throwIfAborted();
  const ready = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  let accepted = false;
  let closed = false;
  let error: Error | undefined;
  let next = 0;
  const pendingResponses = new Map<string, ReturnType<typeof setTimeout>>();
  let partial = "";
  let state: FrontendState = {
    codingActivity: "unknown",
    available: false,
    phase: "waiting-ready",
    mic: { muted: false, effectiveMuted: true },
    speaker: { muted: false, effectiveMuted: true },
  };
  const socket: {
    destroyed: boolean;
    writableLength: number;
    destroy(): void;
    write(data: string): unknown;
    setEncoding(encoding: BufferEncoding): unknown;
    on(event: "connect" | "close", listener: () => void): unknown;
    on(event: "data", listener: (chunk: string) => void): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
  } = typeof path === "string" ? createConnection({ path }) : new NetworkClientSocket(path);
  const fail = (cause: Error) => {
    error ??= cause;
    socket.destroy();
  };
  const cancel = () => fail(new Error("Frontend connection cancelled"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(
    () => fail(new Error("AgentVoice server did not accept the call")),
    5000,
  );
  function send(
    method: string,
    params?: FrontendCommand | ClientMediaMessage | { clientId: string },
  ) {
    if (closed || socket.destroyed) return;
    if (pendingResponses.size >= 128) {
      fail(new Error("Too many unacknowledged client requests"));
      return;
    }
    if (socket.writableLength > 64 * 1024) {
      fail(new Error("AgentVoice server is not reading input"));
      return;
    }
    const id = String(++next);
    pendingResponses.set(
      id,
      setTimeout(() => fail(new Error("AgentVoice server did not acknowledge client input")), 5000),
    );
    socket.write(
      `${JSON.stringify({ v: FRONTEND_VERSION, type: "request", id, method, ...(params ? { params } : {}) })}\n`,
    );
  }
  socket.setEncoding("utf8");
  socket.on("connect", () => send("call", { clientId: clientId ?? randomUUID() }));
  socket.on("data", (chunk) => {
    partial += chunk;
    if (Buffer.byteLength(partial) > 1024 * 1024) {
      fail(new Error("Invalid AgentVoice server frame"));
      return;
    }
    for (;;) {
      const newline = partial.indexOf("\n");
      if (newline < 0) return;
      const line = partial.slice(0, newline);
      partial = partial.slice(newline + 1);
      try {
        const frame = frontendServerFrameSchema.parse(JSON.parse(line));
        if (frame.v !== FRONTEND_VERSION) throw new Error("Incompatible AgentVoice server");
        if (frame.type === "response") {
          if (
            typeof frame.id !== "string" ||
            !pendingResponses.has(frame.id) ||
            typeof frame.ok !== "boolean"
          )
            throw new Error("Uncorrelated AgentVoice server response");
          clearTimeout(pendingResponses.get(frame.id));
          pendingResponses.delete(frame.id);
          if (!frame.ok) throw new Error(frame.error.message);
          if (frame.id === "1") {
            accepted = true;
            clearTimeout(timer);
            ready.resolve();
          }
        } else if (frame.type === "state") {
          state = frontendStateSchema.parse(frame.state);
          changed();
        } else if (frame.type === "client-media") {
          options.onMedia?.(frontendMediaOutputSchema.parse(frame.message));
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
    options.signal?.removeEventListener("abort", cancel);
    clearTimeout(timer);
    for (const pending of pendingResponses.values()) clearTimeout(pending);
    pendingResponses.clear();
    if (!accepted)
      ready.reject(error ?? new Error("AgentVoice server disconnected before accepting the call"));
    state = { ...state, available: false, phase: "stopped", codingActivity: "unknown" };
    changed();
    ended.resolve();
  });
  await ready.promise;
  return {
    state: () => state,
    command: (command: FrontendCommand) => send("input", command),
    clientMedia: (message: ClientMediaMessage) => send("client-media", message),
    close: () => {
      socket.destroy();
      return ended.promise;
    },
    done: ended.promise,
    error: () => error,
  };
}

export async function runFrontend(
  workspace?: string,
  options: MediaOptions = {},
  connection?: ConnectionProfile,
) {
  let tui: VoiceView | undefined;
  const abort = new AbortController();
  const stop = () => abort.abort();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.once(signal, stop);
  let client: Awaited<ReturnType<typeof connectFrontend>> | undefined;
  const { nativeClientMedia } = await import("./native-media.ts");
  const pending: ClientMediaMessage[] = [];
  const media = await nativeClientMedia((message) => {
    if (client) client.clientMedia(message);
    else pending.push(message);
  }, options);
  try {
    client = await connectFrontend(
      connection ?? frontendSocketPath(stateDirectory(process.env, homedir()), workspace),
      () => {
        if (client) media.state(client.state());
        tui?.refresh();
      },
      process.env["AGENTVOICE_CLIENT_ID"],
      {
        signal: abort.signal,
        waiting: () => console.error("Closing previous call…"),
        onMedia: (message) => {
          void media.receive(message);
        },
      },
    );
    for (const message of pending.splice(0)) client.clientMedia(message);
    media.state(client.state());
  } catch (error) {
    await media.stop();
    throw error;
  } finally {
    for (const signal of signals) process.off(signal, stop);
  }
  const host: VoiceHost = {
    state: client.state,
    setMuted: (target, muted) => client!.command({ action: "mute", target, muted }),
    beginUnmute: () => client!.command({ action: "hold" }),
    releaseUnmute: () => client!.command({ action: "release" }),
    shutdown: client.close,
  };
  try {
    tui = await createVoiceTui(host);
    void client.done.then(async () => {
      await media.stop();
      await tui?.shutdown();
    });
    await tui.done;
    if (client.error()) throw client.error();
  } finally {
    await media.stop();
    await client.close();
    await tui?.shutdown();
  }
}
