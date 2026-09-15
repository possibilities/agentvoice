import { z } from "zod";
import { nativeConversationSchemas, ThreadItemSchema, TurnSchema } from "./conversation-native.ts";

export const MAX_CONVERSATION_BYTES = 64 * 1024;
export const MAX_HISTORY_BYTES = 512 * 1024;
// Leave room for the event envelope while retaining a useful bounded item summary.
export const MAX_PROJECTED_ITEM_BYTES = 48 * 1024;
const MAX_PROJECTED_EXCERPT_BYTES = 24 * 1024;
export const conversationId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/u);
export const eventName = (method: string) =>
  `conversation.${method.replaceAll("/", ".").replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)}`;
const projectedFailureSchema = z
  .object({
    type: z.string().max(128),
    message: z.string().max(8192),
    details: z.string().max(8192).optional(),
  })
  .strict();
const contentOmissionSchema = z
  .object({
    originalBytes: z.number().int().min(0).safe(),
    limitBytes: z.number().int().positive().safe(),
    name: z.string().max(256).optional(),
    detail: z.string().max(2048).optional(),
    status: z.string().max(64).optional(),
    exitCode: z.number().int().safe().nullable().optional(),
    failure: projectedFailureSchema.optional(),
    excerpt: z
      .object({ label: z.string().max(64), content: z.string().max(MAX_PROJECTED_EXCERPT_BYTES) })
      .strict()
      .optional(),
  })
  .strict();
export const unsupportedItemSchema = z
  .object({
    type: z.literal("unavailable"),
    id: conversationId,
    nativeType: z.string().max(256),
    reason: z.enum(["unsupported", "oversized", "media"]),
    omission: contentOmissionSchema.optional(),
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

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function truncateUtf8(value: string, maximum: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximum) return value;
  const marker = Buffer.from("\n… excerpt truncated …\n");
  const available = Math.max(0, maximum - marker.length);
  const decode = (slice: Uint8Array, fromStart: boolean) => {
    for (let trim = 0; trim < 4 && trim <= slice.length; trim++) {
      const candidate = fromStart ? slice.subarray(0, slice.length - trim) : slice.subarray(trim);
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(candidate);
      } catch {
        /* A UTF-8 code point spans the byte boundary; remove at most three bytes. */
      }
    }
    return "";
  };
  const headBytes = Math.floor(available / 2);
  const tailBytes = available - headBytes;
  return `${decode(bytes.subarray(0, headBytes), true)}${marker.toString()}${decode(
    bytes.subarray(bytes.length - tailBytes),
    false,
  )}`;
}

function safeText(value: unknown, maximum: number, secrets: readonly string[]) {
  if (typeof value !== "string") return;
  try {
    const safe = safeContent(value, secrets);
    if (typeof safe === "string") return truncateUtf8(safe, maximum);
  } catch {
    return;
  }
}

function safeExcerpt(value: unknown, secrets: readonly string[]) {
  if (value == null) return;
  try {
    const safe = safeContent(value, secrets);
    const text = typeof safe === "string" ? safe : JSON.stringify(safe, null, 2);
    if (text) return truncateUtf8(text, MAX_PROJECTED_EXCERPT_BYTES);
  } catch {
    return;
  }
}

function projectedFailure(
  row: Record<string, unknown>,
  nativeType: string,
  secrets: readonly string[],
) {
  const status = typeof row["status"] === "string" ? row["status"] : undefined;
  const failed = ["failed", "declined", "interrupted", "errored"].includes(status ?? "");
  const error = record(row["error"]);
  const agentFailures =
    nativeType === "collabAgentToolCall"
      ? Object.entries(record(row["agentsStates"]))
          .map(([agentId, value]): Record<string, unknown> & { agentId: string } => ({
            agentId,
            ...record(value),
          }))
          .filter((agent) =>
            ["errored", "interrupted", "notFound"].includes(String(agent["status"])),
          )
      : [];
  const agentMessage = agentFailures
    .map((agent) => safeText(agent["message"], 8192, secrets))
    .find((message): message is string => Boolean(message));
  const type =
    safeText(error["type"] ?? error["name"] ?? error["code"], 128, secrets) ??
    (failed
      ? nativeType === "mcpToolCall"
        ? "MCP tool failure"
        : nativeType === "commandExecution"
          ? "Command failure"
          : nativeType === "collabAgentToolCall"
            ? "Agent collaboration failure"
            : "Tool failure"
      : undefined);
  const exitCode = typeof row["exitCode"] === "number" ? row["exitCode"] : undefined;
  const message =
    safeText(error["message"], 8192, secrets) ??
    agentMessage ??
    (failed && exitCode != null
      ? `Command exited with code ${exitCode}.`
      : failed
        ? "The tool reported a failed status."
        : undefined);
  if (!type || !message) return;
  const details = safeExcerpt(
    error["details"] ??
      error["data"] ??
      error["cause"] ??
      (agentFailures.length > 0
        ? agentFailures.map(({ agentId, status, message }) => ({ agentId, status, message }))
        : undefined),
    secrets,
  );
  return { type, message, ...(details ? { details: truncateUtf8(details, 8192) } : {}) };
}

