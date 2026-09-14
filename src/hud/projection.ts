import type { ThreadMonitor, ThreadRow } from "../threads/monitor.ts";
import type { AssignmentView, Counts, HudSnapshot, WorkSnapshot } from "./types.ts";

function activity(thread: ThreadRow): AssignmentView["execution"] {
  if (thread.status === "notLoaded") return "unknown";
  if (thread.activeFlags.length) return "waiting";
  if (thread.status === "systemError") return "failed";
  if (thread.status === "active" || thread.turn?.status === "inProgress") return "working";
  if (thread.turn) return thread.turn.status;
  return thread.status === "idle" ? "idle" : "unknown";
}
function counts(threads: ThreadRow[], exact: boolean): Counts {
  return {
    knownWorking: threads.filter((t) => activity(t) === "working").length,
    waiting: threads.filter((t) => activity(t) === "waiting").length,
    idle: threads.filter(
      (t) => t.status === "idle" && !["working", "waiting"].includes(activity(t)),
    ).length,
    failed: threads.filter((t) => activity(t) === "failed").length,
    loaded: threads.filter((thread) => thread.status !== "notLoaded").length,
    exact,
  };
}
export function projectHud(
  store: WorkSnapshot,
  monitor: ThreadMonitor,
  observedAt = new Date().toISOString(),
): HudSnapshot {
  const observed =
    monitor.instanceId !== undefined &&
    monitor.generation !== undefined &&
    monitor.sequence !== undefined &&
    monitor.rootThreadId !== undefined &&
    monitor.inventory !== "unavailable";
  // Every row is from this fresh cut. Unavailable observation never reuses a green cached state.
  const threads = observed ? monitor.threads : [];
  const exact = observed && monitor.inventory === "ready";
  const root = monitor.rootThreadId ?? null;
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const matched = new Set<string>();
  const workViews = store.works.map((work) => {
    const assignmentViews = store.assignments
      .filter((assignment) => assignment.workId === work.id)
      .map((assignment) => {
        const binding = assignment.binding;
        let execution: AssignmentView["execution"] = "dispatch_unknown";
        const resolution = store.results.find(
          (result) => result.assignmentId === assignment.id && result.dispatchResolution,
        );
        if (!binding && resolution?.dispatchResolution) execution = resolution.dispatchResolution;
        if (binding) {
          execution = "unavailable";
          if (observed) {
            execution = "not_observed";
            const thread = byId.get(binding.threadId);
            if (
              binding.instanceId === monitor.instanceId &&
              binding.generation === monitor.generation &&
              binding.rootThreadId === root &&
              thread
            ) {
              execution = thread.turn?.id === binding.turnId ? activity(thread) : "different_turn";
              if (thread.turn?.id === binding.turnId) matched.add(thread.id);
            }
          }
        }
        return { assignmentId: assignment.id, execution, threadId: binding?.threadId ?? null };
      });
    const selected = new Set(
      assignmentViews
        .filter(
          (view) =>
            !["dispatch_unknown", "unavailable", "not_observed", "different_turn"].includes(
              view.execution,
            ),
        )
        .map((view) => view.threadId),
    );
    const workThreads = threads.filter((thread) => thread.id !== root && selected.has(thread.id));
    const results = store.results.filter((result) => result.workId === work.id);
    return {
      workId: work.id,
      counts: counts(
        workThreads,
        exact &&
          !assignmentViews.some((view) =>
            [
              "dispatch_unknown",
              "unavailable",
              "not_observed",
              "different_turn",
              "unknown",
            ].includes(view.execution),
          ),
      ),
      assignmentViews,
      pendingReview: results.filter((result) => result.reviews.at(-1)?.decision !== "accepted")
        .length,
      pendingPresentation: results.filter(
        (result) => result.reviews.at(-1)?.decision === "accepted" && !result.presentations.length,
      ).length,
    };
  });
  return {
    schemaVersion: 1,
    observedAt,
    store,
    native: {
      availability: observed ? "observed" : "unavailable",
      phase: monitor.phase,
      workspace: monitor.workspace ?? null,
      instanceId: monitor.instanceId ?? null,
      generation: monitor.generation ?? null,
      seq: monitor.sequence ?? null,
      rootThreadId: root,
      inventory: monitor.inventory,
      threads,
      counts: counts(
        threads.filter((thread) => thread.id !== root),
        exact,
      ),
      coordinator: threads.find((thread) => thread.id === root) ?? null,
    },
    workViews,
    unassignedThreads: threads.filter((thread) => thread.id !== root && !matched.has(thread.id)),
  };
}
