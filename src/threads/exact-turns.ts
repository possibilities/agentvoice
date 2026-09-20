import { z } from "zod";
import { conversationTurnSchema } from "../events/conversation.ts";
import type { ControlSocket } from "../ipc/control-client.ts";

export const MAX_TIMING_TARGETS = 128;
export const MAX_TIMING_TARGET_BYTES = 64 * 1024;
const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const target = { rootThreadId: id, threadId: id, turnId: id };
export const timingTargetSchema = z.object(target).strict();
export type TimingTarget = z.infer<typeof timingTargetSchema>;
export const timingKey = (value: TimingTarget) =>
  JSON.stringify([value.rootThreadId, value.threadId, value.turnId]);
export const exactTurnSchema = z.discriminatedUnion("state", [
  z
    .object({
      ...target,
      state: z.literal("observed"),
      status: z.enum(["inProgress", "completed", "interrupted", "failed"]),
      startedAt: z.number().int().safe().nonnegative().optional(),
      completedAt: z.number().int().safe().nonnegative().optional(),
    })
    .strict(),
  z.object({ ...target, state: z.literal("not_found") }).strict(),
  z
    .object({
      ...target,
      state: z.literal("unavailable"),
      reason: z.enum(["budget", "root_mismatch", "history_unavailable", "changed", "invalid"]),
    })
    .strict(),
]);
export type ExactTurn = z.infer<typeof exactTurnSchema>;
export const exactTurnsSchema = z
  .array(exactTurnSchema)
  .max(MAX_TIMING_TARGETS)
  .superRefine((rows, ctx) => {
    if (new Set(rows.map(timingKey)).size !== rows.length)
      ctx.addIssue({ code: "custom", message: "Duplicate timing target" });
    for (const row of rows)
      if (
        row.state === "observed" &&
        ((row.status === "inProgress" && row.completedAt !== undefined) ||
          (row.startedAt !== undefined &&
            row.completedAt !== undefined &&
            row.startedAt > row.completedAt))
      )
        ctx.addIssue({ code: "custom", message: "Inconsistent turn timestamps" });
  });
export function parseTimingTargets(text: string): TimingTarget[] {
  if (Buffer.byteLength(text) > MAX_TIMING_TARGET_BYTES)
    throw new Error("Timing targets exceed input bound");
  const rows = z.array(timingTargetSchema).max(MAX_TIMING_TARGETS).parse(JSON.parse(text));
  if (new Set(rows.map(timingKey)).size !== rows.length) throw new Error("Duplicate timing target");
  return rows.sort((a, b) => timingKey(a).localeCompare(timingKey(b)));
}

/** Uses authorized native metadata pages only. No resume, item content or history files. */
export async function readExactTurns(
  client: Pick<ControlSocket, "request">,
  identity: { instanceId: string; generation: number; rootThreadId: string },
  targets: readonly TimingTarget[],
  deadline: number,
): Promise<ExactTurn[]> {
  parseTimingTargets(JSON.stringify(targets));
  const outcomes = new Map(
    targets.map((t) => [
      timingKey(t),
      {
        ...t,
        state: "unavailable",
        reason: t.rootThreadId === identity.rootThreadId ? "budget" : "root_mismatch",
      } as ExactTurn,
    ]),
  );
  const groups = new Map<string, TimingTarget[]>();
  for (const t of targets)
    if (t.rootThreadId === identity.rootThreadId)
      groups.set(t.threadId, [...(groups.get(t.threadId) ?? []), t]);
  // A deterministic bounded scan per requested thread avoids a global latest-N
  // export starving a specific bound turn. Unfinished scans never mean not found.
  let pages = 0;
  const ordered = [...groups].sort(([a], [b]) => a.localeCompare(b));
  let nextGroup = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, ordered.length) }, async () => {
      while (Date.now() < deadline) {
        const group = ordered[nextGroup++];
        if (!group) return;
        const [threadId, wanted] = group;
        let cursor: string | undefined;
        const cursors = new Set<string>();
        let revision: number | undefined;
        let coherent = true;
        let ended = false;
        let failure: "budget" | "history_unavailable" | "changed" | "invalid" = "budget";
        const pending = new Map(wanted.map((t) => [t.turnId, t]));
        const seenTurns = new Set<string>();
        for (
          let page = 0;
          page < 20 && pages < 256 && Date.now() < deadline && pending.size;
          page++
        ) {
          pages++;
          try {
            const raw = await client.request("conversation.turns.list", {
              expectedInstanceId: identity.instanceId,
              expectedGeneration: identity.generation,
              rootThreadId: identity.rootThreadId,
              threadId,
              limit: 50,
              sortDirection: "desc",
              ...(cursor ? { cursor } : {}),
            });
            if (!raw || typeof raw !== "object") throw new Error("invalid");
            const result = raw as Record<string, unknown>;
            if (
              result.method !== "conversation.turns.list" ||
              result.instanceId !== identity.instanceId ||
              result.generation !== identity.generation ||
              result.rootThreadId !== identity.rootThreadId ||
              result.threadId !== threadId ||
              !Array.isArray(result.data) ||
              result.data.length > 50 ||
              !Number.isSafeInteger(result.revisionBefore) ||
              !Number.isSafeInteger(result.revisionAfter) ||
              typeof result.changedDuringRead !== "boolean"
            )
              throw new Error("invalid");
            if (result.changedDuringRead || result.revisionBefore !== result.revisionAfter) {
              failure = "changed";
              break;
            }
            if (revision !== undefined && revision !== result.revisionBefore) coherent = false;
            revision = result.revisionAfter as number;
            const next = result.nextCursor;
            if (
              next !== null &&
              (typeof next !== "string" || !next || next.length > 256 || cursors.has(next))
            )
              throw new Error("invalid");
            const turns = result.data.map((value) => conversationTurnSchema.parse(value));
            if (
              new Set(turns.map((t) => t.id)).size !== turns.length ||
              turns.some((turn) => seenTurns.has(turn.id))
            )
              throw new Error("invalid");
            for (const turn of turns) seenTurns.add(turn.id);
            const found: ExactTurn[] = [];
            for (const turn of turns) {
              const t = pending.get(turn.id);
              if (!t) continue;
              const entry = exactTurnSchema.parse({
                ...t,
                state: "observed",
                status: turn.status,
                ...(turn.startedAt == null ? {} : { startedAt: turn.startedAt }),
                ...(turn.completedAt == null ? {} : { completedAt: turn.completedAt }),
              });
              exactTurnsSchema.parse([entry]);
              found.push(entry);
            }
            for (const entry of found) {
              outcomes.set(timingKey(entry), entry);
              pending.delete(entry.turnId);
            }
            if (next === null) {
              ended = true;
              break;
            }
            cursor = next as string;
            cursors.add(cursor);
          } catch (error) {
            failure =
              error instanceof z.ZodError || (error instanceof Error && error.message === "invalid")
                ? "invalid"
                : "history_unavailable";
            if (failure === "invalid")
              for (const requested of wanted)
                outcomes.set(timingKey(requested), {
                  ...requested,
                  state: "unavailable",
                  reason: "invalid",
                });
            break;
          }
        }
        for (const t of pending.values())
          outcomes.set(
            timingKey(t),
            ended && coherent
              ? { ...t, state: "not_found" }
              : { ...t, state: "unavailable", reason: ended ? "changed" : failure },
          );
      }
    }),
  );
  return exactTurnsSchema.parse([...outcomes.values()]);
}
