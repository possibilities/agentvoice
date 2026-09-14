import { z } from "zod";
export const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const text = z
  .string()
  .min(1)
  .max(16000)
  .refine(
    (v) =>
      [...v].every((char) => char.charCodeAt(0) >= 32 || [9, 10, 13].includes(char.charCodeAt(0))),
    "Control characters are not allowed",
  );
export const evidence = z.object({ ref: text, note: text.optional() }).strict();
const refs = z.array(evidence).min(1).max(64);
export const bindingSchema = z
  .object({
    instanceId: id,
    generation: z.number().int().nonnegative(),
    rootThreadId: id,
    threadId: id,
    turnId: id,
    evidence: refs,
  })
  .strict();
const workFields = {
  objective: text,
  scope: text,
  authority: refs,
  lead: id,
  parentId: id.nullable(),
  dependencies: z.array(id).max(128),
  priority: z.number().int().min(-100).max(100),
  disposition: z.enum(["open", "active", "paused", "waiting", "completed", "cancelled"]),
  nextAction: z.string().max(16000),
  attentionRefs: z.array(text).max(64),
};
const common = { operationId: id, actor: id, id, expectedRevision: z.number().int().nonnegative() };
export const mutationSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...common,
      action: z.literal("work.create"),
      data: z
        .object({
          ...workFields,
          parentId: workFields.parentId.default(null),
          dependencies: workFields.dependencies.default([]),
          priority: workFields.priority.default(0),
          disposition: workFields.disposition.default("open"),
          nextAction: workFields.nextAction.default(""),
          attentionRefs: workFields.attentionRefs.default([]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("work.update"),
      data: z.object(workFields).partial().strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("assignment.prepare"),
      data: z
        .object({
          workId: id,
          parentAssignmentId: id.nullable().default(null),
          assignee: id,
          taskName: text,
          resultContract: text,
        })
        .strict(),
    })
    .strict(),
  z.object({ ...common, action: z.literal("assignment.bind"), data: bindingSchema }).strict(),
  z
    .object({
      ...common,
      action: z.literal("result.record"),
      data: z
        .object({
          workId: id,
          assignmentId: id.nullable().default(null),
          outcome: z.enum(["completed", "failed", "interrupted", "partial"]),
          dispatchResolution: z
            .enum(["not_dispatched", "dispatch_failed"])
            .nullable()
            .default(null),
          summary: text,
          evidence: refs,
          binding: bindingSchema.nullable().default(null),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("result.review"),
      data: z
        .object({ decision: z.enum(["accepted", "changes_required"]), evidence: refs })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("result.present"),
      data: z.object({ evidence: refs }).strict(),
    })
    .strict(),
]);
export type Mutation = z.infer<typeof mutationSchema>;

export const batchSchema = z
  .object({ operationId: id, operations: z.array(mutationSchema).min(1).max(100) })
  .strict();
