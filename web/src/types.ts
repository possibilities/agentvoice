import type { LocalImageAttachment } from "../../src/attachment/image-contract.ts";
import type { TranscriptMessage } from "./transcript-ui/transcript/index.ts";

export type AgentQueuedMessage = {
  id: string;
  text: string;
  images?: LocalImageAttachment[];
  pausedReason?: string;
  canSteer: boolean;
  canResume: boolean;
  disabled: boolean;
};

export type AgentControlsView = {
  available: boolean;
  /** Plain-language reason actions are unavailable while the draft remains editable. */
  inputUnavailableReason?: string;
  active: boolean;
  stopping: boolean;
  pending: boolean;
  queue: AgentQueuedMessage[];
  notice?: string;
};

export type LiveView = {
  phase: "offline" | "empty" | "detached" | "connecting" | "live" | "unavailable";
  id: string;
  /** Opaque workspace/thread scope for browser-local composer recovery. */
  persistenceScope?: string;
  voice: TranscriptMessage[];
  agent: TranscriptMessage[];
  /** True until the first complete or viewer-bounded history pass is published. */
  agentHistoryLoading?: boolean;
  voiceHistoryLoading?: boolean;
  agentControls?: AgentControlsView;
  voiceNotice?: string;
  agentNotice?: string;
};
