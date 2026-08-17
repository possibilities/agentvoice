import { createConnection, type Socket } from "node:net";
import type { AudioTarget } from "./audio-control.ts";
import {
  encodeRemoteMessage,
  parseRemoteReject,
  parseRemoteState,
  REMOTE_PROTOCOL_VERSION,
  type RemoteCommand,
  type RemoteState,
} from "./remote-protocol.ts";
import {
  createVoiceTui,
  type VoiceTui,
  type VoiceTuiHost,
  type VoiceTuiInput,
  type VoiceTuiOptions,
  type VoiceTuiState,
} from "./tui.ts";

const RECONNECT_MS = 750;
/** Comfortably inside the Console's hold-releasing heartbeat deadline. */
const PING_INTERVAL_MS = 1_500;

export class RemoteError extends Error {}

export type RemoteUiOptions = VoiceTuiOptions;

/** A unix socket path on the Console's own machine, or a network Console. */
export type RemoteTarget = string | RemoteNetworkTarget;

export interface RemoteNetworkTarget {
  host: string;
  port: number;
  token: string;
}

/** One attachment attempt; the caller owns retrying it. */
interface RemoteLink {
  send(frame: string): void;
  close(): void;
}

export async function runRemote(
  target: RemoteTarget,
  options: RemoteUiOptions = {},
): Promise<void> {
  let latest: RemoteState | null = null;
  let link: RemoteLink | null = null;
  let connected = false;
  let closed = false;
  let fatal: string | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let tui: VoiceTui;

  const state = (): VoiceTuiState => ({
    available: connected && latest !== null,
    phase: latest?.phase ?? "waiting-ready",
    liveForMs: latest?.liveForMs ?? null,
    mic: {
      muted: latest?.mic.muted ?? false,
      effectiveMuted: latest?.mic.effectiveMuted ?? false,
      db: latest?.mic.db ?? -Infinity,
    },
    speaker: {
      muted: latest?.speaker.muted ?? false,
      effectiveMuted: latest?.speaker.effectiveMuted ?? false,
      db: latest?.speaker.db ?? -Infinity,
    },
  });

  const send = (command: RemoteCommand): void => {
    if (!connected || !link || !latest) return;
    link.send(encodeRemoteMessage(command));
  };

  const teardown = (): void => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (pingTimer) clearInterval(pingTimer);
    reconnectTimer = null;
    pingTimer = null;
    link?.close();
    link = null;
    connected = false;
    latest = null;
  };

  const host: VoiceTuiHost = {
    state,
    setMuted: (target: AudioTarget, muted: boolean) => {
      send({ type: "set-muted", target, muted });
    },
    beginUnmute: (target: AudioTarget, input: VoiceTuiInput) => {
      send({ type: "hold-unmuted", target, input });
    },
    releaseUnmute: (target: AudioTarget, input: VoiceTuiInput, commit: boolean) => {
      send({ type: "release-unmuted", target, input, commit });
    },
    redial: () => send({ type: "redial" }),
    fresh: () => send({ type: "fresh" }),
    shutdown: () => {
      if (closed) return;
      closed = true;
      teardown();
    },
  };

  tui = await createVoiceTui(host, options);

  /** Applies one decoded frame; a refusal ends the session rather than retrying. */
  const receive = (line: string): void => {
    const parsed = parseRemoteState(line);
    if (parsed) {
      latest = parsed;
      return;
    }
    const reject = parseRemoteReject(line);
    if (!reject || closed) return;
    fatal = `the Console refused this Remote console: ${reject.reason}`;
    closed = true;
    teardown();
    void tui.shutdown();
  };

  const onBatch = (): void => {
    tui.refresh();
  };

  const onOpen = (): void => {
    connected = true;
    if (typeof target !== "string") {
      link?.send(
        encodeRemoteMessage({
          type: "hello",
          protocol: REMOTE_PROTOCOL_VERSION,
          token: target.token,
        }),
      );
      pingTimer = setInterval(
        () => link?.send(encodeRemoteMessage({ type: "ping" })),
        PING_INTERVAL_MS,
      );
      pingTimer.unref?.();
    }
    tui.refresh();
  };

  const onClose = (): void => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    link = null;
    connected = false;
    latest = null;
    tui.cancelInputs();
    tui.refresh();
    if (!closed) reconnectTimer = setTimeout(connect, RECONNECT_MS);
  };

  function connect(): void {
    if (closed) return;
    link =
      typeof target === "string"
        ? connectSocket(target, { onOpen, onFrame: receive, onBatch, onClose })
        : connectWebSocket(target, { onOpen, onFrame: receive, onBatch, onClose });
  }

  connect();
  await tui.done;
  if (fatal) throw new RemoteError(fatal);
}

interface LinkHandlers {
  onOpen(): void;
  onFrame(line: string): void;
  /** One redraw per arrival, not per frame in it. */
  onBatch(): void;
  onClose(): void;
}

function connectSocket(socketPath: string, handlers: LinkHandlers): RemoteLink {
  const socket: Socket = createConnection(socketPath);
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("connect", handlers.onOpen);
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline === -1) break;
      handlers.onFrame(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
    }
    handlers.onBatch();
  });
  socket.on("error", () => {});
  socket.on("close", handlers.onClose);
  return {
    send: (frame) => {
      if (!socket.destroyed) socket.write(frame);
    },
    close: () => socket.destroy(),
  };
}

/**
 * Cross-machine attachment. The Console binds a tailnet address, so WireGuard
 * — not an app-level TLS session — is what carries the encryption and machine
 * identity here; the token is the Console's own admission check on top.
 */
function connectWebSocket(target: RemoteNetworkTarget, handlers: LinkHandlers): RemoteLink {
  const socket = new WebSocket(`ws://${formatHost(target.host)}:${target.port}`);
  let settled = false;
  socket.addEventListener("open", handlers.onOpen);
  socket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    handlers.onFrame(event.data);
    handlers.onBatch();
  });
  socket.addEventListener("error", () => {
    if (settled) return;
    settled = true;
    handlers.onClose();
  });
  socket.addEventListener("close", () => {
    if (settled) return;
    settled = true;
    handlers.onClose();
  });
  return {
    send: (frame) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(frame);
    },
    close: () => socket.close(),
  };
}

/** Bare IPv6 literals need brackets in a URL authority. */
function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
