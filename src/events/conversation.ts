import { z } from "zod";
import { nativeConversationSchemas, ThreadItemSchema, TurnSchema } from "./conversation-native.ts";

export const MAX_CONVERSATION_BYTES = 64 * 1024;
export const MAX_HISTORY_BYTES = 512 * 1024;
export const conversationId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/u);
export const eventName = (method: string) =>
  `conversation.${method.replaceAll("/", ".").replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)}`;
export const unsupportedItemSchema = z
  .object({
    type: z.literal("unavailable"),
    id: conversationId,
    nativeType: z.string().max(256),
    reason: z.enum(["unsupported", "oversized", "media"]),
  })
  .strict();
export const conversationItemSchema = z.union([ThreadItemSchema, unsupportedItemSchema]);
export const conversationTurnSchema = TurnSchema;
export const gapDataSchema = z
  .object({
    threadId: conversationId.nullable(),
    reason: z.enum(["unsupported", "oversized", "backpressure", "source_gap"]),
    nativeMethod: z.string().max(128).optional(),
  })
  .strict();

// Item projection is shared by native events and history, including explicit unavailable items.
export const conversationEventSchemas = Object.fromEntries(
  Object.entries(nativeConversationSchemas).map(([method, schema]) => {
    const projected =
      "item" in schema.shape ? schema.extend({ item: conversationItemSchema }) : schema;
    return [eventName(method), projected];
  }),
) as Record<string, z.ZodObject>;
conversationEventSchemas["conversation.gap"] = gapDataSchema;
export type ConversationNotification = {
  event: string;
  data: Record<string, unknown>;
  revision: number;
};

export function safeContent(value: unknown, secrets: readonly string[] = []): unknown {
  let nodes = 0;
  function visit(value: unknown, depth: number): unknown {
    if (++nodes > 8192 || depth > 32) throw new Error("oversized");
    if (typeof value === "string") {
      if (/data:[^,;]*(?:audio|image|octet-stream)[^,]*[,;]/iu.test(value))
        throw new Error("media");
      for (const secret of secrets)
        if (secret) value = (value as string).replaceAll(secret, "[redacted]");
      return value;
    }
    if (Array.isArray(value)) return value.map((child) => visit(child, depth + 1));
    if (value && typeof value === "object") {
      const row = value as Record<string, unknown>;
      if (["audio", "localAudio", "input_audio"].includes(String(row["type"])))
        throw new Error("media");
      if (row["type"] === "encrypted_content") throw new Error("unsupported");
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(row)) {
        if (row["type"] === "imageGeneration" && key === "result") continue;
        // MCP binary content blocks are represented by an explicit unavailable item.
        if ((row["type"] === "image" && key === "data") || key === "blob") throw new Error("media");
        let name = key;
        for (const secret of secrets) if (secret) name = name.replaceAll(secret, "[redacted]");
        if (Object.hasOwn(result, name)) throw new Error("unsupported");
        Object.defineProperty(result, name, { value: visit(child, depth + 1), enumerable: true });
      }
      return result;
    }
    return value;
  }
  return visit(value, 0);
}

export function projectItem(
  value: unknown,
  secrets: readonly string[] = [],
): z.infer<typeof conversationItemSchema> {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const id = conversationId.parse(row["id"]);
  let reason: "unsupported" | "oversized" | "media" = "unsupported";
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_CONVERSATION_BYTES) reason = "oversized";
    else {
      const parsed = ThreadItemSchema.safeParse(safeContent(value, secrets));
      if (parsed.success) {
        if (Buffer.byteLength(JSON.stringify(parsed.data)) <= MAX_CONVERSATION_BYTES)
          return parsed.data;
        reason = "oversized";
      }
    }
  } catch (error) {
    if (error instanceof Error && (error.message === "media" || error.message === "oversized"))
      reason = error.message;
  }
  return {
    type: "unavailable",
    id,
    nativeType: typeof row["type"] === "string" ? row["type"].slice(0, 256) : "unknown",
    reason,
  };
}

export function projectNotification(
  method: string,
  params: Record<string, unknown>,
  revision: number,
  secrets: readonly string[] = [],
): ConversationNotification | undefined {
  if (!Object.hasOwn(nativeConversationSchemas, method)) return;
  const event = eventName(method);
  try {
    let data = params;
    if ("item" in params) data = { ...params, item: projectItem(params["item"], secrets) };
    if ("turn" in params) data = { ...data, turn: TurnSchema.parse(params["turn"]) };
    const parsed = conversationEventSchemas[event]!.parse(safeContent(data, secrets));
    if (Buffer.byteLength(JSON.stringify(parsed)) > MAX_CONVERSATION_BYTES)
      throw new Error("oversized");
    return { event, data: parsed, revision };
  } catch (error) {
    return {
      event: "conversation.gap",
      revision,
      data: {
        threadId: conversationId.safeParse(params["threadId"]).success ? params["threadId"] : null,
        reason:
          error instanceof Error && error.message === "oversized" ? "oversized" : "unsupported",
        nativeMethod: method,
      },
    };
  }
}

export function conversationNotification(value: unknown): ConversationNotification | undefined {
  const frame = z
    .object({
      event: z.string(),
      data: z.record(z.string(), z.unknown()),
      revision: z.number().int().min(1).safe(),
    })
    .strict()
    .safeParse(value);
  if (!frame.success || Buffer.byteLength(JSON.stringify(value)) > MAX_CONVERSATION_BYTES + 1024)
    return;
  const schema = Object.hasOwn(conversationEventSchemas, frame.data.event)
    ? conversationEventSchemas[frame.data.event]
    : undefined;
  const data = schema?.safeParse(frame.data.data);
  if (data?.success) return { ...frame.data, data: data.data };
}

