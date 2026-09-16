import { z } from "zod";
import type { ConversationNotification } from "./conversation.ts";
import type { VoiceNotification } from "./voice.ts";

export const EVENT_PROTOCOL_VERSION = 2;
export const MAX_THREADS = 256;
const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/u);
export const threadViewSchema = z
  .object({
    id,
    parentThreadId: id.nullable(),
    name: z.string().max(256).nullable(),
    status: z.enum(["unknown", "notLoaded", "idle", "active", "systemError"]),
    activeFlags: z.array(z.enum(["waitingOnApproval", "waitingOnUserInput"])).max(2),
    turn: z
      .object({ id, status: z.enum(["inProgress", "completed", "interrupted", "failed"]) })
      .strict()
      .nullable(),
  })
  .strict();
export type ThreadView = z.infer<typeof threadViewSchema>;
export const threadInventorySchema = z
  .object({
    threads: z.array(threadViewSchema).max(MAX_THREADS),
    complete: z.boolean(),
  })
  .strict();
export type ThreadInventory = z.infer<typeof threadInventorySchema>;
export type RuntimeView = {
  phase: string;
  workspace: string;
  mainThreadId: string;
};
export type EventContext = { instanceId: string; generation: number; sequence: number };
export type ThreadSnapshot = EventContext & {
  runtime: RuntimeView;
  inventory: "pending" | "ready" | "incomplete" | "unavailable";
  threads: ThreadView[];
};
export type LifecycleEvent = {
  v: typeof EVENT_PROTOCOL_VERSION;
  type: "event";
  event: "threads.changed" | "thread.state.changed" | "runtime.state.changed";
  data: EventContext & Record<string, unknown>;
};
export type VoiceEvent = VoiceNotification & {
  v: typeof EVENT_PROTOCOL_VERSION;
  type: "event";
  data: EventContext;
};
export type ConversationEvent = {
  v: typeof EVENT_PROTOCOL_VERSION;
  type: "event";
  event: string;
  data: ConversationNotification["data"] & EventContext & { revision: number };
};
export type ControllerEvent = LifecycleEvent | VoiceEvent | ConversationEvent;

export const emptyEventParams = z.object({}).strict();
export const eventSubscriptionSchema = z
  .object({
    events: z
      .array(
        z
          .string()
          .max(128)
          .regex(/^(?:\*|[a-z][a-z0-9._:/-]*\*?)$/u),
      )
      .min(1)
      .max(32)
      .default(["*"]),
  })
  .strict();
