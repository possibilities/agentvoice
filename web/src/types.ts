import type { TranscriptMessage } from "@agentchats/transcript";

export type LiveView = {
  phase: "offline" | "waiting" | "connecting" | "live" | "unavailable";
  id: string;
  voice: TranscriptMessage[];
  agent: TranscriptMessage[];
  /** True until the first complete or viewer-bounded history pass is published. */
  agentHistoryLoading?: boolean;
  voiceNotice?: string;
  agentNotice?: string;
};
