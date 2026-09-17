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
  /** Optional plain-text presentation; content remains the original record. */
  presentation?: MessagePresentation;
  /** Exact source item type when custom rendering depends on native item identity. */
  nativeItemType?: string;
  /** Small allowlisted view of a native routing-context output. */
  routingContext?: RoutingContextPresentation;
}

export interface RoutingBalance {
  provider: "Codex" | "Grok";
  lane: string;
  remainingPercent: number;
  resetsAt?: string;
  eligible?: boolean;
}

export interface RoutingContextPresentation {
  revision: number;
  generation: number;
  mode: "full" | "delta";
  current?: {
    provider?: string;
    model?: string;
    effort?: string;
    serviceTier?: string;
  };
  delegationAvailable?: boolean;
  balances?: readonly RoutingBalance[];
  observedAt?: string;
  expiresAt?: string;
}

/** Provider-neutral, plain-text presentation of a structured message payload. */
export interface MessagePresentation {
  title: string;
  body: string;
  details?: readonly { label: string; content: string }[];
}