export const observationIdentity = {
  expectedInstanceId: z.string().min(1).max(256),
  expectedGeneration: z.number().int().positive().safe(),
};
const root = { ...observationIdentity, rootThreadId: conversationId };
const thread = { ...root, threadId: conversationId };
const page = {
  cursor: z.string().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(50).default(20),
};
export const conversationRequestSchemas = {
  "conversation.live.get": z.object(thread).strict(),
  "conversation.thread.get": z.object(thread).strict(),
  "conversation.threads.list": z
    .object({ ...root, ...page, archived: z.boolean().default(false) })
    .strict(),
  "conversation.turns.list": z
    .object({ ...thread, ...page, sortDirection: z.enum(["asc", "desc"]).default("desc") })
    .strict(),
  "conversation.items.list": z
    .object({
      ...thread,
      ...page,
      turnId: conversationId.optional(),
      sortDirection: z.enum(["asc", "desc"]).default("asc"),
    })
    .strict(),
};
export type ConversationReadMethod = keyof typeof conversationRequestSchemas;
export type ConversationReadParams = z.infer<
  (typeof conversationRequestSchemas)[ConversationReadMethod]
>;
export const replayRequestSchema = z
  .object({
    ...observationIdentity,
    afterSequence: z.number().int().min(0).safe(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export const conversationCapabilities = {
  nativeSchemaVersion: "0.153.4",
  methods: [
    ...Object.keys(conversationRequestSchemas),
    "conversation.replay",
    "conversation.capabilities",
  ],
  events: Object.keys(conversationEventSchemas),
  history: "native-paginated" as const,
  liveCoverage: "owned-child-notifications" as const,
  replayMaxEvents: 512,
  replayMaxBytes: 8 * 1024 * 1024,
  maxEventBytes: MAX_CONVERSATION_BYTES,
  maxHistoryBytes: MAX_HISTORY_BYTES,
  maxPageSize: 50,
  maxConcurrentReads: 4,
  cursorTtlMs: 5 * 60_000,
};
export const capabilitiesSchema = z
  .object({
    nativeSchemaVersion: z.string(),
    methods: z.array(z.string()),
    events: z.array(z.string()),
    history: z.literal("native-paginated"),
    liveCoverage: z.literal("owned-child-notifications"),
    replayMaxEvents: z.number().int(),
    replayMaxBytes: z.number().int(),
    maxEventBytes: z.number().int(),
    maxHistoryBytes: z.number().int(),
    maxPageSize: z.number().int(),
    maxConcurrentReads: z.number().int(),
    cursorTtlMs: z.number().int(),
  })
  .strict();
export const threadDetailsSchema = z.object({
  id: conversationId,
  parentThreadId: conversationId.nullable().optional(),
  name: z.string().max(256).nullable().optional(),
  agentNickname: z.string().max(256).nullable().optional(),
  agentRole: z.string().max(256).nullable().optional(),
  cwd: z.string().max(4096),
  status: z.object({
    type: z.enum(["notLoaded", "idle", "active", "systemError"]),
    activeFlags: z.array(z.enum(["waitingOnApproval", "waitingOnUserInput"])).optional(),
  }),
  createdAt: z.number().int().safe().optional(),
  updatedAt: z.number().int().safe().optional(),
  model: z.string().max(256).nullable().optional(),
  modelProvider: z.string().max(256).optional(),
  reasoningEffort: z.string().max(256).nullable().optional(),
  ephemeral: z.boolean().optional(),
  canAcceptDirectInput: z.boolean().nullable().optional(),
});
const readResultBase = {
  rootThreadId: conversationId,
  revisionBefore: z.number().int().min(0).safe(),
  revisionAfter: z.number().int().min(0).safe(),
  changedDuringRead: z.boolean(),
  nextCursor: z.string().max(256).nullable(),
};
export const readResultSchema = z.discriminatedUnion("method", [
  z
    .object({
      ...readResultBase,
      method: z.literal("conversation.thread.get"),
      threadId: conversationId,
      data: threadDetailsSchema,
      nextCursor: z.null(),
    })
    .strict(),
  z
    .object({
      ...readResultBase,
      method: z.literal("conversation.live.get"),
      threadId: conversationId,
      data: threadDetailsSchema,
      nextCursor: z.null(),
    })
    .strict(),
  z
    .object({
      ...readResultBase,
      method: z.literal("conversation.threads.list"),
      data: z.array(threadDetailsSchema).max(50),
    })
    .strict(),
  z
    .object({
      ...readResultBase,
      method: z.literal("conversation.turns.list"),
      threadId: conversationId,
      data: z.array(conversationTurnSchema).max(50),
    })
    .strict(),
  z
    .object({
      ...readResultBase,
      method: z.literal("conversation.items.list"),
      threadId: conversationId,
      data: z
        .array(z.object({ turnId: conversationId, item: conversationItemSchema }).strict())
        .max(50),
    })
    .strict(),
]);
export type ConversationReadResult = z.infer<typeof readResultSchema>;
export const observationErrorCode = z.enum([
  "invalid_params",
  "unavailable",
  "stale_generation",
  "instance_mismatch",
  "forbidden_thread",
  "unsupported",
  "history_unavailable",
  "busy",
  "oversized",
  "cursor_expired",
  "resync_required",
  "internal_error",
]);
export class ObservationError extends Error {
  constructor(readonly code: z.infer<typeof observationErrorCode>) {
    super(code);
  }
}
