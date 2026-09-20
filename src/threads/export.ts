import { z } from "zod";
import { canonicalAgentPathSchema } from "../events/conversation.ts";
import { exactTurnsSchema } from "./exact-turns.ts";
import type { ThreadMonitor } from "./monitor.ts";

/** Public metadata contract for independent read-only clients; never a socket descriptor. */
export const THREAD_MONITOR_EXPORT_VERSION = 5;
export const THREAD_MONITOR_EXPORT_MAX_BYTES = 1024 * 1024;
const MAX_THREADS = 256;
const identity = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const parentageSource = z.enum(["live_inventory", "native_history"]);
const sources = z.array(parentageSource).min(1).max(2);
export const nativeParentageSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("root"), sources }).strict(),
  z.object({ state: z.literal("verified"), parentThreadId: identity, sources }).strict(),
  z.object({ state: z.literal("missing"), reason: z.literal("not_reported"), sources }).strict(),
  z
    .object({
      state: z.literal("conflict"),
      parentThreadIds: z.array(identity).min(2).max(32),
      sources,
    })
    .strict(),
]);
export const collaborationIdentitySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("root"), sources }).strict(),
  z.object({ state: z.literal("verified"), path: canonicalAgentPathSchema, sources }).strict(),
  z
    .object({
      state: z.literal("missing"),
      reason: z.enum(["not_reported", "malformed"]),
      sources,
    })
    .strict(),
  z
    .object({
      state: z.literal("conflict"),
      paths: z.array(canonicalAgentPathSchema).min(2).max(32),
      sources,
    })
    .strict(),
]);
const exportedThreadSchema = z
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
        startedAt: z.number().int().safe().nonnegative().optional(),
        completedAt: z.number().int().safe().nonnegative().optional(),
      })
      .strict()
      .nullable(),
    model: z.string().max(256).nullable().optional(),
    effort: z.string().max(256).nullable().optional(),
    nickname: z.string().max(256).nullable().optional(),
    parentage: nativeParentageSchema,
    collaborationIdentity: collaborationIdentitySchema,
  })
  .strict()
  .superRefine((thread, ctx) => {
    const expected = thread.parentage.state === "verified" ? thread.parentage.parentThreadId : null;
    if (thread.parentThreadId !== expected)
      ctx.addIssue({ code: "custom", message: "Thread parent must match verified parentage" });
    if (new Set(thread.parentage.sources).size !== thread.parentage.sources.length)
      ctx.addIssue({ code: "custom", message: "Parentage sources must be unique" });
    if (
      thread.parentage.state === "conflict" &&
      new Set(thread.parentage.parentThreadIds).size !== thread.parentage.parentThreadIds.length
    )
      ctx.addIssue({ code: "custom", message: "Conflicting parents must be unique" });
    if (
      "sources" in thread.collaborationIdentity &&
      new Set(thread.collaborationIdentity.sources).size !==
        thread.collaborationIdentity.sources.length
    )
      ctx.addIssue({ code: "custom", message: "Collaboration identity sources must be unique" });
    if (
      thread.collaborationIdentity.state === "conflict" &&
      new Set(thread.collaborationIdentity.paths).size !== thread.collaborationIdentity.paths.length
    )
      ctx.addIssue({ code: "custom", message: "Conflicting collaboration paths must be unique" });
  });
