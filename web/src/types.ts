import type { TranscriptMessage } from "@agentchats/transcript";

export type LiveView = {
  phase: "offline" | "waiting" | "connecting" | "live" | "unavailable";
  id: string;
  voice: TranscriptMessage[];
  agent: TranscriptMessage[];
  voiceNotice?: string;
  agentNotice?: string;
};
