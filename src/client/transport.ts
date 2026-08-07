/**
 * Voice transport: the server's WebSocket protocol plus the werift WebRTC
 * peer. Owns session lifecycle — offer/answer, renewal before the upstream
 * ceiling, reconnect with backoff, and manual redial — and hands audio to the
 * pipeline as opaque Opus frames.
 */
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpBuilder,
} from "werift";
import { SAMPLE_RATE } from "./dsp.ts";

export type TransportPhase =
  | "connecting"
  | "waiting-ready"
  | "negotiating"
  | "live"
  | "reconnecting"
  | "failed"
  | "stopped";

export interface ReadyInfo {
  threadId: string;
  workspace: string;
  model: string | null;
  effort: string | null;
  voiceModel: string | null;
  voice: string | null;
}

export interface TransportEvents {
  onPhase(phase: TransportPhase): void;
  onReady(info: ReadyInfo): void;
  onRemoteTrack(track: MediaStreamTrack): void;
  onOaiEvent(event: Record<string, unknown>): void;
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
/** Consecutive failed sessions before requiring a manual redial. */
const MAX_RAPID_FAILURES = 3;
/** A session live this long proves health and resets the failure budget. */
const HEALTHY_SESSION_MS = 60_000;

const OPUS = new RTCRtpCodecParameters({
  mimeType: "audio/opus",
  clockRate: SAMPLE_RATE,
  channels: 2,
});

interface Session {
  generation: number;
  pc: RTCPeerConnection;
  sendTrack: MediaStreamTrack;
  builder: RtpBuilder;
  connected: boolean;
  liveSince: number | null;
  timers: ReturnType<typeof setTimeout>[];
}

export class VoiceTransport {
  private readonly options: VoiceTransportOptions;
  private ws: WebSocket | null = null;
  private session: Session | null = null;
  private generation = 0;
  private phase: TransportPhase = "connecting";
  private ready: ReadyInfo | null = null;
  private wantLive = true;
  private rapidFailures = 0;
  private reconnectDelayMs = RECONNECT_INITIAL_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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
    const since = this.session?.liveSince;
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

  /** Manual or programmatic re-offer: fresh session, same conversation. */
  redial(reason: string): void {
    if (this.stopping) return;
    this.rapidFailures = 0;
    this.wantLive = true;
    this.options.onInfo(`redial (${reason})`);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.teardownSession();
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      void this.startSession();
      return;
    }
    if (!this.ws || this.ws.readyState > WebSocket.OPEN) {
      // The socket itself is gone — e.g. this client was rejected with 4429
      // while another client held the server. Reopen it; the next `ready`
      // re-offers because wantLive is set.
      this.reconnectDelayMs = RECONNECT_INITIAL_MS;
      this.openSocket();
    }
    // A socket still connecting needs nothing: `ready` will re-offer.
  }

