import { z } from "zod";

const VOICE_CATALOG_SOURCE = "thread/realtime/listVoices" as const;
const MAX_VOICE_ID_LENGTH = 128;
const MAX_VOICES_PER_FAMILY = 128;

const voiceIdSchema = z
  .string()
  .min(1)
  .max(MAX_VOICE_ID_LENGTH)
  .refine((voice) => voice.trim() === voice, "voice ids cannot be blank or padded");

const voiceFamilySchema = z
  .array(voiceIdSchema)
  .min(1)
  .max(MAX_VOICES_PER_FAMILY)
  .refine((voices) => new Set(voices).size === voices.length, "voice ids must be unique");

const nativeVoiceListSchema = z
  .strictObject({
    v1: voiceFamilySchema,
    v2: voiceFamilySchema,
    defaultV1: voiceIdSchema,
    defaultV2: voiceIdSchema,
  })
  .superRefine((voices, context) => {
    if (!voices.v1.includes(voices.defaultV1))
      context.addIssue({
        code: "custom",
        path: ["defaultV1"],
        message: "defaultV1 must be a member of v1",
      });
    if (!voices.v2.includes(voices.defaultV2))
      context.addIssue({
        code: "custom",
        path: ["defaultV2"],
        message: "defaultV2 must be a member of v2",
      });
  });

const nativeVoiceResponseSchema = z.strictObject({ voices: nativeVoiceListSchema });

/** A validated capability observation from the owned native Codex child. */
export const nativeVoiceCatalogResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    source: z.literal(VOICE_CATALOG_SOURCE),
    fetchedAt: z.string().datetime(),
    voices: nativeVoiceListSchema,
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    source: z.literal(VOICE_CATALOG_SOURCE),
    error: z.string().min(1).max(160),
  }),
]);

export type NativeVoiceCatalogResult = z.infer<typeof nativeVoiceCatalogResultSchema>;
type AvailableVoiceCatalog = Extract<NativeVoiceCatalogResult, { status: "available" }>;

export type NativeVoiceCatalogRequest = (method: string, params: unknown) => Promise<unknown>;

/**
 * Reads the native runtime's advertised voice compatibility catalog. This is
 * capability information for one owned child, never an account availability promise.
 */
export class NativeVoiceCatalog {
  private cached: AvailableVoiceCatalog | undefined;
  private pending: Promise<NativeVoiceCatalogResult> | undefined;

  constructor(private readonly request: NativeVoiceCatalogRequest) {}

  async read(refresh = false): Promise<NativeVoiceCatalogResult> {
    if (!refresh && this.cached) return this.cached;
    if (this.pending) return this.pending;

    const pending = this.fetch();
    this.pending = pending;
    try {
      const result = await pending;
      if (result.status === "available") this.cached = result;
      return result;
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }

  private async fetch(): Promise<NativeVoiceCatalogResult> {
    let response: unknown;
    try {
      response = await this.request(VOICE_CATALOG_SOURCE, {});
    } catch (error) {
      return unavailable(requestFailure(error));
    }

    const parsed = nativeVoiceResponseSchema.safeParse(response);
    if (!parsed.success) return unavailable("Native voice catalog returned an invalid response.");
    return {
      status: "available",
      source: VOICE_CATALOG_SOURCE,
      fetchedAt: new Date().toISOString(),
      voices: parsed.data.voices,
    };
  }
}

function unavailable(error: string): NativeVoiceCatalogResult {
  return { status: "unavailable", source: VOICE_CATALOG_SOURCE, error };
}

/** Never forward arbitrary native exception text into diagnostics or clients. */
function requestFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/unsupported|not supported|not implemented|method not found|unknown method/i.test(detail))
    return "Native voice catalog is unsupported by this Codex runtime.";
  if (/invalid|validation|malformed|bad request/i.test(detail))
    return "Native voice catalog request was invalid.";
  return "Native voice catalog request failed.";
}

export function compatibleVoiceCatalog(
  catalog: NativeVoiceCatalogResult,
  protocol: "v1" | "v3" | null,
): { protocol: "v1" | "v3" | null; choices: string[]; defaultVoice: string | null } {
  if (catalog.status !== "available" || protocol === null)
    return { protocol, choices: [], defaultVoice: null };
  // WebRTC v3 intentionally uses Codex's v1 voice family; v2 has no WebRTC support.
  return {
    protocol,
    choices: [...catalog.voices.v1],
    defaultVoice: catalog.voices.defaultV1,
  };
}
