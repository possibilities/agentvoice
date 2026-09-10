/**
 * Server-owned session policy for client-owned WebRTC.
 *
 * This class never sees a peer connection or media.
 * It tells a browser bridge to prepare a peer, relays that exact peer's offer
 * to the runtime, and returns the runtime answer to the same session id.
 */
import { randomUUID } from "node:crypto";
import type { ReadyInfo as SessionReadyInfo, VoicePhase } from "../core/voice-types.ts";

export type ClientReadyInfo = SessionReadyInfo;
export type ClientSessionPhase = VoicePhase;

export type ClientSessionCommand =
  | { type: "prepare"; sessionId: string }
  | { type: "answer"; sessionId: string; sdp: string }
  | { type: "close"; sessionId: string };

export interface ClientSessionSignal {
  offer(sdp: string): void;
}

export interface ClientSessionOptions {
  signal: ClientSessionSignal;
  send(command: ClientSessionCommand): void;
  onPhase(phase: ClientSessionPhase): void;
  onReady(info: ClientReadyInfo): void;
  onInfo(line: string): void;
  onError(line: string): void;
  debug?(line: string): void;
  /** Test boundary; production ids remain unguessable UUIDs. */
  createSessionId?(): string;
  /** Test boundary; omitted values use the production lifecycle timings. */
  timings?: Partial<ClientSessionTimings>;
}

export interface ClientSessionTimings {
  negotiationTimeoutMs: number;
  retryMs: number;
  renewalMs: number;
  healthySessionMs: number;
}

const DEFAULT_TIMINGS: ClientSessionTimings = {
  negotiationTimeoutMs: 30_000,
  retryMs: 1_000,
  renewalMs: 52 * 60_000,
  healthySessionMs: 60_000,
};
const MAX_RAPID_FAILURES = 3;

interface BrowserSession {
  id: string;
  offered: boolean;
  connected: boolean;
  liveSince: number | null;
  timers: ReturnType<typeof setTimeout>[];
}

interface RedialWaiter {
  resolve(): void;
  reject(error: Error): void;
}

export class ClientMediaSession {
  readonly #options: ClientSessionOptions;
  readonly #timings: ClientSessionTimings;
  #live: BrowserSession | null = null;
  #pending: BrowserSession | null = null;
  #ready: ClientReadyInfo | null = null;
  #phase: ClientSessionPhase = "waiting-ready";
  #rapidFailures = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #stopping = false;
  #changingVoice = false;
  readonly #redialWaiters = new Map<string, RedialWaiter>();

  constructor(options: ClientSessionOptions) {
    this.#options = options;
    this.#timings = { ...DEFAULT_TIMINGS, ...options.timings };
  }

  get currentPhase(): ClientSessionPhase {
    return this.#phase;
  }

  /** Native-host compatibility: media travels directly through the browser. */
  sendOpusFrame(_frame: Buffer): void {}

