/** In-process state shared by the runtime, media transport, and TUI. */
export type VoicePhase = "waiting-ready" | "negotiating" | "live" | "failed" | "stopped";

export interface ReadyInfo {
  threadId: string;
  workspace: string;
  model: string | null;
  effort: string | null;
  voiceModel: string | null;
  voice: string | null;
  prompts: string[];
}
