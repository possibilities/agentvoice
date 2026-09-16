import type { Message } from "../../types/message.ts";

const titles: Readonly<Record<string, string>> = {
  started: "Subagent started",
  completed: "Subagent turn completed",
  interrupted: "Subagent interruption requested",
};

/** Lifecycle observations carry no model, effort, result, or semantic Work association. */
export function mapCodexSubagentEvent(value: unknown): Omit<Message, "id"> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const kind = item["kind"];
  const path = item["agentPath"];
  const thread = item["agentThreadId"];
  const id = item["id"];
  if (
    typeof kind !== "string" ||
    !Object.hasOwn(titles, kind) ||
    typeof path !== "string" ||
    !path.trim() ||
    typeof thread !== "string" ||
    !thread.trim() ||
    typeof id !== "string" ||
    !id.trim()
  )
    return null;
  const title = titles[kind]!;
  return {
    role: "system",
    status: "complete",
    nativeItemType: "subAgentActivity",
    content: `${title}: ${path}`,
    presentation: {
      title,
      body: path,
      details: [
        { label: "Agent path", content: path },
        { label: "Agent thread", content: thread },
        { label: "Activity", content: kind },
        { label: "Activity ID", content: id },
      ],
    },
  };
}
