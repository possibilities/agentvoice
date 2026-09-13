import type { TranscriptMessage } from "@agentchats/transcript";

export type AgentQueuedMessage = {
  id: string;
  text: string;
  pausedReason?: string;
  canSteer: boolean;
  canResume: boolean;
  disabled: boolean;
};

export type AgentControlsView = {
  available: boolean;
  active: boolean;
  stopping: boolean;
  pending: boolean;
  queue: AgentQueuedMessage[];
  notice?: string;
};

export type LiveView = {
  phase: "offline" | "waiting" | "connecting" | "live" | "unavailable";
  id: string;
  voice: TranscriptMessage[];
  agent: TranscriptMessage[];
  /** True until the first complete or viewer-bounded history pass is published. */
  agentHistoryLoading?: boolean;
  voiceHistoryLoading?: boolean;
  agentControls?: AgentControlsView;
  voiceNotice?: string;
  agentNotice?: string;
};
