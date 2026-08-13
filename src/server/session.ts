/**
 * The voice-session state machine: at most one realtime session on the
 * orchestrator agent, superseded by each new offer.
 *
 * Built on verified codex 0.147 app-server semantics (see AGENTS.md):
 *  - app-server manages ONE realtime session per thread; a new start
 *    supersedes the previous session silently — no closed notification.
 *  - thread/realtime/stop always emits exactly one closed(reason "requested"),
 *    even when no session exists.
 *  - Ops on a thread are processed serially, so a stop issued after a start
 *    always lands after it — a start can never outlive a later stop.
 *  - started echoes our realtimeSessionId; closed/error carry no session id.
 *
 * Renewal therefore sends no stop at all (the start supersedes), and stops are
 * exactly countable: every stop we issue consumes exactly one
 * closed("requested"), so any other closed belongs to the current session.
 */

import type { VoiceLifecycleReason, VoiceLifecycleState } from "../protocol.ts";

export interface VoiceSessionEffects {
  /** Relay the answer for the current session. */
  sendAnswer(voiceSessionId: string, sdp: string): void;
  /** The current session ended; the client should wait for ready. */
  sendClosed(reason?: string): void;
  /** The current session failed fatally; the client should drop its peer. */
  sendFailed(message: string): void;
  /** Re-announce readiness: offers are accepted again. */
  sendReady(): void;
  /** thread/realtime/start with this session id and SDP offer. */
  startRealtime(realtimeSessionId: string, sdp: string): Promise<void>;
  /** thread/realtime/stop; always yields exactly one closed("requested"). */
  stopRealtime(): Promise<void>;
  /** Publish the authoritative lifetime of a realtime voice session. */
  publishLifecycle(
    voiceSessionId: string,
    state: VoiceLifecycleState,
    reason?: VoiceLifecycleReason,
  ): void;
  debug?(line: string): void;
}

/** Readiness is the thread/realtime/started notification, not the RPC ack. */
export const REALTIME_START_TIMEOUT_MS = 60_000;

interface Session {
  id: string;
  active: boolean;
  startTimer: ReturnType<typeof setTimeout> | null;
}

export class VoiceSessionManager {
  private readonly effects: VoiceSessionEffects;
  private readonly startTimeoutMs: number;
  private session: Session | null = null;
  /** Stops we have issued whose closed("requested") has not yet arrived. */
  private pendingRequestedCloses = 0;

  constructor(effects: VoiceSessionEffects, startTimeoutMs = REALTIME_START_TIMEOUT_MS) {
    this.effects = effects;
    this.startTimeoutMs = startTimeoutMs;
  }

  get hasSession(): boolean {
    return this.session !== null;
  }

  /** A new offer supersedes whatever is running — renewal and retry alike. */
  handleOffer(sdp: string): void {
    if (this.session) this.endSession("superseded");
    const next: Session = { id: crypto.randomUUID(), active: false, startTimer: null };
    this.session = next;
    this.effects.publishLifecycle(next.id, "starting");
    next.startTimer = setTimeout(() => {
      if (this.session !== next) return;
      this.fail(next, `realtime session did not start within ${this.startTimeoutMs}ms`);
    }, this.startTimeoutMs);
    this.effects.debug?.(`starting realtime session ${next.id}`);
    void this.effects.startRealtime(next.id, sdp).catch((error) => {
      if (this.session !== next) return;
      this.fail(next, error instanceof Error ? error.message : String(error));
    });
  }

  handleNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "thread/realtime/started": {
        // A stale id is a superseded or stopped start coming up late; the
        // supersede or our ordered stop already covers it — ignore.
        if (this.session && params["realtimeSessionId"] === this.session.id) {
          this.session.active = true;
          if (this.session.startTimer) {
            clearTimeout(this.session.startTimer);
            this.session.startTimer = null;
          }
          this.effects.debug?.(`realtime session ${this.session.id} active`);
          this.effects.publishLifecycle(this.session.id, "active");
        }
        return;
      }
      case "thread/realtime/sdp": {
        // started always precedes its answer, so an answer with no active
        // session belongs to a superseded start: drop it.
        const sdp = params["sdp"];
        if (this.session?.active && typeof sdp === "string") {
          this.effects.sendAnswer(this.session.id, sdp);
        } else {
          this.effects.debug?.("dropping realtime sdp with no active session");
        }
        return;
      }
      case "thread/realtime/closed": {
        const reason = typeof params["reason"] === "string" ? params["reason"] : undefined;
        if (reason === "requested" && this.pendingRequestedCloses > 0) {
          this.pendingRequestedCloses--;
          this.effects.debug?.("closed attributed to a stop we issued");
          return;
        }
        if (!this.session) return;
        this.endSession("upstream-closed");
        this.effects.sendClosed(reason);
        this.effects.sendReady();
        return;
      }
      case "thread/realtime/error": {
        if (!this.session) return;
        const message =
          typeof params["message"] === "string" ? params["message"] : "realtime session failed";
        this.endSession("upstream-error");
        this.effects.sendFailed(message);
        this.effects.sendReady();
        return;
      }
      default:
        return; // transcript deltas and other realtime chatter: not our surface
    }
  }

  /** The client is gone; session lifetime is socket lifetime. */
  handleClientGone(): void {
    if (!this.session) return;
    this.endSession("client-gone");
    this.stop();
  }

  /** Everything died with the app-server child; nothing left to stop. */
  reset(): void {
    if (this.session) this.endSession("app-server-reset");
    this.pendingRequestedCloses = 0;
  }

  /** Bounded by the caller; resolves when the stop RPC is acknowledged. */
  async shutdown(): Promise<void> {
    if (!this.session) return;
    this.endSession("shutdown");
    await this.stopCounted();
  }

  private fail(session: Session, message: string): void {
    if (this.session !== session) return;
    this.endSession("upstream-error");
    // Ordered after the start, so this reclaims the session even if it was
    // still coming up when we gave up on it.
    this.stop();
    this.effects.sendFailed(message);
    this.effects.sendReady();
  }

  private clearSession(): void {
    if (this.session?.startTimer) clearTimeout(this.session.startTimer);
    this.session = null;
  }

  private endSession(reason: VoiceLifecycleReason): void {
    const session = this.session;
    if (!session) return;
    this.effects.publishLifecycle(session.id, "ended", reason);
    this.clearSession();
  }

  private stop(): void {
    void this.stopCounted();
  }

  private async stopCounted(): Promise<void> {
    this.pendingRequestedCloses++;
    try {
      await this.effects.stopRealtime();
    } catch {
      // The stop never reached app-server, so no closed will arrive for it.
      this.pendingRequestedCloses = Math.max(0, this.pendingRequestedCloses - 1);
    }
  }
}
