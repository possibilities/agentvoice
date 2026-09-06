import { z } from "zod";
import {
  EVENT_PROTOCOL_VERSION,
  emptyEventParams,
  eventSubscriptionSchema,
  MAX_THREADS,
  threadViewSchema,
} from "./contract.ts";
import {
  capabilitiesSchema,
  conversationEventSchemas,
  conversationRequestSchemas,
  observationErrorCode,
  readResultSchema,
  replayRequestSchema,
} from "./conversation.ts";
import { liveSnapshotSchema } from "./conversation-projection.ts";
import { voiceNotificationSchema } from "./voice.ts";

const context = {
  instanceId: z.string().min(1).describe("Producer lifetime ID; changes on full restart."),
  generation: z.number().int().min(1).describe("Runtime generation within that lifetime."),
  sequence: z
    .number()
    .int()
    .min(0)
    .describe("Monotonic publication sequence, not a replay cursor."),
};
const runtime = z
  .object({ phase: z.string(), workspace: z.string(), mainThreadId: z.string() })
  .strict();
const inventory = z.enum(["pending", "ready", "incomplete", "unavailable"]);
const threads = z.array(threadViewSchema).max(MAX_THREADS);
export const eventSnapshotSchema = z
  .object({ ...context, runtime, inventory, threads })
  .strict()
  .describe("Lifecycle state only. Its watermark never supersedes transient voice events.");
const envelope = { v: z.literal(EVENT_PROTOCOL_VERSION), type: z.literal("event") };
function event<T extends string, S extends z.ZodRawShape>(name: T, shape: S, description: string) {
  return z
    .object({
      ...envelope,
      event: z.literal(name),
      data: z.object({ ...context, ...shape }).strict(),
    })
    .strict()
    .describe(description)
    .meta({ id: name });
}
export const conversationFrameSchemas = Object.entries(conversationEventSchemas).map(
  ([name, schema]) =>
    event(
      name,
      { ...schema.shape, revision: z.number().int().positive().safe() },
      "Conversation: typed native content or explicit gap. Bounded controller replay; native history is a separate read, never an atomic event watermark.",
    ),
);
export const eventFrameSchema = z
  .union([
    event("threads.changed", { inventory, threads }, "Current state: replace thread inventory."),
    event(
      "thread.state.changed",
      { thread: threadViewSchema },
      "Current state: replace one thread row.",
    ),
    event(
      "runtime.state.changed",
      { runtime, inventory, threads },
      "Current state: replace runtime and inventory; generation reset boundary.",
    ),
    ...voiceNotificationSchema.options.map((schema) =>
      event(
        schema.shape.event.value,
        schema.shape.data.shape,
        "Transient: live native voice item data. No persistence, replay, or snapshot recovery. Do not discard using a lifecycle snapshot watermark.",
      ),
    ),
    ...conversationFrameSchemas,
  ])
  .meta({ id: "events" });

const requestBase = {
  v: z.literal(EVENT_PROTOCOL_VERSION),
  type: z.literal("request"),
  id: z.string().min(1).max(128),
};
const requests = z
  .union([
    z
      .object({
        ...requestBase,
        method: z.literal("event.subscribe"),
        params: eventSubscriptionSchema.nullish(),
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("state.get"),
        params: emptyEventParams.nullish(),
      })
      .strict(),
    ...Object.entries(conversationRequestSchemas).map(([method, params]) =>
      z.object({ ...requestBase, method: z.literal(method), params }).strict(),
    ),
    z
      .object({
        ...requestBase,
        method: z.literal("conversation.replay"),
        params: replayRequestSchema,
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("conversation.capabilities"),
        params: emptyEventParams.nullish(),
      })
      .strict(),
  ])
  .meta({ id: "requests" });
const responseBase = {
  v: z.literal(EVENT_PROTOCOL_VERSION),
  type: z.literal("response"),
  id: z.string().min(1).max(128),
};
const responses = z
  .union([
    z
      .object({
        ...responseBase,
        ok: z.literal(true),
        result: liveSnapshotSchema.extend({
          instanceId: context.instanceId,
          generation: context.generation,
        }),
      })
      .strict(),
    z
      .object({
        ...responseBase,
        ok: z.literal(true),
        result: z
          .object({
            subscribed: z.literal(true),
            events: eventSubscriptionSchema.shape.events.removeDefault(),
          })
          .strict(),
      })
      .strict(),
    z.object({ ...responseBase, ok: z.literal(true), result: eventSnapshotSchema }).strict(),
    z.object({ ...responseBase, ok: z.literal(true), result: capabilitiesSchema }).strict(),
    z
      .object({
        ...responseBase,
        ok: z.literal(true),
        result: z.union(
          readResultSchema.options.map((schema) =>
            schema.extend({
              instanceId: context.instanceId,
              generation: context.generation,
            }),
          ),
        ),
      })
      .strict(),
    z
      .object({
        ...responseBase,
        ok: z.literal(true),
        result: z
          .object({
            instanceId: context.instanceId,
            generation: context.generation,
            events: z.array(z.union(conversationFrameSchemas)).max(100),
            throughSequence: context.sequence,
            hasMore: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...responseBase,
        id: z.string().max(128).nullable(),
        ok: z.literal(false),
        error: z
          .object({
            code: z.union([z.enum(["invalid_request", "unknown_method"]), observationErrorCode]),
            message: z.string(),
          })
          .strict(),
      })
      .strict(),
  ])
  .meta({ id: "responses" });

/** One published schema for each feed; domain payloads vary, wire conventions do not. */
export const eventSocketFrameSchema = z.union([requests, responses, eventFrameSchema]);
