import { z } from "zod";

export const MAILBOX_TOOL = "agentvoice_thread_mailbox_open";
export const MAILBOX_OUTPUT = "thread_mailbox_notice";
export const MAILBOX_NAMESPACE = "agentvoice";
export const MAX_MAILBOX_ENTRIES = 256;
export const mailboxId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const count = z.number().int().nonnegative().safe();
export const childSchema = z
  .object({
    threadId: mailboxId,
    turnId: mailboxId.nullable(),
    name: z.string().max(64).nullable(),
    agentPath: z.string().max(128).nullable(),
    waitingOn: z.array(z.enum(["waitingOnApproval", "waitingOnUserInput"])).max(2),
  })
  .strict();
export const completionSchema = childSchema
  .extend({
    turnId: mailboxId,
    status: z.enum(["completed", "failed", "interrupted"]),
    observedAt: z.string().datetime(),
  })
  .strict();
export const mailboxEntrySchema = completionSchema.extend({ eventId: mailboxId }).strict();
export const inFlightSchema = z
  .object({
    revision: count,
    threads: z.array(childSchema).max(256),
    complete: z.boolean(),
    observedAt: z.string().datetime(),
  })
  .strict();
export const mailboxOpenParams = z
  .object({
    operationId: mailboxId,
    expectedInstanceId: mailboxId,
  })
  .strict();
export const mailboxCallerSchema = z.object({ threadId: mailboxId, callId: mailboxId }).strict();
export const wakeRequestSchema = z
  .object({
    eventId: mailboxId,
    instanceId: mailboxId,
    rootThreadId: mailboxId,
    completed: count,
  })
  .strict();
export const wakeNoticeSchema = wakeRequestSchema
  .extend({
    v: z.literal(1),
    type: z.literal("thread_mailbox.pending"),
    inFlight: count,
    inventoryComplete: z.boolean(),
    observedAt: z.string().datetime(),
    message: z.string().max(1024),
    open: z.object({ tool: z.literal(MAILBOX_TOOL), arguments: mailboxOpenParams }).strict(),
  })
  .strict();
export const wakeOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted"), turnId: mailboxId }).strict(),
  z.object({ status: z.enum(["refused", "unknown", "unavailable"]) }).strict(),
]);
export const wakeStateSchema = z
  .object({
    eventId: mailboxId,
    generation: count,
    status: z.enum(["pending", "submitting", "accepted", "refused", "unknown", "unavailable"]),
    notice: wakeNoticeSchema.nullable(),
    turnId: mailboxId.nullable(),
    recorded: z.object({ turnId: mailboxId, itemId: mailboxId }).strict().nullable(),
  })
  .strict();
export const mailboxSnapshotSchema = z
  .object({
    revision: count,
    completed: count,
    unavailableCompletions: count,
    entries: z.array(mailboxEntrySchema).max(MAX_MAILBOX_ENTRIES),
    inFlight: inFlightSchema,
    recentWakes: z.array(wakeStateSchema).max(32),
  })
  .strict();
export const mailboxOpenResultSchema = z
  .object({
    operationId: mailboxId,
    instanceId: mailboxId,
    revision: count,
    entries: z.array(mailboxEntrySchema).max(32),
    unavailableCompletions: count,
    remainingCompleted: count,
    inFlight: inFlightSchema,
    inFlightTotal: count,
    inFlightTruncated: z.boolean(),
  })
  .strict();
export const mailboxObservationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inventory"), inventory: inFlightSchema }).strict(),
  z
    .object({ kind: z.literal("started"), child: childSchema, observedAt: z.string().datetime() })
    .strict(),
  z.object({ kind: z.literal("completed"), completion: completionSchema }).strict(),
  z.object({ kind: z.literal("submitting"), notice: wakeNoticeSchema }).strict(),
  z
    .object({
      kind: z.literal("recorded"),
      eventId: mailboxId,
      turnId: mailboxId,
      itemId: mailboxId,
    })
    .strict(),
  z
    .object({ kind: z.literal("gap"), reason: z.enum(["capacity", "metadata", "inventory"]) })
    .strict(),
]);
export const mailboxEventSchemas = {
  "mailbox.changed": z.object({ state: mailboxSnapshotSchema }).strict(),
  "mailbox.child.started": z
    .object({ child: childSchema, observedAt: z.string().datetime() })
    .strict(),
  "mailbox.child.completed": z.object({ entry: mailboxEntrySchema }).strict(),
  "mailbox.opened": z
    .object({
      operationId: mailboxId,
      eventIds: z.array(mailboxId).max(32),
      remainingCompleted: count,
      unavailableCompletions: count,
    })
    .strict(),
  "mailbox.wake.changed": z.object({ wake: wakeStateSchema }).strict(),
  "mailbox.gap": z
    .object({
      reason: z.enum(["capacity", "metadata", "inventory"]),
      unavailableCompletions: count,
    })
    .strict(),
};
export type Child = z.infer<typeof childSchema>;
export type Completion = z.infer<typeof completionSchema>;
export type MailboxEntry = z.infer<typeof mailboxEntrySchema>;
export type InFlight = z.infer<typeof inFlightSchema>;
export type MailboxOpenParams = z.infer<typeof mailboxOpenParams>;
export type MailboxCaller = z.infer<typeof mailboxCallerSchema>;
export type MailboxOpenResult = z.infer<typeof mailboxOpenResultSchema>;
export type WakeRequest = z.infer<typeof wakeRequestSchema>;
export type WakeNotice = z.infer<typeof wakeNoticeSchema>;
export type WakeOutcome = z.infer<typeof wakeOutcomeSchema>;
export type WakeState = z.infer<typeof wakeStateSchema>;
export type MailboxSnapshot = z.infer<typeof mailboxSnapshotSchema>;
export type MailboxObservation = z.infer<typeof mailboxObservationSchema>;
export type MailboxEventName = keyof typeof mailboxEventSchemas;
export type MailboxPublish = <K extends MailboxEventName>(
  name: K,
  data: z.infer<(typeof mailboxEventSchemas)[K]>,
) => void;
export interface MailboxRuntime {
  snapshot(): InFlight;
  authorize(caller: MailboxCaller): Promise<boolean>;
  wake(request: WakeRequest): Promise<WakeOutcome>;
}

export function wakeNotice(request: WakeRequest, inventory: InFlight): WakeNotice {
  const n = request.completed;
  const m = inventory.threads.length;
  return {
    ...request,
    v: 1,
    type: "thread_mailbox.pending",
    inFlight: m,
    inventoryComplete: inventory.complete,
    observedAt: inventory.observedAt,
    message: `${n} completion ${n === 1 ? "notice is" : "notices are"} waiting in your thread mailbox; ${inventory.complete ? `${m} ${m === 1 ? "subagent is" : "subagents are"} still working` : `the working count is incomplete (${m} observed)`}. Call ${MAILBOX_TOOL} for details.`,
    open: {
      tool: MAILBOX_TOOL,
      arguments: { operationId: request.eventId, expectedInstanceId: request.instanceId },
    },
  };
}

export const mailboxGetParams = z.object({ expectedInstanceId: mailboxId }).strict();
export const mailboxReplayParams = mailboxGetParams
  .extend({ afterSequence: count, limit: z.number().int().min(1).max(100).default(100) })
  .strict();
