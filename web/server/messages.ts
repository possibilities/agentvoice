import type { TranscriptMessage } from "@agentchats/transcript";
import { parseCodexMessagePresentation } from "@agentchats/transcript/codex";
import type { z } from "zod";
import type { conversationItemSchema } from "../../src/events/conversation.ts";
import { recordedVoiceFrame } from "../../src/recording/writer.ts";

export type AgentItem = { turnId: string; item: z.infer<typeof conversationItemSchema> };
export const itemKey = ({ turnId, item }: AgentItem) => JSON.stringify([turnId, item.id]);

export function agentMessage(entry: AgentItem, completed = true): TranscriptMessage | undefined {
  const { item } = entry;
  const base = { id: itemKey(entry), status: completed ? "complete" : "streaming" } as const;
  if (item.type === "userMessage") {
    const content = item.content
      .map((part) => {
        if (part.type === "text") return part.text;
        if (part.type === "skill" || part.type === "mention") return `@${part.name}`;
        return `[${part.type === "image" || part.type === "localImage" ? "Image" : "Audio"}]`;
      })
      .join("\n\n");
    return { ...base, role: "user", content, presentation: parseCodexMessagePresentation(content) };
  }
  if (item.type === "agentMessage") return { ...base, role: "assistant", content: item.text };
  if (item.type === "reasoning") return;
  if (item.type === "plan") return { ...base, role: "assistant", content: item.text };
  const row = item as Record<string, unknown>;
  const failed =
    ["failed", "declined", "interrupted"].includes(String(row["status"])) ||
    item.type === "unavailable";
  const running = row["status"] === "inProgress" || !completed;
  const state = failed ? "error" : running ? "running" : "complete";
  const message: TranscriptMessage = {
    ...base,
    role: "tool",
    content: "",
    status: failed ? "error" : running ? "working" : "complete",
    toolActivity: {
      name: item.type,
      detail: item.type === "unavailable" ? `Content unavailable (${item.reason})` : item.type,
      state,
      sections: [{ label: "Details", content: JSON.stringify(item, null, 2) }],
    },
  };
  if (item.type === "commandExecution") {
    message.toolActivity = {
      name: "Command",
      detail: item.command,
      state,
      ...(item.exitCode == null ? {} : { meta: `exit ${item.exitCode}` }),
      sections: [{ label: "Output", content: item.aggregatedOutput ?? "" }],
    };
  } else if (item.type === "fileChange") {
    message.fileChanges = item.changes.map((change) => ({
      path: change.path,
      kind: change.kind.type,
      diff: change.diff,
      diffTruncated: false,
      ...(change.kind.type === "update" && change.kind.move_path
        ? { movePath: change.kind.move_path }
        : {}),
    }));
  } else if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    message.toolActivity!.name = item.tool;
    message.toolActivity!.detail = item.tool;
  }
  return message;
}

/** Saved canonical completions replace drafts; generation and realtime session fence item IDs. */
export class VoiceMessages {
  private readonly rows = new Map<string, TranscriptMessage>();
  private readonly active = new Map<string, string>();
  notice?: string;
  accept(line: string, threadId: string) {
    const { observedAt, ...record } = JSON.parse(line);
    if (record.type === "recording.gap" || record.type === "recording.ended") {
      for (const [key, message] of this.rows)
        if (message.status === "streaming") {
          this.rows.set(key, { ...message, status: "error" });
          this.notice = "Some voice text is incomplete.";
        }
      if (record.type === "recording.gap") this.notice = "Some voice text is incomplete.";
      this.active.clear();
      return;
    }
    if (record.type !== "event") return;
    const { event, data } = recordedVoiceFrame.parse(record);
    if (data.threadId !== threadId) throw new Error("Voice transcript identity changed");
    const scope = [data.instanceId, data.generation];
    if ("itemId" in data) {
      const key = this.active.get(JSON.stringify([...scope, data.itemId]));
      const previous = key ? this.rows.get(key) : undefined;
      if (key && previous?.status === "streaming") {
        if (previous.content.length + data.delta.length > 128 * 1024) {
          this.rows.set(key, { ...previous, status: "error" });
          this.notice = "Some voice text exceeds the viewer limit.";
        } else this.rows.set(key, { ...previous, content: previous.content + data.delta });
      }
      return;
    }
    if (data.item.type !== "transcriptSegment") return;
    const item = data.item;
    const key = JSON.stringify([...scope, item.realtimeSessionId, item.id]);
    this.active.set(JSON.stringify([...scope, item.id]), key);
    const previous = this.rows.get(key);
    const createdAt =
      previous?.createdAt ??
      (typeof observedAt === "string" && Number.isFinite(Date.parse(observedAt))
        ? observedAt
        : undefined);
    this.rows.set(key, {
      id: key,
      role: item.role,
      content: item.text,
      status: event === "voice.item.completed" ? "complete" : "streaming",
      ...(createdAt ? { createdAt } : {}),
    });
  }
  messages() {
    return [...this.rows.values()];
  }
}
