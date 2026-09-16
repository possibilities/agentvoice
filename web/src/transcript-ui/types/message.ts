export type MessageRole = "user" | "assistant" | "system" | "tool";

export type MessageStatus = "complete" | "working" | "streaming" | "error";

export interface ToolActivity {
  name: string;
  /** Full summary text; the disclosure clips it visually and exposes it on expand. */
  detail: string;
  state: "queued" | "running" | "complete" | "error";
  meta?: string;
  /** Complete payloads, without preview truncation. */
  sections?: ToolDetailSection[];
}

export interface ToolDetailSection {
  label: string;
  content: string;
}

export interface FileChange {
  path: string;
  kind: string;
  movePath?: string;
  diff: string;
  diffTruncated: boolean;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  /** Omit when the source does not report a timestamp. */
  createdAt?: string;
  status: MessageStatus;
  /** Host-owned delivery text for optimistic Human input; omit after reconciliation. */
  deliveryStatus?: string;
  toolActivity?: ToolActivity;
  fileChanges?: FileChange[];
  /** Optional user/assistant body interpretation; content remains the original record. */
  presentation?: MessagePresentation;
  /** Exact source item type when custom rendering depends on native item identity. */
  nativeItemType?: string;
}

/** Provider-neutral, plain-text presentation of a structured message payload. */
export interface MessagePresentation {
  title: string;
  body: string;
  details?: readonly { label: string; content: string }[];
}
