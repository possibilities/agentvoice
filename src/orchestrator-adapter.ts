/**
 * The orchestrator adapter contract: what the voice layer needs from any
 * orchestrator agent backend. Every backend (Fx over ACP, Fx over the PTY
 * work-control path, a future Codex App-server) implements this surface so
 * the delegation bridge and the TUI never see the transport underneath.
 */

export type OrchestratorDisposition = "queued" | "steering";
export type OrchestratorTurnOutcome = "completed" | "interrupted" | "failed" | "paused";
export type OrchestratorAgentState = "idle" | "working" | "blocked";
export type OrchestratorAttentionKind = "permission" | "question" | "route_recovery";

/** The result of admitting voice-agent text into the orchestrator. */
export interface OrchestratorAdmission {
  /** The turn the caller waits on; for steering it names the steering entry, not the active turn. */
  delegationTurnId: string;
  /** `steering` only when the text was admitted into a turn already in flight. */
  disposition: OrchestratorDisposition;
  activeTurnId: string | null;
}

export interface OrchestratorTurnResult {
  turnId: string;
  outcome: OrchestratorTurnOutcome;
  providerDisposition: string | null;
  assistantText: string;
}

export interface OrchestratorIdentity {
  backend: string;
  version: string;
  buildRevision: string | null;
  auth: string | null;
  modelSource: string | null;
  permissionMode: string | null;
  model: string;
  reasoningEffort: string;
}

export type OrchestratorLifecycleType =
  | "orchestrator.started"
  | "turn.started"
  | "turn.ended"
  | "attention.raised"
  | "attention.cleared"
  | "orchestrator.stopped";

export interface OrchestratorLifecycleEvent {
  sequence: number;
  type: OrchestratorLifecycleType;
  turnId: string | null;
  agentState: OrchestratorAgentState;
  attentionKind: OrchestratorAttentionKind | null;
  data: Record<string, unknown>;
}

export type OrchestratorLifecycleListener = (event: OrchestratorLifecycleEvent) => void;

export interface OrchestratorCapabilities {
  /** Genuine in-flight steering; a backend that can only queue reports false. */
  steering: boolean;
  interrupt: boolean;
  /** Attention (permission, question) is surfaced as lifecycle rather than swallowed. */
  attention: boolean;
}

export interface OrchestratorAdapter {
  readonly backend: string;
  readonly capabilities: OrchestratorCapabilities;
  start(): Promise<OrchestratorIdentity>;
  admit(text: string): Promise<OrchestratorAdmission>;
  waitForTurn(turnId: string, timeoutMs: number): Promise<OrchestratorTurnResult>;
  interrupt(): Promise<void>;
  onLifecycle(listener: OrchestratorLifecycleListener): () => void;
  stop(): Promise<void>;
}

/** Shared lifecycle fan-out with one monotonic sequence per adapter instance. */
export class LifecycleEmitter {
  private sequence = 0;
  private readonly listeners = new Set<OrchestratorLifecycleListener>();
  private readonly history: OrchestratorLifecycleEvent[] = [];

  subscribe(listener: OrchestratorLifecycleListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: Omit<OrchestratorLifecycleEvent, "sequence">): OrchestratorLifecycleEvent {
    const record: OrchestratorLifecycleEvent = { sequence: ++this.sequence, ...event };
    this.history.push(record);
    for (const listener of this.listeners) listener(record);
    return record;
  }

  snapshot(): readonly OrchestratorLifecycleEvent[] {
    return this.history;
  }
}