  sendOpusFrame(frame: Buffer): void {
    const session = this.session;
    if (!session || !session.connected) return;
    try {
      session.sendTrack.writeRtp(session.builder.create(frame));
    } catch (error) {
      this.debug(`writeRtp failed: ${message(error)}`);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.teardownSession();
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
      this.teardownSession();
      if (event.code === 4429) {
        this.options.onError("another client is connected to the server");
        this.setPhase("failed");
        return;
      }
      this.options.onInfo(
        `server connection lost (${event.code}); reconnecting`,
      );
      this.setPhase("reconnecting");
      this.reconnectTimer = setTimeout(() => this.openSocket(), this.reconnectDelayMs);
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_CAP_MS);
    };
    ws.onerror = () => {
      // onclose always follows; reconnect is handled there.
    };
  }

  private async handleServerMessage(text: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.debug(`unparseable server message: ${text.slice(0, 120)}`);
      return;
    }
    const msg = parsed as Record<string, unknown>;
    switch (msg["type"]) {
      case "ready": {
        this.ready = {
          threadId: String(msg["threadId"] ?? ""),
          workspace: String(msg["workspace"] ?? ""),
          model: (msg["model"] as string | null) ?? null,
          effort: (msg["effort"] as string | null) ?? null,
          voiceModel: (msg["voiceModel"] as string | null) ?? null,
          voice: (msg["voice"] as string | null) ?? null,
        };
        this.options.onReady(this.ready);
        this.debug(`ready: thread ${this.ready.threadId}`);
        if (this.wantLive && !this.session) {
          if (this.rapidFailures >= MAX_RAPID_FAILURES) {
            this.options.onError(
              "voice failed repeatedly — press r to redial when ready",
            );
            this.setPhase("failed");
          } else {
            void this.startSession();
          }
        }
        return;
      }
      case "answer": {
        const session = this.session;
        const sdp = msg["sdp"];
        if (!session || typeof sdp !== "string") return;
        try {
          await session.pc.setRemoteDescription({ type: "answer", sdp });
          this.debug("answer applied");
        } catch (error) {
          this.failSession(session, `answer rejected: ${message(error)}`);
        }
        return;
      }
      case "closed": {
        const reason = typeof msg["reason"] === "string" ? msg["reason"] : "server closed the session";
        this.options.onInfo(`voice session closed: ${reason}`);
        this.teardownSession();
        // The server re-sends `ready` when offers reopen; wantLive re-offers.
        return;
      }
      case "error": {
        const text = typeof msg["message"] === "string" ? msg["message"] : "unknown server error";
        if (msg["fatal"] === true) {
          const session = this.session;
          if (session) this.failSession(session, text);
          else this.options.onError(text);
        } else {
          this.options.onInfo(`server: ${text}`);
        }
        return;
      }
      default:
        this.debug(`unknown server message type: ${String(msg["type"])}`);
    }
  }

  private async startSession(): Promise<void> {
    if (this.stopping || this.session) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const generation = ++this.generation;
    const pc = new RTCPeerConnection({ codecs: { audio: [OPUS] } });
    const sendTrack = new MediaStreamTrack({ kind: "audio" });
    const session: Session = {
      generation,
      pc,
      sendTrack,
      builder: new RtpBuilder({ between: 20, clockRate: SAMPLE_RATE }),
      connected: false,
      liveSince: null,
      timers: [],
    };
    this.session = session;
    this.setPhase("negotiating");

    pc.addTransceiver(sendTrack, { direction: "sendrecv" });
    const dc = pc.createDataChannel("oai-events");
    dc.onmessage = (event) => {
      if (this.session?.generation !== generation) return;
      const data = (event as { data?: unknown }).data ?? event;
      const text =
        typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array);
      try {
        this.options.onOaiEvent(JSON.parse(text) as Record<string, unknown>);
      } catch {
        this.debug(`non-JSON oai-event: ${text.slice(0, 80)}`);
      }
    };

    pc.onTrack.subscribe((track) => {
      if (this.session?.generation !== generation) return;
      if (track.kind !== "audio") return;
      this.options.onRemoteTrack(track);
    });

    pc.connectionStateChange.subscribe((state) => {
      if (this.session?.generation !== generation) return;
      this.debug(`peer connection ${state}`);
      if (state === "connected") {
        session.connected = true;
        session.liveSince = Date.now();
        this.setPhase("live");
        this.options.onInfo("voice connected");
        const renewTimer = setTimeout(() => {
          if (this.session?.generation !== generation) return;
          this.redial("renewal");
        }, RENEWAL_MS);
        session.timers.push(renewTimer);
        const healthTimer = setTimeout(() => {
          if (this.session?.generation !== generation) return;
          this.rapidFailures = 0;
        }, HEALTHY_SESSION_MS);
        session.timers.push(healthTimer);
      } else if (state === "failed" || state === "closed") {
        if (this.session?.generation === generation) {
          this.failSession(session, `media path ${state}`);
        }
      }
    });

    const negotiationTimer = setTimeout(() => {
      if (this.session?.generation !== generation || session.connected) return;
      this.failSession(session, "voice negotiation timed out");
    }, NEGOTIATION_TIMEOUT_MS);
    session.timers.push(negotiationTimer);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error("no local description after gathering");
      if (this.session?.generation !== generation) return;
      ws.send(JSON.stringify({ type: "offer", sdp }));
      this.debug("offer sent");
    } catch (error) {
      this.failSession(session, `offer failed: ${message(error)}`);
    }
  }

  /** Session-scoped failure: tear down, count it, and re-offer if budget allows. */
  private failSession(session: Session, reason: string): void {
    if (this.session?.generation !== session.generation) return;
    const wasHealthy =
      session.liveSince !== null && Date.now() - session.liveSince > HEALTHY_SESSION_MS;
    this.options.onError(`voice: ${reason}`);
    this.teardownSession();
    this.rapidFailures = wasHealthy ? 1 : this.rapidFailures + 1;
    if (this.rapidFailures >= MAX_RAPID_FAILURES) {
      this.options.onError("voice failed repeatedly — press r to redial");
      this.setPhase("failed");
      return;
    }
    // A fatal error or media failure leaves the server ready for a new offer;
    // it re-sends `ready`, and wantLive re-offers there. For local media
    // failures with no server event, offer again directly.
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      const retryTimer = setTimeout(() => {
        if (!this.session && this.wantLive) void this.startSession();
      }, 1_000);
      // Not session-scoped: session is already gone. Track for stop().
      this.reconnectTimer = retryTimer;
    }
  }

  private teardownSession(): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    for (const timer of session.timers) clearTimeout(timer);
    try {
      void session.pc.close();
    } catch {
      // peer may already be closed
    }
    if (!this.stopping) {
      this.setPhase(
        this.ws?.readyState === WebSocket.OPEN ? "waiting-ready" : this.phase,
      );
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
