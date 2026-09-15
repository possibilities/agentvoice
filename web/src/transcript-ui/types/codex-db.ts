export type CodexTurnStatus = "inProgress" | "completed" | "failed" | "interrupted" | string;

export type CodexTranscriptDetail = "messages" | "full";

export interface CodexThreadRecord {
  id: string;
  title: string;
  cwd: string;
  rolloutPath: string;
  source: string;
  threadSource: string | null;
  model: string | null;
  gitBranch: string | null;
  preview: string;
  updatedAtMs: number;
  recencyAtMs: number;
  hasUserEvent: boolean;
  messageCount: number;
  turnStatus: CodexTurnStatus | null;
}

export interface CodexThreadItemRecord {
  threadId: string;
  turnId: string;
  itemId: string;
  rolloutOrdinal: number;
  createdAtMs: number;
  itemType: string;
  item: unknown;
}

export interface CodexThreadListResponse {
  threads: CodexThreadRecord[];
}

export interface CodexThreadDetailResponse {
  thread: CodexThreadRecord;
  items: CodexThreadItemRecord[];
  latestOrdinal: number;
  turnStatus: CodexTurnStatus | null;
}

export interface CodexThreadItemsResponse {
  items: CodexThreadItemRecord[];
  latestOrdinal: number;
  turnStatus: CodexTurnStatus | null;
}

export interface CodexApiError {
  error: string;
}