  redial(reason: string): void {
    if (this.#stopping) return;
    if (this.#changingVoice && reason !== "voice-change") return;
    this.#rapidFailures = 0;
    this.#options.onInfo(`redial (${reason})`);
    this.#clearRetry();
    if (this.#ready) this.#negotiate();
  }

  /** Resolve only when the successor created by this call connects. */
  async redialAndWait(reason: string): Promise<void> {
    if (this.#stopping || !this.#ready)
      throw new Error("Browser voice transport is not ready for redial");
    if (this.#changingVoice) throw new Error("Voice change already in progress");
    this.#changingVoice = reason === "voice-change";
    if (this.#changingVoice && this.#live) {
      for (const timer of this.#live.timers) clearTimeout(timer);
      this.#live.timers = [];
    }
    try {
      this.redial(reason);
      const session = this.#pending;
      if (!session) throw new Error("Browser voice redial could not prepare a successor");
      await new Promise<void>((resolve, reject) => {
        this.#redialWaiters.set(session.id, { resolve, reject });
      });
    } finally {
      this.#changingVoice = false;
    }
  }

  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#clearRetry();
    this.#dropSessions("Browser voice redial was superseded or stopped");
    this.#setPhase("stopped");
  }

  // Runtime-facing signaling.

  handleReady(info: ClientReadyInfo): void {
    if (this.#stopping) return;
    this.#ready = info;
    this.#options.onReady(info);
    this.#debug(`ready: thread ${info.threadId}`);
    if (!this.#changingVoice && !this.#live && !this.#pending && !this.#retryTimer) {
      if (this.#rapidFailures >= MAX_RAPID_FAILURES) this.#setPhase("failed");
      else this.#negotiate();
    }
  }

  async handleAnswer(sdp: string): Promise<void> {
    const session = this.#pending;
    if (!session?.offered) {
      this.#debug("dropping answer with no offered browser session");
      return;
    }
    this.#options.send({ type: "answer", sessionId: session.id, sdp });
    this.#debug(`answer sent (session ${session.id})`);
  }

  handleClosed(reason?: string): void {
    if (this.#stopping) return;
    this.#ready = null;
    this.#options.onInfo(`voice session closed: ${reason ?? "session ended"}`);
    const live = this.#live;
    this.#live = null;
    if (live) this.#closeSession(live, "Browser voice session closed");
    if (!this.#pending) this.#setPhase("waiting-ready");
  }

  handleSignalLost(): void {
    if (this.#stopping) return;
    this.#ready = null;
    this.#rapidFailures = 0;
    this.#clearRetry();
    this.#dropSessions("Browser voice signal was lost");
    this.#setPhase("waiting-ready");
  }

  handleError(text: string, fatal: boolean): void {
    if (this.#stopping) return;
    if (!fatal) {
      this.#options.onInfo(text);
      return;
    }
    if (this.#pending) this.#failPending(this.#pending, text);
    else if (this.#live) this.#failLive(this.#live, text);
    else this.#options.onError(text);
  }

  // Browser-facing signaling. Every event is scoped to an exact session id;
  // stale or guessed ids have no effect on the current session.

  handleClientOffer(sessionId: string, sdp: string): boolean {
    const session = this.#pending;
    if (!session || session.id !== sessionId || session.offered || !sdp) {
      this.#debug(`dropping browser offer for non-current session ${sessionId}`);
      return false;
    }
    session.offered = true;
    this.#options.signal.offer(sdp);
    this.#debug(`offer relayed (session ${session.id})`);
    return true;
  }

  handleClientConnected(sessionId: string): boolean {
    const session = this.#pending;
    if (!session || session.id !== sessionId || !session.offered) {
      this.#debug(`dropping browser connected for non-current session ${sessionId}`);
      return false;
    }
    this.#promote(session);
    return true;
  }

  handleClientFailed(sessionId: string, reason = "browser media path failed"): boolean {
    if (this.#pending?.id === sessionId) {
      this.#failPending(this.#pending, reason);
      return true;
    }
    if (this.#live?.id === sessionId) {
      this.#failLive(this.#live, reason);
      return true;
    }
    this.#debug(`dropping browser failure for non-current session ${sessionId}`);
    return false;
  }

  #negotiate(): void {
    if (this.#stopping || !this.#ready || this.#rapidFailures >= MAX_RAPID_FAILURES) return;
    this.#clearRetry();
    const stale = this.#pending;
    this.#pending = null;
    if (stale) this.#closeSession(stale, "Browser voice redial was superseded");

    const id = this.#options.createSessionId?.() ?? randomUUID();
    if (!id || id === this.#live?.id)
      throw new Error("Browser voice session ids must be non-empty and unique");
    const session: BrowserSession = {
      id,
      offered: false,
      connected: false,
      liveSince: null,
      timers: [],
    };
    this.#pending = session;
    if (!this.#live) this.#setPhase("negotiating");
    this.#options.send({ type: "prepare", sessionId: id });
    this.#debug(`browser peer requested (session ${id})`);
    session.timers.push(
      setTimeout(() => {
        if (this.#pending === session && !session.connected)
          this.#failPending(session, "voice negotiation timed out");
      }, this.#timings.negotiationTimeoutMs),
    );
  }

  #promote(session: BrowserSession): void {
    this.#pending = null;
    const previous = this.#live;
    this.#live = session;
    session.connected = true;
    session.liveSince = Date.now();
    if (previous) this.#closeSession(previous, "Browser voice session renewed");
    this.#setPhase("live");
    this.#settleRedial(session);
    this.#options.onInfo(previous ? "voice session renewed" : "voice connected");
    session.timers.push(
      setTimeout(() => {
        if (this.#live === session) this.redial("renewal");
      }, this.#timings.renewalMs),
      setTimeout(() => {
        if (this.#live === session) this.#rapidFailures = 0;
      }, this.#timings.healthySessionMs),
    );
  }

  #failPending(session: BrowserSession, reason: string): void {
    if (this.#pending !== session) return;
    this.#pending = null;
    this.#closeSession(session, reason);
    this.#rapidFailures++;
    this.#afterFailure(reason);
  }

  #failLive(session: BrowserSession, reason: string): void {
    if (this.#live !== session) return;
    const healthy =
      session.liveSince !== null && Date.now() - session.liveSince > this.#timings.healthySessionMs;
    this.#live = null;
    this.#closeSession(session, reason);
    if (this.#pending) {
      this.#options.onError(reason);
      return;
    }
    this.#rapidFailures = healthy ? 1 : this.#rapidFailures + 1;
    this.#afterFailure(reason);
  }

  #afterFailure(reason: string): void {
    this.#clearRetry();
    if (this.#changingVoice) {
      this.#rapidFailures = MAX_RAPID_FAILURES;
      this.#options.onError(`${reason} — voice change failed; retry explicitly`);
      if (!this.#live) this.#setPhase("failed");
      return;
    }
    if (this.#rapidFailures >= MAX_RAPID_FAILURES) {
      this.#options.onError(`${reason} — retries paused; use the control API to redial`);
      this.#dropSessions("Browser voice retries paused");
      this.#setPhase("failed");
      return;
    }
    this.#options.onError(reason);
    if (!this.#live) this.#setPhase("waiting-ready");
    if (this.#ready) {
      this.#retryTimer = setTimeout(() => {
        this.#retryTimer = null;
        if (!this.#stopping && !this.#pending) this.#negotiate();
      }, this.#timings.retryMs);
    }
  }

  #dropSessions(reason: string): void {
    const pending = this.#pending;
    const live = this.#live;
    this.#pending = null;
    this.#live = null;
    if (pending) this.#closeSession(pending, reason);
    if (live) this.#closeSession(live, reason);
  }

  #closeSession(session: BrowserSession, waiterReason: string): void {
    this.#settleRedial(session, waiterReason);
    for (const timer of session.timers) clearTimeout(timer);
    session.timers = [];
    this.#options.send({ type: "close", sessionId: session.id });
  }

  #settleRedial(session: BrowserSession, reason?: string): void {
    const waiter = this.#redialWaiters.get(session.id);
    if (!waiter) return;
    this.#redialWaiters.delete(session.id);
    if (reason) waiter.reject(new Error(reason));
    else waiter.resolve();
  }

  #clearRetry(): void {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  #setPhase(phase: ClientSessionPhase): void {
    if (this.#phase === phase) return;
    this.#phase = phase;
    this.#options.onPhase(phase);
  }

  #debug(line: string): void {
    this.#options.debug?.(line);
  }
}