const monitorSchema = z
  .object({
    instanceId: identity.optional(),
    generation: z.number().int().nonnegative().safe().optional(),
    sequence: z.number().int().nonnegative().safe().optional(),
    rootThreadId: identity.optional(),
    nativeSessionId: identity.optional(),
    phase: z.string().min(1).max(256),
    workspace: z.string().min(1).max(4096).optional(),
    inventory: z.enum(["pending", "ready", "incomplete", "unavailable"]),
    historyCoverage: z.enum(["complete", "partial", "unavailable"]),
    exactTurns: exactTurnsSchema,
    threads: z.array(exportedThreadSchema).max(MAX_THREADS),
    missingSettings: z.number().int().min(0).max(MAX_THREADS),
  })
  .strict()
  .superRefine((monitor, ctx) => {
    if (
      monitor.exactTurns.some(
        (row) =>
          row.state === "observed" &&
          (row.rootThreadId !== monitor.rootThreadId || monitor.inventory === "unavailable"),
      )
    )
      ctx.addIssue({ code: "custom", message: "Exact timing requires its observed root" });
    if (
      monitor.inventory !== "unavailable" &&
      [
        monitor.instanceId,
        monitor.generation,
        monitor.sequence,
        monitor.rootThreadId,
        monitor.nativeSessionId,
        monitor.workspace,
      ].some((value) => value === undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "Observed inventory requires exact native identity",
      });
    if (monitor.inventory === "unavailable" && monitor.threads.length)
      ctx.addIssue({ code: "custom", message: "Unavailable inventory cannot retain thread rows" });
    if (monitor.inventory === "unavailable" && monitor.historyCoverage !== "unavailable")
      ctx.addIssue({
        code: "custom",
        message: "Unavailable inventory cannot claim native history",
      });
    if (
      monitor.historyCoverage === "unavailable" &&
      monitor.threads.some(
        (thread) =>
          "sources" in thread.parentage && thread.parentage.sources.includes("native_history"),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Unavailable native history cannot source thread parentage",
      });
    if (new Set(monitor.threads.map((thread) => thread.id)).size !== monitor.threads.length)
      ctx.addIssue({ code: "custom", message: "Thread identities must be unique" });
    const root = monitor.threads.find((thread) => thread.id === monitor.rootThreadId);
    if (
      monitor.inventory === "ready" &&
      (!root ||
        root.parentThreadId !== null ||
        root.parentage.state !== "root" ||
        root.collaborationIdentity.state !== "root")
    )
      ctx.addIssue({
        code: "custom",
        message: "Ready inventory requires its parentless root row and root collaboration identity",
      });
    if (monitor.nativeSessionId !== undefined && monitor.nativeSessionId !== monitor.rootThreadId)
      ctx.addIssue({
        code: "custom",
        message: "Native session identity must be the revalidated root",
      });
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
          turn: thread.turn
            ? {
                id: thread.turn.id,
                status: thread.turn.status,
                ...(thread.turn.startedAt === undefined
                  ? {}
                  : { startedAt: thread.turn.startedAt }),
                ...(thread.turn.completedAt === undefined
                  ? {}
                  : { completedAt: thread.turn.completedAt }),
              }
            : null,
          model: thread.model,
          effort: thread.effort,
          nickname: thread.nickname,
          parentage:
            thread.parentage ??
            (thread.id === monitor.rootThreadId && thread.parentThreadId === null
              ? { state: "root" as const, sources: ["live_inventory" as const] }
              : thread.parentThreadId
                ? {
                    state: "verified" as const,
                    parentThreadId: thread.parentThreadId,
                    sources: ["live_inventory" as const],
                  }
                : {
                    state: "missing" as const,
                    reason: "not_reported" as const,
                    sources: ["live_inventory" as const],
                  }),
          collaborationIdentity:
            thread.collaborationIdentity ??
            (thread.id === monitor.rootThreadId
              ? { state: "root" as const, sources: ["live_inventory" as const] }
              : {
                  state: "missing" as const,
                  reason: "not_reported" as const,
                  sources: ["live_inventory" as const],
                }),
        }));
  const exported = threadMonitorExportSchema.parse({
    schemaVersion: THREAD_MONITOR_EXPORT_VERSION,
    observedAt,
    monitor: {
      instanceId: monitor.instanceId,
      generation: monitor.generation,
      sequence: monitor.sequence,
      rootThreadId: monitor.rootThreadId,
      nativeSessionId: monitor.nativeSessionId,
      phase: monitor.phase,
      workspace: monitor.workspace,
      inventory: monitor.inventory,
      historyCoverage:
        monitor.inventory === "unavailable"
          ? "unavailable"
          : (monitor.historyCoverage ?? "unavailable"),
      exactTurns: monitor.inventory === "unavailable" ? [] : (monitor.exactTurns ?? []),
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
