export type SessionStatus = "idle" | "working" | "attention" | "complete";

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  status: SessionStatus;
  messageCount: number;
  workspace?: string;
  cwd?: string;
  model?: string;
}
