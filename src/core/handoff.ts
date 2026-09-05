import { z } from "zod";

export const HANDOFF_MAX_BYTES = 8192;
export const handoffPromptSchema = z
  .string()
  .max(HANDOFF_MAX_BYTES)
  .refine((value) => value.trim().length > 0, "must contain non-whitespace text")
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= HANDOFF_MAX_BYTES,
    "exceeds 8192 UTF-8 bytes",
  )
  .describe(
    "One-use restart task. Non-whitespace text, at most 8192 UTF-8 bytes; content is preserved exactly.",
  );

export const handoffRequestSchema = z
  .object({
    prompt: handoffPromptSchema,
    threadId: z.string().min(1),
    workspace: z.string().min(1),
    clientUserMessageId: z.string().min(1).max(128),
  })
  .strict();
export type HandoffRequest = z.infer<typeof handoffRequestSchema>;

const failure = z.object({ code: z.string(), message: z.string() }).strict();
export const handoffResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted"), turnId: z.string().min(1).max(256) }).strict(),
  z.object({ status: z.literal("failed"), error: failure }).strict(),
  z.object({ status: z.literal("unknown"), error: failure }).strict(),
]);
export type HandoffResult = z.infer<typeof handoffResultSchema>;

/** Fixed messages only: native errors can echo the private handoff payload. */
export function handoffFailure(
  code: "not_ready" | "native_refused" | "journal_failed",
): HandoffResult {
  const messages = {
    not_ready: "Handoff was not submitted: the original conversation is no longer ready.",
    native_refused: "Native Codex refused the handoff input.",
    journal_failed: "Handoff was not submitted: its journal update failed.",
  };
  return { status: "failed", error: { code, message: messages[code] } };
}
export function handoffUnknown(): HandoffResult {
  return {
    status: "unknown",
    error: {
      code: "submission_unknown",
      message: "Handoff acceptance could not be confirmed; it will not be retried automatically.",
    },
  };
}
