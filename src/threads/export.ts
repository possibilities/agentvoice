import { z } from "zod";
import type { ThreadMonitor } from "./monitor.ts";

/** Public metadata contract for independent read-only clients; never a socket descriptor. */
export const THREAD_MONITOR_EXPORT_VERSION = 1;
export const THREAD_MONITOR_EXPORT_MAX_BYTES = 1024 * 1024;
const MAX_THREADS = 256;
const identity = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const monitorSchema = z
  .object({
    instanceId: identity.optional(),
    generation: z.number().int().nonnegative().safe().optional(),
    sequence: z.number().int().nonnegative().safe().optional(),
    rootThreadId: identity.optional(),
    phase: z.string().min(1).max(256),
    workspace: z.string().min(1).max(4096).optional(),
    inventory: z.enum(["pending", "ready", "incomplete", "unavailable"]),
    threads: z
      .array(
        z
          .object({
            id: identity,
            parentThreadId: identity.nullable(),
            name: z.string().max(256).nullable(),
            status: z.enum(["unknown", "notLoaded", "idle", "active", "systemError"]),
            activeFlags: z.array(z.enum(["waitingOnApproval", "waitingOnUserInput"])).max(2),
            turn: z
              .object({
                id: identity,
                status: z.enum(["inProgress", "completed", "interrupted", "failed"]),
              })
              .strict()
              .nullable(),
            model: z.string().max(256).nullable().optional(),
            effort: z.string().max(256).nullable().optional(),
            nickname: z.string().max(256).nullable().optional(),
          })
          .strict(),
      )
      .max(MAX_THREADS),
    missingSettings: z.number().int().min(0).max(MAX_THREADS),
  })
  .strict()
  .superRefine((monitor, ctx) => {
    if (
      monitor.inventory !== "unavailable" &&
      [
        monitor.instanceId,
        monitor.generation,
        monitor.sequence,
        monitor.rootThreadId,
        monitor.workspace,
      ].some((value) => value === undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "Observed inventory requires exact native identity",
      });
    if (monitor.inventory === "unavailable" && monitor.threads.length)
      ctx.addIssue({ code: "custom", message: "Unavailable inventory cannot retain thread rows" });
    if (new Set(monitor.threads.map((thread) => thread.id)).size !== monitor.threads.length)
      ctx.addIssue({ code: "custom", message: "Thread identities must be unique" });
    const root = monitor.threads.find((thread) => thread.id === monitor.rootThreadId);
    if (monitor.inventory === "ready" && (!root || root.parentThreadId !== null))
      ctx.addIssue({ code: "custom", message: "Ready inventory requires its parentless root row" });
    if (monitor.missingSettings > monitor.threads.length)
      ctx.addIssue({ code: "custom", message: "Missing settings cannot exceed observed rows" });
  });
export const threadMonitorExportSchema = z
  .object({
    schemaVersion: z.literal(THREAD_MONITOR_EXPORT_VERSION),
    observedAt: z.iso.datetime(),
    monitor: monitorSchema,
  })
  .strict();
export type ThreadMonitorExport = z.infer<typeof threadMonitorExportSchema>;
export function exportThreadMonitor(
  monitor: ThreadMonitor,
  observedAt = new Date().toISOString(),
): ThreadMonitorExport {
  const threads =
    monitor.inventory === "unavailable"
      ? []
      : monitor.threads.map((thread) => ({
          id: thread.id,
          parentThreadId: thread.parentThreadId,
          name: thread.name,
          status: thread.status,
          activeFlags: thread.activeFlags,
          turn: thread.turn ? { id: thread.turn.id, status: thread.turn.status } : null,
          model: thread.model,
          effort: thread.effort,
          nickname: thread.nickname,
        }));
  const exported = threadMonitorExportSchema.parse({
    schemaVersion: THREAD_MONITOR_EXPORT_VERSION,
    observedAt,
    monitor: {
      instanceId: monitor.instanceId,
      generation: monitor.generation,
      sequence: monitor.sequence,
      rootThreadId: monitor.rootThreadId,
      phase: monitor.phase,
      workspace: monitor.workspace,
      inventory: monitor.inventory,
      threads,
      missingSettings: threads.filter((thread) => thread.model == null || thread.effort == null)
        .length,
    },
  });
  // Include the command's trailing newline in the public byte budget.
  if (Buffer.byteLength(JSON.stringify(exported)) + 1 > THREAD_MONITOR_EXPORT_MAX_BYTES)
    throw new Error("Native observation exceeds its output bound");
  return exported;
}