function projectUnavailableItem(
  row: Record<string, unknown>,
  reason: "unsupported" | "oversized" | "media",
  originalBytes: number,
  secrets: readonly string[],
): z.infer<typeof unsupportedItemSchema> {
  const nativeType = typeof row["type"] === "string" ? row["type"].slice(0, 256) : "unknown";
  const summarizedTypes = new Set([
    "commandExecution",
    "mcpToolCall",
    "dynamicToolCall",
    "functionCallOutput",
    "collabAgentToolCall",
    "userMessage",
    "agentMessage",
    "plan",
    "fileChange",
    "webSearch",
  ]);
  if (reason === "unsupported" && !summarizedTypes.has(nativeType))
    return { type: "unavailable", id: conversationId.parse(row["id"]), nativeType, reason };
  const status = safeText(row["status"], 64, secrets);
  let name: string | undefined;
  let detail: string | undefined;
  let excerpt: { label: string; content: string } | undefined;
  if (nativeType === "commandExecution") {
    name = "Command";
    detail = safeText(row["command"], 2048, secrets);
    const content = reason === "media" ? undefined : safeExcerpt(row["aggregatedOutput"], secrets);
    if (content) excerpt = { label: "Output excerpt", content };
  } else if (nativeType === "mcpToolCall") {
    name = safeText(row["tool"], 256, secrets) ?? "MCP tool";
    const server = safeText(row["server"], 256, secrets);
    detail = server ? `${server}.${name}` : name;
    const content = reason === "media" ? undefined : safeExcerpt(row["result"], secrets);
    if (content) excerpt = { label: "Result excerpt", content };
  } else if (nativeType === "dynamicToolCall") {
    name = safeText(row["tool"], 256, secrets) ?? "Dynamic tool";
    const namespace = safeText(row["namespace"], 256, secrets);
    detail = namespace ? `${namespace}.${name}` : name;
    const content = reason === "media" ? undefined : safeExcerpt(row["contentItems"], secrets);
    if (content) excerpt = { label: "Result excerpt", content };
  } else if (nativeType === "functionCallOutput") {
    name = safeText(row["name"], 256, secrets) ?? "Tool result";
    const namespace = safeText(row["namespace"], 256, secrets);
    detail = namespace ? `${namespace}.${name}` : name;
    const content = reason === "media" ? undefined : safeExcerpt(row["output"], secrets);
    if (content) excerpt = { label: "Output excerpt", content };
  } else if (nativeType === "collabAgentToolCall") {
    name = safeText(row["tool"], 256, secrets) ?? "Agent collaboration";
    detail = name;
    const content = reason === "media" ? undefined : safeExcerpt(row["agentsStates"], secrets);
    if (content) excerpt = { label: "Agent state excerpt", content };
  } else {
    name = nativeType;
    const source =
      row["text"] ?? row["query"] ?? row["results"] ?? row["changes"] ?? row["content"];
    const content = reason === "media" ? undefined : safeExcerpt(source, secrets);
    if (content) excerpt = { label: "Content excerpt", content };
  }
  const failure = projectedFailure(row, nativeType, secrets);
  const exitCode =
    typeof row["exitCode"] === "number" && Number.isSafeInteger(row["exitCode"])
      ? row["exitCode"]
      : row["exitCode"] === null
        ? null
        : undefined;
  const projected: Record<string, unknown> = {
    type: "unavailable",
    id: conversationId.parse(row["id"]),
    nativeType,
    reason,
    omission: {
      originalBytes,
      limitBytes: MAX_PROJECTED_ITEM_BYTES,
      ...(name ? { name } : {}),
      ...(detail ? { detail } : {}),
      ...(status ? { status } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(failure ? { failure } : {}),
      ...(excerpt ? { excerpt } : {}),
    },
  };
  const omission = projected["omission"] as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(projected)) > MAX_PROJECTED_ITEM_BYTES)
    delete omission["excerpt"];
  if (Buffer.byteLength(JSON.stringify(projected)) > MAX_PROJECTED_ITEM_BYTES) {
    const projectedFailure = record(omission["failure"]);
    delete projectedFailure["details"];
    if (typeof projectedFailure["message"] === "string")
      projectedFailure["message"] = truncateUtf8(projectedFailure["message"], 1024);
  }
  if (Buffer.byteLength(JSON.stringify(projected)) > MAX_PROJECTED_ITEM_BYTES)
    delete omission["detail"];
  return unsupportedItemSchema.parse(projected);
}

export function projectItem(
  value: unknown,
  secrets: readonly string[] = [],
): z.infer<typeof conversationItemSchema> {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  conversationId.parse(row["id"]);
  let reason: "unsupported" | "oversized" | "media" = "unsupported";
  let originalBytes = 0;
  try {
    originalBytes = Buffer.byteLength(JSON.stringify(value));
    const safe = safeContent(value, secrets);
    if (originalBytes > MAX_PROJECTED_ITEM_BYTES) reason = "oversized";
    else {
      const parsed = ThreadItemSchema.safeParse(safe);
      if (parsed.success) {
        if (Buffer.byteLength(JSON.stringify(parsed.data)) <= MAX_PROJECTED_ITEM_BYTES)
          return parsed.data;
        reason = "oversized";
      }
    }
  } catch (error) {
    if (error instanceof Error && (error.message === "media" || error.message === "oversized"))
      reason = error.message;
  }
  return projectUnavailableItem(row, reason, originalBytes, secrets);
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
