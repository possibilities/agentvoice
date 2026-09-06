import { z } from "zod";
import {
  type ConversationNotification,
  conversationEventSchemas,
  conversationId,
  conversationItemSchema,
  conversationTurnSchema,
  MAX_CONVERSATION_BYTES,
  projectItem,
} from "./conversation.ts";

export const liveItemSchema = z
  .object({
    turnId: conversationId,
    item: conversationItemSchema,
    complete: z
      .boolean()
      .describe(
        "A start and every observed delta were applied, or a canonical completion replaced the item.",
      ),
    completed: z.boolean(),
    output: z.string().max(MAX_CONVERSATION_BYTES).optional(),
    progress: z.string().max(MAX_CONVERSATION_BYTES).optional(),
  })
  .strict();
const updateNames = [
  "conversation.turn.diff.updated",
  "conversation.turn.plan.updated",
  "conversation.thread.token_usage.updated",
  "conversation.thread.settings.updated",
  "conversation.error",
];
export const liveUpdateSchema = z.union(
  updateNames.map((event) =>
    z
      .object({
        event: z.literal(event),
        data: conversationEventSchemas[event]!,
        revision: z.number().int().positive().safe(),
      })
      .strict(),
  ),
);
export const liveSnapshotSchema = z
  .object({
    threadId: conversationId,
    items: z.array(liveItemSchema).max(128),
    turns: z.array(conversationTurnSchema).max(128),
    updates: z.array(liveUpdateSchema).max(5),
    coverage: z
      .literal("partial")
      .describe("Bounded observation since runtime startup; never a complete native transcript."),
    throughSequence: z.number().int().min(0).safe(),
    revision: z.number().int().min(0).safe(),
  })
  .strict();
type Item = z.infer<typeof liveItemSchema>;
type Turn = z.infer<typeof conversationTurnSchema>;
type Row = {
  items: Map<string, Item>;
  turns: Map<string, Turn>;
  updates: Map<string, ConversationNotification>;
  bytes: number;
};
const object = (value: unknown) => value as Record<string, unknown>;

/** An exact cut of received events, independent of native history read timing. */
export class ConversationProjection {
  private readonly rows = new Map<string, Row>();
  private bytes = 0;
  reset() {
    this.rows.clear();
    this.bytes = 0;
  }
  apply(notification: ConversationNotification) {
    const { event, data } = notification;
    if (event === "conversation.gap") {
      for (const [id, row] of this.rows)
        if (!data["threadId"] || id === data["threadId"])
          for (const item of row.items.values()) if (!item.completed) item.complete = false;
      return;
    }
    const threadId = data["threadId"];
    if (typeof threadId !== "string") return;
    if (event === "conversation.thread.reverted") {
      const previous = this.rows.get(threadId);
      if (previous) this.bytes -= previous.bytes;
      this.rows.delete(threadId);
      return;
    }
    let row = this.rows.get(threadId);
    if (!row) {
      row = { items: new Map(), turns: new Map(), updates: new Map(), bytes: 0 };
      this.rows.set(threadId, row);
    }
    if (updateNames.includes(event)) row.updates.set(event, notification);
    const before = row.bytes;
    const turnId = data["turnId"];
    if (
      (event === "conversation.turn.started" || event === "conversation.turn.completed") &&
      data["turn"]
    ) {
      const turn = conversationTurnSchema.parse(data["turn"]);
      row.turns.delete(turn.id);
      row.turns.set(turn.id, turn);
    } else if (
      (event === "conversation.item.started" || event === "conversation.item.completed") &&
      typeof turnId === "string"
    ) {
      const item = conversationItemSchema.parse(data["item"]);
      const key = JSON.stringify([turnId, item.id]);
      row.items.delete(key);
      row.items.set(key, {
        turnId,
        item,
        completed: event.endsWith(".completed"),
        complete: item.type !== "unavailable",
      });
    } else if (typeof turnId === "string" && typeof data["itemId"] === "string") {
      const entry = row.items.get(JSON.stringify([turnId, data["itemId"]]));
      if (entry && !entry.completed) {
        const item = object(entry.item);
        const append = (key: string) => {
          item[key] = String(item[key] ?? "") + data["delta"];
        };
        if (event === "conversation.item.agent_message.delta" && item["type"] === "agentMessage")
          append("text");
        else if (event === "conversation.item.plan.delta" && item["type"] === "plan")
          append("text");
        else if (
          event === "conversation.item.command_execution.output_delta" &&
          item["type"] === "commandExecution"
        )
          append("aggregatedOutput");
        else if (event === "conversation.item.file_change.output_delta") {
          const output = (entry.output ?? "") + data["delta"];
          if (Buffer.byteLength(output) <= MAX_CONVERSATION_BYTES) entry.output = output;
          else {
            entry.complete = false;
            delete entry.output;
          }
        } else if (event === "conversation.item.mcp_tool_call.progress")
          entry.progress = String(data["message"]);
        else if (
          (event === "conversation.item.reasoning.text_delta" ||
            event === "conversation.item.reasoning.summary_text_delta" ||
            event === "conversation.item.reasoning.summary_part_added") &&
          item["type"] === "reasoning"
        ) {
          const summary = event !== "conversation.item.reasoning.text_delta";
          const index = Number(data[summary ? "summaryIndex" : "contentIndex"]);
          if (Number.isSafeInteger(index) && index >= 0 && index < 1024) {
            const key = summary ? "summary" : "content";
            const parts = (item[key] ?? []) as string[];
            while (parts.length <= index) parts.push("");
            if (typeof data["delta"] === "string") parts[index] += data["delta"];
            item[key] = parts;
          } else entry.complete = false;
        }
        if (Buffer.byteLength(JSON.stringify(entry.item)) > MAX_CONVERSATION_BYTES) {
          entry.item = projectItem(entry.item);
          entry.complete = false;
        }
      }
    }
    while (row.items.size > 128) row.items.delete(row.items.keys().next().value!);
    while (row.turns.size > 128) row.turns.delete(row.turns.keys().next().value!);
    const size = () =>
      Buffer.byteLength(
        JSON.stringify({
          items: [...row.items.values()],
          turns: [...row.turns.values()],
          updates: [...row.updates.values()],
        }),
      );
    row.bytes = size();
    while (row.bytes > 384 * 1024 && (row.items.size || row.turns.size || row.updates.size)) {
      if (row.items.size) row.items.delete(row.items.keys().next().value!);
      else if (row.turns.size) row.turns.delete(row.turns.keys().next().value!);
      else row.updates.delete(row.updates.keys().next().value!);
      row.bytes = size();
    }
    this.bytes += row.bytes - before;
    while (this.rows.size > 64 || this.bytes > 8 * 1024 * 1024) {
      const id = this.rows.keys().next().value!;
      this.bytes -= this.rows.get(id)!.bytes;
      this.rows.delete(id);
    }
  }
  snapshot(
    threadId: string,
    throughSequence: number,
    revision: number,
  ): z.infer<typeof liveSnapshotSchema> {
    const row = this.rows.get(threadId);
    return structuredClone({
      threadId,
      throughSequence,
      revision,
      coverage: "partial" as const,
      items: [...(row?.items.values() ?? [])],
      turns: [...(row?.turns.values() ?? [])],
      updates: [...(row?.updates.values() ?? [])],
    });
  }
}
