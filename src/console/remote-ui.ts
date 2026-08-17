import { createConnection, type Socket } from "node:net";
import type { AudioTarget } from "./audio-control.ts";
import {
  encodeRemoteMessage,
  parseRemoteState,
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

export class RemoteError extends Error {}

export type RemoteUiOptions = VoiceTuiOptions;

export async function runRemote(socketPath: string, options: RemoteUiOptions = {}): Promise<void> {
  let latest: RemoteState | null = null;
  let socket: Socket | null = null;
  let connected = false;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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
    if (!connected || !socket || !latest) return;
    socket.write(encodeRemoteMessage(command));
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
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      socket?.destroy();
      socket = null;
      connected = false;
      latest = null;
    },
  };

  tui = await createVoiceTui(host, options);

  const connect = (): void => {
    if (closed) return;
    const next = createConnection(socketPath);
    socket = next;
    let buffered = "";
    next.setEncoding("utf8");
    next.on("connect", () => {
      connected = true;
      tui.refresh();
    });
    next.on("data", (chunk: string) => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline === -1) break;
        const parsed = parseRemoteState(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (parsed) latest = parsed;
      }
      tui.refresh();
    });
    next.on("error", () => {});
    next.on("close", () => {
      if (socket === next) socket = null;
      connected = false;
      latest = null;
      tui.cancelInputs();
      tui.refresh();
      if (!closed) reconnectTimer = setTimeout(connect, RECONNECT_MS);
    });
  };

  connect();
  await tui.done;
}
