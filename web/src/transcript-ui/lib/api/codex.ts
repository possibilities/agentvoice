import type {
  CodexApiError,
  CodexThreadDetailResponse,
  CodexThreadItemRecord,
  CodexThreadItemsResponse,
  CodexTurnStatus,
} from "@/types/codex-db";
import type { FileChange, Message, ToolActivity, ToolDetailSection } from "@/types/message";
import type { Thread } from "@/types/thread";
import type { TranscriptStatus } from "../../transcript/types.ts";
import { contextCompactionMessage } from "../system-events.ts";
import { transcriptTitle } from "../transcript-title.ts";
import { parseCodexMessagePresentation } from "./codex-presentation.ts";
import { mapCodexSubagentActivity } from "./codex-subagent-activity.ts";
import { mapCodexSubagentEvent } from "./codex-subagent-event.ts";

export interface CodexThreadView {
  thread: Thread;
  latestOrdinal: number;
  status: TranscriptStatus;
}

export interface CodexThreadUpdate {
  messages: Message[];
  latestOrdinal: number;
  status: TranscriptStatus;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

function compact(value: string, maximum = 180) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maximum
    ? normalized.slice(0, maximum - 1).trimEnd() + "…"
    : normalized;
}

function inlineCode(value: string) {
  return "`" + value.replaceAll("`", "ˋ") + "`";
}

function basename(value: string) {
  const pieces = value.split(/[\\/]/);
  return pieces.at(-1) || value;
}

function detailSection(label: string, content: unknown): ToolDetailSection[] {
  const text = stringValue(content);
  return text.trim() ? [{ label, content: text }] : [];
}

function sessionStatus(status: CodexTurnStatus | null): TranscriptStatus {
  if (status === "inProgress") return "working";
  if (status === "failed" || status === "interrupted") return "attention";
  if (status === "completed") return "complete";
  return "idle";
}

function toolState(item: JsonObject): ToolActivity["state"] {
  const status = stringValue(item.status).toLowerCase();
  if (["failed", "error", "declined", "cancelled"].includes(status)) return "error";
  if (["running", "inprogress", "in_progress", "pending"].includes(status)) {
    return "running";
  }
  if (["queued", "requested"].includes(status)) return "queued";
  return "complete";
}

function userText(item: JsonObject) {
  const content = item.content;
  if (!Array.isArray(content)) return stringValue(item.text);

  return content
    .flatMap((part) => {
      if (!isObject(part)) return [];
      const text = stringValue(part.text);
      return text ? [text] : [];
    })
    .join("\n\n");
}

function commandActivity(item: JsonObject): { content: string; activity: ToolActivity } {
  const command = stringValue(item.command) || "Shell command";
  const state = toolState(item);
  const exitCode = numberValue(item.exitCode);
  const result =
    exitCode === undefined
      ? state === "running"
        ? "running"
        : stringValue(item.status) || "complete"
      : `exit ${exitCode}`;

  return {
    content: `Ran ${inlineCode(compact(command))} · ${result}`,
    activity: {
      name: "Command",
      detail: command,
      meta: result,
      state,
      sections: [
        ...detailSection("Command", command),
        ...detailSection("Working directory", item.cwd),
        ...detailSection("Output", item.output),
      ],
    },
  };
}

function fileActivity(item: JsonObject): {
  content: string;
  activity: ToolActivity;
  fileChanges: FileChange[];
} {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const fileChanges = changes.flatMap((change): FileChange[] => {
    if (!isObject(change)) return [];
    const filePath = stringValue(change.path);
    if (!filePath) return [];
    return [
      {
        path: filePath,
        kind: stringValue(change.kind) || "update",
        movePath: stringValue(change.movePath) || undefined,
        diff: stringValue(change.diff),
        diffTruncated: change.diffTruncated === true,
      },
    ];
  });
  const names = fileChanges.map((change) => basename(change.path));
  const detail = `${fileChanges.length} ${fileChanges.length === 1 ? "file" : "files"}`;
  const shown = names.slice(0, 3).join(", ");
  const remainder = names.length > 3 ? ` +${names.length - 3}` : "";

  return {
    content: shown ? `Changed ${shown}${remainder}` : `Changed ${detail}`,
    activity: {
      name: "Files",
      detail: shown ? `${shown}${remainder}` : detail,
      meta: stringValue(item.status) || detail,
      state: toolState(item),
      sections: [{ label: "Original record", content: JSON.stringify(item, null, 2) }],
    },
    fileChanges,
  };
}

function mcpActivity(item: JsonObject): { content: string; activity: ToolActivity } {
  const server = stringValue(item.server) || "MCP";
  const tool = stringValue(item.tool) || "tool";
  const toolName = `${server}.${tool}`;
  const duration = numberValue(item.durationMs);
  const detail = duration === undefined ? server : `${server} · ${duration} ms`;
  return {
    content: `Called ${inlineCode(toolName)}`,
    activity: {
      name: "MCP",
      detail: toolName,
      meta: detail,
      state: toolState(item),
      sections: [
        ...detailSection("Tool", toolName),
        ...detailSection("Arguments", item.argumentsText),
        ...detailSection("Result", item.resultText),
        ...detailSection("Error", item.errorText),
      ],
    },
  };
}

