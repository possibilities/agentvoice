import { z } from "zod";

export const BROWSER_MEDIA_MAX_FRAME_BYTES = 256 * 1024;
export const BROWSER_MEDIA_MAX_SDP_CHARS = 192 * 1024;

const sessionId = z.string().uuid();
const muteState = z.object({ muted: z.boolean(), effectiveMuted: z.boolean() }).strict();

export const browserMediaClientMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("offer"),
      sessionId,
      sdp: z.string().min(1).max(BROWSER_MEDIA_MAX_SDP_CHARS),
    })
    .strict(),
  z.object({ type: z.literal("connected"), sessionId }).strict(),
  z.object({ type: z.literal("failed"), sessionId, detail: z.string().min(1).max(256) }).strict(),
  z
    .object({
      type: z.literal("mute"),
      sessionId,
      target: z.enum(["mic", "speaker"]),
      muted: z.boolean(),
    })
    .strict(),
  z.object({ type: z.enum(["hold", "release"]), sessionId }).strict(),
]);
export type BrowserMediaClientMessage = z.infer<typeof browserMediaClientMessageSchema>;

export const browserMediaServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prepare"), sessionId }).strict(),
  z
    .object({
      type: z.literal("answer"),
      sessionId,
      sdp: z.string().min(1).max(BROWSER_MEDIA_MAX_SDP_CHARS),
    })
    .strict(),
  z
    .object({ type: z.literal("close"), sessionId, reason: z.string().min(1).max(256).optional() })
    .strict(),
  z
    .object({
      type: z.literal("state"),
      sessionId,
      mic: muteState,
      speaker: muteState,
    })
    .strict(),
]);
export type BrowserMediaServerMessage = z.infer<typeof browserMediaServerMessageSchema>;
