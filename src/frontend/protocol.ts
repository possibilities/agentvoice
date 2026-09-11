import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { clientMediaMessageSchema, serverMediaMessageSchema } from "../frontend/media-protocol.ts";
import { codingActivitySchema } from "../runtime-control/coding-activity.ts";

export const FRONTEND_VERSION = 3;
const channel = z.object({ muted: z.boolean(), effectiveMuted: z.boolean() }).strict();
export const frontendStateSchema = z
  .object({
    available: z.boolean(),
    codingActivity: codingActivitySchema,
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
    availability: z.enum(["idle", "connected", "closing", "unavailable"]),
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
export const frontendMediaInputSchema = clientMediaMessageSchema;
export const frontendMediaOutputSchema = serverMediaMessageSchema;

const request = {
  v: z.literal(FRONTEND_VERSION),
  type: z.literal("request"),
  id: z.string().min(1).max(128),
};
export const frontendRequestSchema = z.discriminatedUnion("method", [
  z.object({ ...request, method: z.enum(["discover", "observe"]) }).strict(),
  z.object({ ...request, method: z.literal("call"), params: callParamsSchema }).strict(),
  z.object({ ...request, method: z.literal("input"), params: frontendCommandSchema }).strict(),
  z
    .object({ ...request, method: z.literal("client-media"), params: frontendMediaInputSchema })
    .strict(),
]);
export const frontendServerFrameSchema = z.union([
  z
    .object({
      v: z.literal(FRONTEND_VERSION),
      type: z.literal("state"),
      state: frontendStateSchema,
    })
    .strict(),
  z
    .object({
      v: z.literal(FRONTEND_VERSION),
      type: z.literal("observation"),
      observation: observationSchema,
    })
    .strict(),
  z
    .object({
      v: z.literal(FRONTEND_VERSION),
      type: z.literal("client-media"),
      message: frontendMediaOutputSchema,
    })
    .strict(),
  z
    .object({
      v: z.literal(FRONTEND_VERSION),
      type: z.literal("response"),
      id: z.string().min(1).max(128),
      ok: z.literal(true),
      result: z.union([
        z.null(),
        observationSchema,
        z
          .object({
            busy: z.boolean(),
            workspace: z.string().nullable(),
            threadId: z.string().nullable(),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      v: z.literal(FRONTEND_VERSION),
      type: z.literal("response"),
      id: z.string().min(1).max(128),
      ok: z.literal(false),
      error: z.object({ message: z.string() }).strict(),
    })
    .strict(),
]);
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
    codingActivity: state.codingActivity,
    phase: state.phase,
    mic: { muted: state.mic.muted, effectiveMuted: state.mic.effectiveMuted },
    speaker: { muted: state.speaker.muted, effectiveMuted: state.speaker.effectiveMuted },
  };
}