function searchActivity(item: JsonObject): { content: string; activity: ToolActivity } {
  const query = stringValue(item.query) || "Web search";
  const results = numberValue(item.resultCount) ?? 0;
  const detail = results ? `${results} results` : "search";
  return {
    content: `Searched for ${inlineCode(compact(query))}`,
    activity: {
      name: "Web",
      detail: query,
      meta: detail,
      state: toolState(item),
      sections: [
        ...detailSection("Query", query),
        ...detailSection("Action", item.actionText),
        ...detailSection("Results", item.resultsText),
      ],
    },
  };
}

export function mapCodexItem(record: CodexThreadItemRecord): Message | null {
  if (!isObject(record.item)) return null;

  const createdAt = new Date(record.createdAtMs).toISOString();
  const id = `${record.turnId}:${record.itemId}`;

  if (record.itemType === "subAgentActivity") {
    const event = mapCodexSubagentEvent(record.item);
    if (event) return { id, createdAt, ...event };
  }

  if (record.itemType === "contextCompaction") {
    return { id, createdAt, ...contextCompactionMessage(true) };
  }

  if (record.itemType === "userMessage") {
    const content = userText(record.item);
    return content
      ? {
          id,
          role: "user",
          content,
          createdAt,
          status: "complete",
          presentation: parseCodexMessagePresentation(content),
        }
      : null;
  }

  if (record.itemType === "agentMessage") {
    const content = stringValue(record.item.text);
    return content
      ? {
          id,
          role: "assistant",
          content,
          createdAt,
          status: "complete",
        }
      : null;
  }

  let mapped: {
    content: string;
    activity: ToolActivity;
    fileChanges?: FileChange[];
  } | null = null;
  if (record.itemType === "commandExecution") mapped = commandActivity(record.item);
  if (record.itemType === "fileChange") mapped = fileActivity(record.item);
  if (record.itemType === "mcpToolCall") mapped = mcpActivity(record.item);
  if (record.itemType === "webSearch") mapped = searchActivity(record.item);
  if (record.itemType === "subAgentActivity") {
    mapped = mapCodexSubagentActivity(record.item);
  }
  if (!mapped) return null;

  return {
    id,
    role: "tool",
    content: mapped.content,
    createdAt,
    status: mapped.activity.state === "error" ? "error" : "complete",
    toolActivity: mapped.activity,
    fileChanges: mapped.fileChanges,
    ...(record.itemType === "fileChange" ? { nativeItemType: "fileChange" } : {}),
  };
}

function mapItems(items: CodexThreadItemRecord[]) {
  return items.flatMap((item) => {
    const message = mapCodexItem(item);
    return message ? [message] : [];
  });
}

export interface CodexTransportOptions {
  /** Same-origin proxy base, or a URL permitted by the host server's origin policy. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

async function getJson<T>(
  url: string,
  signal?: AbortSignal,
  transport: CodexTransportOptions = {},
): Promise<T> {
  const endpoint = `${(transport.baseUrl ?? "/api").replace(/\/$/, "")}${url}`;
  const response = await (transport.fetch ?? globalThis.fetch)(endpoint, {
    signal,
    headers: { Accept: "application/json" },
  });
  const data = (await response.json()) as T | CodexApiError;
  if (!response.ok) {
    throw new Error(
      isObject(data) && typeof data.error === "string" ? data.error : response.statusText,
    );
  }
  return data as T;
}

export async function fetchThread(
  threadId: string,
  signal?: AbortSignal,
  transport?: CodexTransportOptions,
): Promise<CodexThreadView> {
  const response = await getJson<CodexThreadDetailResponse>(
    `/threads/${encodeURIComponent(threadId)}?detail=full`,
    signal,
    transport,
  );
  return {
    thread: {
      id: response.thread.id,
      sessionId: response.thread.id,
      title: transcriptTitle(response.thread.title),
      messages: mapItems(response.items),
    },
    latestOrdinal: response.latestOrdinal,
    status: sessionStatus(response.turnStatus),
  };
}

export async function fetchThreadItems(
  threadId: string,
  afterOrdinal: number,
  signal?: AbortSignal,
  transport?: CodexTransportOptions,
): Promise<CodexThreadUpdate> {
  const response = await getJson<CodexThreadItemsResponse>(
    `/threads/${encodeURIComponent(threadId)}/items?after_ordinal=${afterOrdinal}&detail=full`,
    signal,
    transport,
  );
  return {
    messages: mapItems(response.items),
    latestOrdinal: response.latestOrdinal,
    status: sessionStatus(response.turnStatus),
  };
}
