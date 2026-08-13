/**
 * Voice transport: the server's WebSocket protocol plus the werift WebRTC
 * peer. Owns session lifecycle — offer/answer, renewal before the upstream
 * ceiling, reconnect with backoff, and manual redial — and hands audio to the
 * pipeline as opaque Opus frames.
 *
 * A redial is seamless-ish: the new peer negotiates while the old one keeps
 * playing, and audio swaps when the new peer connects. (The server-side
 * supersede kills the old session's control plane as soon as the new start is
 * processed, so the old audio is a best-effort tail, not a guarantee.)
 */
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, RtpBuilder } from "werift";
import {
  CLOSE_BUSY,
  CLOSE_UNAUTHORIZED,
  parseServerMessage,
  type ReadyMessage,
  type WorkerSnapshot,
} from "../protocol.ts";
import { SAMPLE_RATE } from "./dsp.ts";
import {
  formatWebRtcMediaTrace,
  packetAgeMs,
  shouldReportRtpStall,
  type WebRtcMediaSnapshot,
  webRtcMediaSnapshot,
} from "./media-trace.ts";

export type TransportPhase =
  | "connecting"
  | "waiting-ready"
  | "negotiating"
  | "live"
  | "reconnecting"
  | "failed"
  | "stopped";

export type ReadyInfo = Omit<ReadyMessage, "type" | "protocol">;

export interface TransportEvents {
  onPhase(phase: TransportPhase): void;
  onReady(info: ReadyInfo): void;
  onRemoteTrack(track: MediaStreamTrack): void;
  onOaiEvent(event: Record<string, unknown>): void;
  /** A dispatched worker changed state (also replayed on connect). */
  onWorker?(worker: WorkerSnapshot): void;
  /** One-line notices for the event feed. */
  onInfo(line: string): void;
  /** Errors worth surfacing prominently (fatal server errors, busy, …). */
  onError(line: string): void;
}

export interface VoiceTransportOptions extends TransportEvents {
  url: string;
  debug?(line: string): void;
}

/** Renew shortly before the ~60-minute upstream session ceiling. */
const RENEWAL_MS = 52 * 60_000;
const NEGOTIATION_TIMEOUT_MS = 30_000;
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_CAP_MS = 15_000;
const RETRY_OFFER_MS = 1_000;
/** Consecutive failed sessions before requiring a manual redial. */
const MAX_RAPID_FAILURES = 3;
/** A session live this long proves health and resets the failure budget. */
const HEALTHY_SESSION_MS = 60_000;
const MEDIA_TRACE_INTERVAL_MS = 1_000;

const OPUS = new RTCRtpCodecParameters({
  mimeType: "audio/opus",
  clockRate: SAMPLE_RATE,
  channels: 2,
});

interface PeerSession {
  generation: number;
  pc: RTCPeerConnection;
  sendTrack: MediaStreamTrack;
  builder: RtpBuilder;
  remoteTrack: MediaStreamTrack | null;
  connected: boolean;
  liveSince: number | null;
  timers: ReturnType<typeof setTimeout>[];
  mediaTraceTimer: ReturnType<typeof setInterval> | null;
  mediaTraceSampling: boolean;
  decryptedRtpStallReported: boolean;
  previousMediaSnapshot: WebRtcMediaSnapshot | null;
}

export class VoiceTransport {
  private readonly options: VoiceTransportOptions;
  private ws: WebSocket | null = null;
  /** The session whose audio is flowing (or last was). */
  private live: PeerSession | null = null;
  /** A successor still negotiating; promoted to live when it connects. */
  private pending: PeerSession | null = null;
  private generation = 0;
  private phase: TransportPhase = "connecting";
  private ready: ReadyInfo | null = null;
  private wantLive = true;
  private rapidFailures = 0;
  private reconnectDelayMs = RECONNECT_INITIAL_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;

  constructor(options: VoiceTransportOptions) {
    this.options = options;
  }

  get currentPhase(): TransportPhase {
    return this.phase;
  }

  get readyInfo(): ReadyInfo | null {
    return this.ready;
  }

  /** Milliseconds the current session has been live, or null. */
  get liveForMs(): number | null {
    const since = this.live?.liveSince;
    return since ? Date.now() - since : null;
  }

