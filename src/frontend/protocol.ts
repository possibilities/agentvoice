import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

export const FRONTEND_VERSION = 1;
const channel = z.object({ muted: z.boolean(), effectiveMuted: z.boolean() }).strict();
export const frontendStateSchema = z
  .object({
    available: z.boolean(),
    phase: z.enum(["waiting-ready", "negotiating", "live", "failed", "stopped"]),
    mic: channel,
    speaker: channel,
  })
  .strict();
export type FrontendState = z.infer<typeof frontendStateSchema>;
export const callParamsSchema = z.object({ clientId: z.string().uuid() }).strict();
export const observationSchema = z
  .object({
    busy: z.boolean(),
    clientId: z.string().uuid().nullable(),
    workspace: z.string().nullable(),
    threadId: z.string().nullable(),
    state: frontendStateSchema.nullable(),
  })
  .strict();
export type FrontendObservation = z.infer<typeof observationSchema>;
export const frontendCommandSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("mute"), target: z.enum(["mic", "speaker"]), muted: z.boolean() })
    .strict(),
  z.object({ action: z.enum(["hold", "release"]) }).strict(),
]);
export type FrontendCommand = z.infer<typeof frontendCommandSchema>;
export function frontendSocketPath(stateDir: string, workspace?: string): string {
  return join(
    stateDir,
    "frontend",
    workspace === undefined
      ? "default.sock"
      : `${createHash("sha256").update(workspace).digest("hex").slice(0, 24)}.sock`,
  );
}
export function frontendState(state: FrontendState): FrontendState {
  return {
    available: state.available,
    phase: state.phase,
    mic: { muted: state.mic.muted, effectiveMuted: state.mic.effectiveMuted },
    speaker: { muted: state.speaker.muted, effectiveMuted: state.speaker.effectiveMuted },
  };
}
