/**
 * The frontend's WebRTC peer to the voice agent. Signaling goes through the
 * voice sidecar (offer in, answer out); audio never touches it. The sidecar
 * refuses a second realtime start while one is running, so a redial is
 * stop-then-start rather than the archive's overlapping negotiation.
 */

import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, RtpBuilder } from "werift";
import { SAMPLE_RATE } from "./dsp.ts";

export type VoicePhase = "idle" | "negotiating" | "live" | "failed" | "stopped";

/** The sidecar half of session signaling. */
export interface TransportSignal {
  /** Starts a realtime session with this offer and returns the answer SDP. */
  start(offerSdp: string): Promise<string>;
  /** Stops the running realtime session; must tolerate one that already closed. */
  stop(): Promise<void>;
}

export interface VoiceTransportOptions {
  signal: TransportSignal;
  onPhase(phase: VoicePhase): void;
  onRemoteTrack(track: MediaStreamTrack): void;
  onOaiEvent(event: Record<string, unknown>): void;
  onInfo(line: string): void;
  onError(line: string): void;
  debug?(line: string): void;
  /** Renew shortly before the ~60-minute upstream session ceiling. */
  renewalMs?: number;
  negotiationTimeoutMs?: number;
  retryMs?: number;
}

const DEFAULT_RENEWAL_MS = 52 * 60_000;
const DEFAULT_NEGOTIATION_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_MS = 1_000;
/** Consecutive failed sessions before requiring a manual redial. */
const MAX_RAPID_FAILURES = 3;
/** A session live this long proves health and resets the failure budget. */
const HEALTHY_SESSION_MS = 60_000;

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
  connected: boolean;
  liveSince: number | null;
  timers: ReturnType<typeof setTimeout>[];
}

export class VoiceTransport {
  private session: PeerSession | null = null;
  private generation = 0;
  private phase: VoicePhase = "idle";
  private rapidFailures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private negotiation: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly options: VoiceTransportOptions) {}

  get currentPhase(): VoicePhase {
    return this.phase;
  }

  get liveForMs(): number | null {
    const since = this.session?.liveSince;
    return since ? Date.now() - since : null;
  }

  /** Dial the voice agent; resolves once media is connected. */
  connect(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error("voice transport is stopped"));
    this.negotiation ??= this.negotiate().finally(() => {
      this.negotiation = null;
    });
    return this.negotiation;
  }

  /** Tear the current session down and dial again. */
  async redial(reason: string): Promise<void> {
    if (this.stopping) return;
    this.rapidFailures = 0;
    this.clearRetryTimer();
    this.options.onInfo(`redial (${reason})`);
    await this.teardown();
    await this.connect().catch(() => {});
  }

  sendOpusFrame(frame: Buffer): void {
    const session = this.session;
    if (!session?.connected) return;
    try {
      session.sendTrack.writeRtp(session.builder.create(frame));
    } catch (error) {
      this.debug(`writeRtp failed: ${message(error)}`);
    }
  }

  /** The sidecar reported the session closed upstream (ceiling, error, …). */
  handleClosed(reason: string): void {
    if (this.stopping) return;
    const session = this.session;
    this.session = null;
    if (session) this.closePeer(session);
    this.options.onInfo(`voice session closed: ${reason}`);
    this.setPhase("idle");
    this.scheduleRetry();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearRetryTimer();
    await this.teardown();
    this.setPhase("stopped");
  }

  private async teardown(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (session) this.closePeer(session);
    await this.options.signal.stop().catch((error) => {
      this.debug(`signal stop failed: ${message(error)}`);
    });
  }

  private async negotiate(): Promise<void> {
    if (this.stopping) throw new Error("voice transport is stopped");
    const generation = ++this.generation;
    const pc = new RTCPeerConnection({ codecs: { audio: [OPUS] } });
    const sendTrack = new MediaStreamTrack({ kind: "audio" });
    const session: PeerSession = {
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
    const channel = pc.createDataChannel("oai-events");
    channel.onmessage = (event) => {
      if (this.session !== session) return;
      const data = (event as { data?: unknown }).data ?? event;
      const text = typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array);
      try {
        this.options.onOaiEvent(JSON.parse(text) as Record<string, unknown>);
      } catch {
        this.debug(`non-JSON oai-event: ${text.slice(0, 80)}`);
      }
    };
    pc.onTrack.subscribe((track) => {
      if (track.kind !== "audio" || this.session !== session) return;
      this.options.onRemoteTrack(track);
    });

    const connected = new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error("voice negotiation timed out")),
        this.options.negotiationTimeoutMs ?? DEFAULT_NEGOTIATION_TIMEOUT_MS,
      );
      session.timers.push(timer);
      pc.connectionStateChange.subscribe((state) => {
        this.debug(`peer ${generation} connection ${state}`);
        if (state === "connected") {
          clearTimeout(timer);
          resolvePromise();
        } else if (state === "failed" || state === "closed") {
          clearTimeout(timer);
          reject(new Error(`media path ${state}`));
          if (this.session === session && session.connected) {
            this.failLive(session, `media path ${state}`);
          }
        }
      });
    });
    // A peer closed after a signaling failure still settles this promise.
    void connected.catch(() => {});

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error("no local description after gathering");
      if (this.session !== session) throw new Error("negotiation superseded");
      const answer = await this.options.signal.start(sdp);
      if (this.session !== session) throw new Error("negotiation superseded");
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
      await connected;
      if (this.session !== session) throw new Error("negotiation superseded");
      this.promote(session);
    } catch (error) {
      if (this.session === session) {
        this.session = null;
        this.closePeer(session);
        await this.options.signal.stop().catch(() => {});
        this.options.onError(`voice: ${message(error)}`);
        this.rapidFailures++;
        this.afterFailure();
      }
      throw error;
    }
  }

  private promote(session: PeerSession): void {
    session.connected = true;
    session.liveSince = Date.now();
    this.setPhase("live");
    this.options.onInfo("voice connected");
    session.timers.push(
      setTimeout(() => {
        if (this.session === session) void this.redial("renewal");
      }, this.options.renewalMs ?? DEFAULT_RENEWAL_MS),
    );
    session.timers.push(
      setTimeout(() => {
        if (this.session === session) this.rapidFailures = 0;
      }, HEALTHY_SESSION_MS),
    );
  }

  private failLive(session: PeerSession, reason: string): void {
    if (this.session !== session) return;
    const wasHealthy =
      session.liveSince !== null && Date.now() - session.liveSince > HEALTHY_SESSION_MS;
    this.session = null;
    this.closePeer(session);
    void this.options.signal.stop().catch(() => {});
    this.options.onError(`voice: ${reason}`);
    this.rapidFailures = wasHealthy ? 1 : this.rapidFailures + 1;
    this.afterFailure();
  }

  private afterFailure(): void {
    if (this.rapidFailures >= MAX_RAPID_FAILURES) {
      this.options.onError("voice failed repeatedly — press r to redial");
      this.setPhase("failed");
      return;
    }
    this.setPhase("idle");
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopping || this.phase === "failed") return;
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopping && !this.session) void this.connect().catch(() => {});
    }, this.options.retryMs ?? DEFAULT_RETRY_MS);
  }

  private closePeer(session: PeerSession): void {
    for (const timer of session.timers) clearTimeout(timer);
    session.timers = [];
    try {
      void session.pc.close().catch(() => {});
    } catch {
      // The peer may already be closed.
    }
  }

  private setPhase(phase: VoicePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.options.onPhase(phase);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private debug(line: string): void {
    this.options.debug?.(line);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
