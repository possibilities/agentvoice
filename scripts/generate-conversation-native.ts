/** Project the stock schema into the UI-visible native types. No child, turns, or media. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const notificationTypes = {
  "item/started": "ItemStartedNotification",
  "item/completed": "ItemCompletedNotification",
  "item/agentMessage/delta": "AgentMessageDeltaNotification",
  "item/plan/delta": "PlanDeltaNotification",
  "item/commandExecution/outputDelta": "CommandExecutionOutputDeltaNotification",
  "item/fileChange/outputDelta": "FileChangeOutputDeltaNotification",
  "item/reasoning/textDelta": "ReasoningTextDeltaNotification",
  "item/reasoning/summaryTextDelta": "ReasoningSummaryTextDeltaNotification",
  "item/reasoning/summaryPartAdded": "ReasoningSummaryPartAddedNotification",
  "item/commandExecution/terminalInteraction": "TerminalInteractionNotification",
  "item/mcpToolCall/progress": "McpToolCallProgressNotification",
  "turn/started": "TurnStartedNotification",
  "turn/completed": "TurnCompletedNotification",
  "turn/diff/updated": "TurnDiffUpdatedNotification",
  "turn/plan/updated": "TurnPlanUpdatedNotification",
  "thread/tokenUsage/updated": "ThreadTokenUsageUpdatedNotification",
  "thread/settings/updated": "ThreadSettingsUpdatedNotification",
  "thread/reverted": "ThreadRevertedNotification",
  error: "ErrorNotification",
  "hook/started": "HookStartedNotification",
  "hook/completed": "HookCompletedNotification",
} as const;

// biome-ignore lint/suspicious/noExplicitAny: This compiler traverses heterogeneous JSON Schema keywords.
type Node = { [key: string]: any };
export function generateNative(schemaDirectory: string): string {
  const definitions: Record<string, Node> = {};
  for (const name of Object.values(notificationTypes)) {
    const schema = JSON.parse(readFileSync(join(schemaDirectory, "v2", `${name}.json`), "utf8"));
    Object.assign(definitions, schema.definitions);
    definitions[name] = schema;
  }
  // Turn items have their own paginated reads and lifecycle events. Do not duplicate unbounded
  // item arrays in turn notifications. Generated image bytes stay in the native file store.
  delete definitions["Turn"]!.properties.items;
  delete definitions["Turn"]!.properties.itemsView;
  for (const item of definitions["ThreadItem"]!.oneOf)
    if (item.properties.type.enum[0] === "imageGeneration") delete item.properties.result;
  const emitted = new Set<string>();
  const lines = [
    "// Generated from stock Codex 0.153.4 by scripts/generate-conversation-native.ts.",
    "// Objects project known fields. Opaque tool JSON is bounded and scrubbed before publication.",
    'import { z } from "zod";',
  ];
  function named(name: string): string {
    if (!emitted.has(name)) {
      emitted.add(name);
      const expression = node(definitions[name]!);
      lines.push(`export const ${name}Schema = ${expression};`);
    }
    return `${name}Schema`;
  }
  function node(value: Node | boolean): string {
    if (value === true) return "z.json()";
    if (value === false) return "z.never()";
    if (value["$ref"]) return named(value["$ref"].split("/").at(-1));
    if (value["enum"]) {
      const members = value["enum"].map((entry: unknown) => `z.literal(${JSON.stringify(entry)})`);
      return members.length === 1 ? members[0] : `z.union([${members.join(",")}])`;
    }
    const union = value["oneOf"] ?? value["anyOf"];
    if (union) return `z.union([${union.map(node).join(",")}])`;
    if (value["allOf"]) {
      if (value["allOf"].length !== 1) throw new Error("unsupported intersection");
      return node(value["allOf"][0]);
    }
    const type = value["type"];
    if (Array.isArray(type))
      return `z.union([${type.map((type) => node({ ...value, type })).join(",")}])`;
    if (type === "null") return "z.null()";
    if (type === "string") return "z.string().max(262144)";
    if (type === "boolean") return "z.boolean()";
    if (type === "integer") return "z.number().int().safe()";
    if (type === "number") return "z.number().finite()";
    if (type === "array") return `z.array(${node(value["items"] ?? true)}).max(1024)`;
    if (type === "object") {
      if (!value["properties"])
        return `z.record(z.string(),${node(value["additionalProperties"] ?? true)})`;
      const entries = Object.entries(value["properties"]).map(
        ([key, child]) =>
          `${JSON.stringify(key)}:${node(child as Node)}${value["required"]?.includes(key) ? "" : ".optional()"}`,
      );
      return `z.object({${entries.join(",")}})`;
    }
    throw new Error(`unsupported schema: ${JSON.stringify(value)}`);
  }
  for (const name of Object.values(notificationTypes)) named(name);
  lines.push(
    `export const nativeConversationSchemas = {${Object.entries(notificationTypes)
      .map(([method, name]) => `${JSON.stringify(method)}:${name}Schema`)
      .join(",")}};`,
  );
  return `${lines.join("\n\n")}\n`;
}
if (import.meta.main) {
  if (!process.argv[2])
    throw new Error("Pass the directory from codex app-server generate-json-schema --experimental");
  await Bun.write(
    new URL("../src/events/conversation-native.ts", import.meta.url),
    generateNative(process.argv[2]),
  );
}
