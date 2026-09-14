import { z } from "zod";
import type { VoiceValues } from "./config-schema.ts";
import { nativeVoiceCatalogResultSchema } from "./voice-catalog.ts";

export const voiceNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0);
export const randomVoiceSelectionSchema = z
  .object({ kind: z.literal("random"), excludeCurrent: z.literal(true) })
  .strict();
export const voiceProtocolSchema = z.enum(["v1", "v3"]).nullable();
export const voiceCatalogReceiptSchema = z
  .object({
    source: z.literal("thread/realtime/listVoices"),
    fetchedAt: z.string(),
    protocol: z.enum(["v1", "v3"]),
  })
  .strict();

export const voiceInspectionSchema = z
  .object({
    managedVoice: voiceNameSchema.nullable(),
    requestedVoice: voiceNameSchema.nullable(),
    selectionSource: z.enum(["explicit-request", "native-resolution", "unknown"]),
    masked: z.boolean(),
    protocol: voiceProtocolSchema,
    catalog: nativeVoiceCatalogResultSchema,
    choices: z.array(voiceNameSchema).max(128),
    defaultVoice: voiceNameSchema.nullable(),
  })
  .strict();
export type VoiceInspection = z.infer<typeof voiceInspectionSchema>;

/** The supported WebRTC request path; raw null version restores native v1 resolution. */
export function voiceProtocol(values: Pick<VoiceValues, "version" | "extra">): "v1" | "v3" | null {
  const extra = values.extra ?? {};
  if (Object.hasOwn(extra, "transport")) {
    const transport = extra["transport"];
    if (
      !transport ||
      typeof transport !== "object" ||
      Array.isArray(transport) ||
      (transport as Record<string, unknown>)["type"] !== "webrtc"
    )
      return null;
  }
  const version = Object.hasOwn(extra, "version") ? extra["version"] : (values.version ?? "v3");
  if (version === null) return "v1";
  return version === "v1" || version === "v3" ? version : null;
}