  /** Milliseconds until automatic renewal, or null when not live. */
  get renewInMs(): number | null {
    const live = this.liveForMs;
    return live === null ? null : Math.max(0, RENEWAL_MS - live);
  }

  start(): void {
    this.openSocket();
  }

  /**
   * Negotiate a replacement session; the current one keeps playing until the
   * replacement connects. Manual (`r`), or automatic for renewal and retry.
   */
  redial(reason: string): void {
    if (this.stopping) return;
    this.rapidFailures = 0;
    this.wantLive = true;
    this.options.onInfo(`redial (${reason})`);
    this.clearTimer("retryTimer");
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      this.negotiate();
      return;
    }
    if (!this.ws || this.ws.readyState > WebSocket.OPEN) {
      // The socket itself is gone — e.g. this client was rejected with 4429
      // while another client held the server. Reopen it; the next `ready`
      // re-offers because wantLive is set.
      this.clearTimer("reconnectTimer");
      this.reconnectDelayMs = RECONNECT_INITIAL_MS;
      this.openSocket();
    }
    // A socket still connecting needs nothing: `ready` will re-offer.
  }

  sendOpusFrame(frame: Buffer): void {
    const live = this.live;
    if (!live?.connected) return;
    try {
      live.sendTrack.writeRtp(live.builder.create(frame));
    } catch (error) {
      this.debug(`writeRtp failed: ${message(error)}`);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearTimer("reconnectTimer");
    this.clearTimer("retryTimer");
    this.dropPeers();
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000, "client quit");
    this.setPhase("stopped");
  }

  // -------------------------------------------------------------------------

  private setPhase(phase: TransportPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.options.onPhase(phase);
  }

  private debug(line: string): void {
    this.options.debug?.(line);
  }

  private clearTimer(name: "reconnectTimer" | "retryTimer"): void {
    const timer = this[name];
    if (timer) clearTimeout(timer);
    this[name] = null;
  }

  private openSocket(): void {
    if (this.stopping) return;
    this.setPhase(this.ws ? "reconnecting" : "connecting");
    const ws = new WebSocket(this.options.url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectDelayMs = RECONNECT_INITIAL_MS;
      this.setPhase("waiting-ready");
      this.debug("websocket open");
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      void this.handleServerMessage(String(event.data));
    };
    ws.onclose = (event) => {
      if (this.ws !== ws || this.stopping) return;
      this.ws = null;
      this.ready = null;
      this.dropPeers();
      if (event.code === CLOSE_BUSY) {
        this.options.onError("another client is connected to the server");
        this.setPhase("failed");
        return;
      }
      if (event.code === CLOSE_UNAUTHORIZED) {
        this.options.onError(
          "server rejected the connection token — copy ~/.local/state/agentvoice/token from the server machine or pass --token",
        );
        this.setPhase("failed");
        return;
      }
      this.options.onInfo(`server connection lost (${event.code}); reconnecting`);
      this.setPhase("reconnecting");
      this.reconnectTimer = setTimeout(() => this.openSocket(), this.reconnectDelayMs);
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_CAP_MS);
    };
    ws.onerror = () => {
      // onclose always follows; reconnect is handled there.
    };
  }

  private async handleServerMessage(text: string): Promise<void> {
    const msg = parseServerMessage(text);
    if (!msg) {
      this.debug(`unrecognized server message: ${text.slice(0, 120)}`);
      return;
    }
    switch (msg.type) {
      case "ready": {
        const { type: _type, protocol: _protocol, ...info } = msg;
        this.ready = info;
        this.options.onReady(info);
        this.debug(`ready: thread ${info.threadId}`);
        if (this.wantLive && !this.live && !this.pending) {
          if (this.rapidFailures >= MAX_RAPID_FAILURES) {
            this.options.onError("voice failed repeatedly — press r to redial when ready");
            this.setPhase("failed");
          } else {
            this.negotiate();
          }
        }
        return;
      }
      case "answer": {
        const pending = this.pending;
        if (!pending) {
          this.debug("dropping answer with no pending session");
          return;
        }
        try {
          await pending.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
          this.debug("answer applied");
        } catch (error) {
          this.failPending(pending, `answer rejected: ${message(error)}`);
        }
        return;
      }
      case "closed": {
        this.options.onInfo(`voice session closed: ${msg.reason ?? "server closed the session"}`);
        const live = this.live;
        this.live = null;
        if (live) this.closePeer(live);
        if (!this.pending) {
          this.setPhase(this.ws?.readyState === WebSocket.OPEN ? "waiting-ready" : this.phase);
        }
        // The server re-sends `ready` when offers reopen; wantLive re-offers.
        return;
      }
      case "redial": {
        this.redial(msg.reason);
        return;
      }
      case "error": {
        if (!msg.fatal) {
          this.options.onInfo(`server: ${msg.message}`);
          return;
        }
        const pending = this.pending;
        const live = this.live;
        if (pending) this.failPending(pending, msg.message);
        else if (live) this.failLive(live, msg.message);
        else this.options.onError(msg.message);
        return;
      }
      case "worker": {
        this.options.onWorker?.(msg.worker);
        return;
      }
    }
  }

  private negotiate(): void {
    if (this.stopping) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const stale = this.pending;
    this.pending = null;
    if (stale) this.closePeer(stale);

    const generation = ++this.generation;
    const pc = new RTCPeerConnection({ codecs: { audio: [OPUS] } });
    const sendTrack = new MediaStreamTrack({ kind: "audio" });
    const session: PeerSession = {
      generation,
      pc,
      sendTrack,
      builder: new RtpBuilder({ between: 20, clockRate: SAMPLE_RATE }),
      remoteTrack: null,
      connected: false,
      liveSince: null,
      timers: [],
      mediaTraceTimer: null,
      mediaTraceSampling: false,
      decryptedRtpStallReported: false,
      previousMediaSnapshot: null,
    };
    this.pending = session;
    if (!this.live) this.setPhase("negotiating");

    pc.addTransceiver(sendTrack, { direction: "sendrecv" });
    const dc = pc.createDataChannel("oai-events");
    dc.onmessage = (event) => {
      if (this.pending !== session && this.live !== session) return;
      const data = (event as { data?: unknown }).data ?? event;
      const text = typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array);
      try {
        this.options.onOaiEvent(JSON.parse(text) as Record<string, unknown>);
      } catch {
        this.debug(`non-JSON oai-event: ${text.slice(0, 80)}`);
      }
    };

    pc.onTrack.subscribe((track) => {
      if (track.kind !== "audio") return;
      session.remoteTrack = track;
      // Held until this session is promoted; the old session's audio keeps
      // playing through negotiation.
      if (this.live === session) this.options.onRemoteTrack(track);
    });

    pc.connectionStateChange.subscribe((state) => {
      if (this.stopping) return;
      this.debug(`peer ${generation} connection ${state}`);
      if (state === "connected") {
        if (this.pending === session) this.promote(session);
      } else if (state === "failed" || state === "closed") {
        if (this.pending === session) this.failPending(session, `media path ${state}`);
        else if (this.live === session) this.failLive(session, `media path ${state}`);
      }
    });

    session.timers.push(
      setTimeout(() => {
        if (this.pending === session && !session.connected) {
          this.failPending(session, "voice negotiation timed out");
        }
      }, NEGOTIATION_TIMEOUT_MS),
    );

    void (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const sdp = pc.localDescription?.sdp;
        if (!sdp) throw new Error("no local description after gathering");
        if (this.pending !== session) return;
        ws.send(JSON.stringify({ type: "offer", sdp }));
        this.debug(`offer sent (generation ${generation})`);
      } catch (error) {
        this.failPending(session, `offer failed: ${message(error)}`);
      }
    })();
  }

  /** The successor connected: swap audio to it and retire the predecessor. */
  private promote(session: PeerSession): void {
    this.pending = null;
    const previous = this.live;
    this.live = session;
    session.connected = true;
    session.liveSince = Date.now();
    if (previous) this.closePeer(previous);
    if (session.remoteTrack) this.options.onRemoteTrack(session.remoteTrack);
    this.setPhase("live");
    this.options.onInfo(previous ? "voice session renewed" : "voice connected");
    this.startMediaTrace(session);
    session.timers.push(
      setTimeout(() => {
        if (this.live === session) this.redial("renewal");
      }, RENEWAL_MS),
    );
    session.timers.push(
      setTimeout(() => {
        if (this.live === session) this.rapidFailures = 0;
      }, HEALTHY_SESSION_MS),
    );
  }

  private failPending(session: PeerSession, reason: string): void {
    if (this.pending !== session) return;
    this.pending = null;
    this.closePeer(session);
    this.options.onError(`voice: ${reason}`);
    this.rapidFailures++;
    this.afterFailure();
  }

  private failLive(session: PeerSession, reason: string): void {
    if (this.live !== session) return;
    const wasHealthy =
      session.liveSince !== null && Date.now() - session.liveSince > HEALTHY_SESSION_MS;
    this.live = null;
    this.closePeer(session);
    this.options.onError(`voice: ${reason}`);
    if (this.pending) return; // a successor is already negotiating
    this.rapidFailures = wasHealthy ? 1 : this.rapidFailures + 1;
    this.afterFailure();
  }

  /** Shared failure tail: give up at the budget, otherwise re-offer shortly. */
  private afterFailure(): void {
    if (this.rapidFailures >= MAX_RAPID_FAILURES) {
      this.options.onError("voice failed repeatedly — press r to redial");
      // Repeated supersede attempts have killed the old session's control
      // plane server-side; don't pretend it is still live.
      this.dropPeers();
      this.setPhase("failed");
      return;
    }
    if (!this.live) {
      this.setPhase(this.ws?.readyState === WebSocket.OPEN ? "waiting-ready" : this.phase);
    }
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      this.clearTimer("retryTimer");
      this.retryTimer = setTimeout(() => {
        if (!this.stopping && this.wantLive && !this.pending) this.negotiate();
      }, RETRY_OFFER_MS);
    }
  }

  /** Detach both peers before closing them: pc.close() fires state changes
   *  synchronously, and a still-attached session would re-enter the failure
   *  paths. */
  private dropPeers(): void {
    const pending = this.pending;
    const live = this.live;
    this.pending = null;
    this.live = null;
    if (pending) this.closePeer(pending);
    if (live) this.closePeer(live);
  }

  private closePeer(session: PeerSession): void {
    for (const timer of session.timers) clearTimeout(timer);
    session.timers = [];
    if (session.mediaTraceTimer) clearInterval(session.mediaTraceTimer);
    session.mediaTraceTimer = null;
    try {
      void session.pc.close();
    } catch {
      // peer may already be closed
    }
  }

  private startMediaTrace(session: PeerSession): void {
    if (!this.options.debug) return;
    const sample = () => void this.sampleMediaTrace(session);
    sample();
    session.mediaTraceTimer = setInterval(sample, MEDIA_TRACE_INTERVAL_MS);
    session.mediaTraceTimer.unref?.();
  }

  private async sampleMediaTrace(session: PeerSession): Promise<void> {
    if (this.live !== session || session.mediaTraceSampling) return;
    session.mediaTraceSampling = true;
    try {
      const report = await session.pc.getStats();
      if (this.live !== session) return;
      const sampledAt = Date.now();
      const snapshot = webRtcMediaSnapshot(
        report.values(),
        sampledAt,
        session.pc.connectionState,
        session.pc.iceConnectionState,
      );
      const previous = session.previousMediaSnapshot;
      const line = formatWebRtcMediaTrace(
        snapshot,
        previous,
        session.generation,
        sampledAt - (session.liveSince ?? sampledAt),
      );
      this.debug(line);
      if ((snapshot.inboundRtp?.packets ?? 0) > (previous?.inboundRtp?.packets ?? 0)) {
        session.decryptedRtpStallReported = false;
      }
      const decryptedPacketAge = packetAgeMs(sampledAt, snapshot.inboundRtp?.lastPacketAt ?? null);
      if (
        shouldReportRtpStall(
          (snapshot.inboundRtp?.packets ?? 0) > 0,
          decryptedPacketAge,
          session.decryptedRtpStallReported,
        )
      ) {
        session.decryptedRtpStallReported = true;
        this.debug(line.replace("voice media ", "voice media stalled "));
      }
      session.previousMediaSnapshot = snapshot;
    } catch (error) {
      if (this.live === session) {
        this.debug(`voice media generation=${session.generation} stats_error=${message(error)}`);
      }
    } finally {
      session.mediaTraceSampling = false;
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
