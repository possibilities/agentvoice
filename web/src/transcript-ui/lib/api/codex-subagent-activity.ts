import type { ToolActivity, ToolDetailSection } from "@/types/message";

type JsonObject = Record<string, unknown>;

export interface CodexSubagentActivityPresentation {
  content: string;
  activity: ToolActivity;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function titleCase(value: string) {
  return value ? value[0]!.toUpperCase() + value.slice(1) : "Activity";
}

function section(label: string, content: string): ToolDetailSection[] {
  return content ? [{ label, content }] : [];
}

function originalRecord(value: JsonObject): ToolDetailSection[] {
  try {
    return [{ label: "Original record", content: JSON.stringify(value, null, 2) }];
  } catch {
    return [];
  }
}

/**
 * Turn Codex's path-based subagent lifecycle record into a readable tool row.
 * The record remains one transcript message so separate lifecycle events keep
 * separate disclosure controls and stable source IDs.
 */
export function mapCodexSubagentActivity(value: unknown): CodexSubagentActivityPresentation | null {
  if (!isObject(value)) return null;
  const path = text(value.agentPath);
  const thread = text(value.agentThreadId);
  const id = text(value.id);
  const kind = text(value.kind);
  if (!path && !thread && !id && !kind) return null;

  const action = titleCase(kind);
  const detail = path || thread || "Subagent";
  return {
    content: `${action} ${detail}`,
    activity: {
      name: "Subagent",
      detail,
      meta: action,
      state: "complete",
      sections: [
        ...section("Activity", action),
        ...section("Agent path", path),
        ...section("Agent thread", thread),
        ...section("Activity ID", id),
        ...originalRecord(value),
      ],
    },
  };
}
