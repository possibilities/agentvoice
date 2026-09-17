import { z } from "zod";

export const COMPLETION_OUTPUT = "subagent_completion";
export const COMPLETION_NAMESPACE = "agentvoice";
export const MAX_COMPLETION_DELIVERIES = 16_384;
export const completionId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const count = z.number().int().nonnegative().safe();

export const childSchema = z
  .object({
    threadId: completionId,
    turnId: completionId.nullable(),
    name: z.string().max(64).nullable(),
    agentPath: z.string().max(128).nullable(),
    waitingOn: z.array(z.enum(["waitingOnApproval", "waitingOnUserInput"])).max(2),
  })
  .strict();

export const completionSchema = childSchema
  .extend({
    turnId: completionId,
    status: z.enum(["completed", "failed", "interrupted"]),
    observedAt: z.string().datetime(),
  })
  .strict();

export const inFlightSchema = z
  .object({
    revision: count,
    threads: z.array(childSchema).max(256),
    complete: z.boolean(),
    observedAt: z.string().datetime(),
  })
  .strict();

export const completionRequestSchema = z
  .object({
    eventId: completionId,
    instanceId: completionId,
    rootThreadId: completionId,
    completion: completionSchema,
  })
  .strict();

export const completionDeliverySchema = completionRequestSchema
  .extend({
    v: z.literal(1),
    type: z.literal("subagent.completion"),
    inFlight: inFlightSchema,
  })
  .strict();

export const deliveryOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted"), turnId: completionId }).strict(),
  z.object({ status: z.enum(["refused", "unknown", "unavailable"]) }).strict(),
]);

export const completionObservationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inventory"), inventory: inFlightSchema }).strict(),
  z
    .object({ kind: z.literal("started"), child: childSchema, observedAt: z.string().datetime() })
    .strict(),
  z.object({ kind: z.literal("completed"), completion: completionSchema }).strict(),
  z
    .object({ kind: z.literal("gap"), reason: z.enum(["capacity", "metadata", "inventory"]) })
    .strict(),
]);

export type Child = z.infer<typeof childSchema>;
export type Completion = z.infer<typeof completionSchema>;
export type InFlight = z.infer<typeof inFlightSchema>;
export type CompletionRequest = z.infer<typeof completionRequestSchema>;
export type CompletionDelivery = z.infer<typeof completionDeliverySchema>;
export type DeliveryOutcome = z.infer<typeof deliveryOutcomeSchema>;
export type CompletionObservation = z.infer<typeof completionObservationSchema>;

export interface CompletionRuntime {
  snapshot(): InFlight;
  deliver(request: CompletionRequest): Promise<DeliveryOutcome>;
}

export function completionDelivery(
  request: CompletionRequest,
  inFlight: InFlight,
): CompletionDelivery {
  return {
    ...request,
    v: 1,
    type: "subagent.completion",
    inFlight,
  };
}
