import type { AppServer } from "./appserver.ts";
import { UnixWebSocket } from "./unix-websocket.ts";

export const APP_SERVER_GATEWAY_PATH = "/app-server";
export const APP_SERVER_GATEWAY_PROTOCOL = 2;
const MAX_QUEUED_BYTES = 16 << 20;

export type AppServerFrameDirection = "toAppServer" | "fromAppServer";
export type AppServerFrameOwner = "agentvoice" | "appServer";

export interface GatewayPeer {
  readonly readyState: number;
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
}

export interface GatewayUpstream {
  connect(): Promise<void>;
  sendText(text: string): void;
  close(code?: number, reason?: string): void;
}

export interface GatewayUpstreamCallbacks {
  onText(text: string): void;
  onClose(): void;
  onError(error: Error): void;
}

export interface AppServerGatewayOptions {
  connect?(socketPath: string, callbacks: GatewayUpstreamCallbacks): GatewayUpstream;
  debug?(line: string): void;
}

interface PeerState {
  upstream: GatewayUpstream;
  observeAgentVoice: boolean;
  connecting: boolean;
  queued: string[];
  queuedBytes: number;
  removed: boolean;
}

function unixUpstream(socketPath: string, callbacks: GatewayUpstreamCallbacks): GatewayUpstream {
  return new UnixWebSocket({
    socketPath,
    onText: callbacks.onText,
    onClose: callbacks.onClose,
    onError: callbacks.onError,
  });
}

/**
 * Authenticated WebSocket facade over native App-server connections. Every
 * peer owns one physical upstream connection; messages and request ids cross
 * byte-for-byte, and closing the peer releases its App-server subscriptions.
 */
export class AppServerGateway {
  private readonly options: AppServerGatewayOptions;
  private readonly peers = new Map<GatewayPeer, PeerState>();
  private socketPath: string | null = null;

  constructor(options: AppServerGatewayOptions = {}) {
    this.options = options;
  }

  setAppServer(appServer: Pick<AppServer, "alive" | "socketPath"> | null): void {
    const next = appServer?.alive === true ? appServer.socketPath : null;
    if (this.socketPath === next) return;
    this.socketPath = next;
    for (const peer of [...this.peers.keys()]) {
      this.disconnect(peer, 1012, "AgentVoice app-server changed");
    }
  }

  add(peer: GatewayPeer, options: { observeAgentVoice?: boolean } = {}): void {
    const socketPath = this.socketPath;
    if (!socketPath) {
      peer.close(1013, "AgentVoice app-server is not running");
      return;
    }
    const connect = this.options.connect ?? unixUpstream;
    const upstream = connect(socketPath, {
      onText: (text) => this.sendText(peer, text),
      onClose: () => this.disconnect(peer, 1012, "App-server connection closed"),
      onError: (error) => this.options.debug?.(`[app-server gateway] ${error.message}`),
    });
    const state: PeerState = {
      upstream,
      observeAgentVoice: options.observeAgentVoice === true,
      connecting: true,
      queued: [],
      queuedBytes: 0,
      removed: false,
    };
    this.peers.set(peer, state);
    void upstream
      .connect()
      .then(() => {
        if (state.removed || this.peers.get(peer) !== state) {
          upstream.close(1000, "peer gone");
          return;
        }
        state.connecting = false;
        for (const text of state.queued) upstream.sendText(text);
        state.queued = [];
        state.queuedBytes = 0;
      })
      .catch((error) => {
        this.options.debug?.(
          `[app-server gateway] upstream connect failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        this.disconnect(peer, 1013, "Unable to connect to AgentVoice app-server");
      });
  }

  remove(peer: GatewayPeer): void {
    const state = this.peers.get(peer);
    if (!state) return;
    state.removed = true;
    this.peers.delete(peer);
    state.upstream.close(1000, "gateway peer disconnected");
  }

  handle(peer: GatewayPeer, text: string): void {
    const state = this.peers.get(peer);
    if (!state || state.removed) return;
    if (!state.connecting) {
      try {
        state.upstream.sendText(text);
      } catch (error) {
        this.options.debug?.(
          `[app-server gateway] upstream send failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        this.disconnect(peer, 1011, "Unable to write to AgentVoice app-server");
      }
      return;
    }
    const bytes = Buffer.byteLength(text);
    if (state.queuedBytes + bytes > MAX_QUEUED_BYTES) {
      this.disconnect(peer, 1009, "App-server connection queue exceeded 16 MiB");
      return;
    }
    state.queued.push(text);
    state.queuedBytes += bytes;
  }

  /** AgentVoice's owning-connection frames are the one additive observation API. */
  frame(
    direction: AppServerFrameDirection,
    owner: AppServerFrameOwner,
    payload: Record<string, unknown>,
  ): void {
    const envelope = JSON.stringify({
      jsonrpc: "2.0",
      method: "agentvoice/frame",
      params: { direction, owner, payload },
    });
    for (const [peer, state] of this.peers) {
      if (state.observeAgentVoice) this.sendText(peer, envelope);
    }
  }

  private disconnect(peer: GatewayPeer, code: number, reason: string): void {
    const state = this.peers.get(peer);
    if (!state) return;
    state.removed = true;
    this.peers.delete(peer);
    state.upstream.close(code, reason);
    try {
      peer.close(code, reason);
    } catch {
      // peer is already gone
    }
  }

  private sendText(peer: GatewayPeer, text: string): void {
    if (peer.readyState !== 1) return;
    try {
      peer.send(text);
    } catch {
      this.remove(peer);
    }
  }
}
