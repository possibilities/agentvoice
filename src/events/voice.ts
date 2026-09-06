import { z } from "zod";

export const MAX_VOICE_EVENT_BYTES = 64 * 1024;
export const VOICE_NOTIFICATION_EVENTS = {
  "thread/realtime/item/started": "voice.item.started",
  "thread/realtime/item/transcript/delta": "voice.item.transcript.delta",
  "thread/realtime/item/completed": "voice.item.completed",
} as const;

const id = z.string().min(1).max(256);
const identity = { id, realtimeSessionId: id };
const presentation = z.discriminatedUnion("type", [
  z.object({ type: z.literal("wholeItem") }).strict(),
  z.object({ type: z.literal("inlineMarkdown") }).strict(),
  z
    .object({
      type: z.literal("inlineVisualization"),
      index: z.number().int().min(0).max(0xffffffff),
    })
    .strict(),
]);
// Mirrors Codex v2/realtime.rs. Never forward arbitrary native item payloads.
export const voiceItemSchema = z.discriminatedUnion("type", [
  z.object({ ...identity, type: z.literal("realtimeSessionStarted") }).strict(),
  z
    .object({
      ...identity,
      type: z.literal("transcriptSegment"),
      role: z.enum(["user", "assistant"]),
      text: z.string().max(MAX_VOICE_EVENT_BYTES),
    })
    .strict(),
  z
    .object({
      ...identity,
      type: z.literal("bemItemPromoted"),
      turnId: id,
      itemId: id,
      presentation,
    })
    .strict(),
  z
    .object({
      ...identity,
      type: z.literal("realtimeSessionClosed"),
      outcome: z.enum(["ended", "failed"]),
    })
    .strict(),
]);
const itemData = z.object({ threadId: id, item: voiceItemSchema }).strict();
const deltaData = z
  .object({ threadId: id, itemId: id, delta: z.string().max(MAX_VOICE_EVENT_BYTES) })
  .strict();
export const voiceNotificationSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("voice.item.started"), data: itemData }).strict(),
  z.object({ event: z.literal("voice.item.transcript.delta"), data: deltaData }).strict(),
  z.object({ event: z.literal("voice.item.completed"), data: itemData }).strict(),
]);
export type VoiceItem = z.infer<typeof voiceItemSchema>;
export type VoiceNotification = z.infer<typeof voiceNotificationSchema>;

export function voiceNotification(value: unknown): VoiceNotification | undefined {
  const parsed = voiceNotificationSchema.safeParse(value);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > MAX_VOICE_EVENT_BYTES)
    return;
  return parsed.data;
}
export function nativeVoiceNotification(
  method: string,
  params: unknown,
): VoiceNotification | undefined {
  if (!Object.hasOwn(VOICE_NOTIFICATION_EVENTS, method)) return;
  return voiceNotification({
    event: VOICE_NOTIFICATION_EVENTS[method as keyof typeof VOICE_NOTIFICATION_EVENTS],
    data: params,
  });
}
