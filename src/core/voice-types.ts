/** In-process state shared by the runtime, media transport, and TUI. */
export type VoicePhase = "waiting-ready" | "negotiating" | "live" | "failed" | "stopped";

export interface ReadyInfo {
  threadId: string;
  workspace: string;
  model: string | null;
  /** Native configured tier, not per-request billing/execution telemetry. */
  serviceTier?: string | null;
  requestedServiceTier?: string;
  /** Reported by Codex; null means no reported effort. */
  effort: string | null;
  conversationMode: "started" | "continued";
  /** Reported for the current voice session, never inferred from config. */
  voiceVersion: string | null;
  prompts: string[];
}
