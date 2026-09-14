import type { Assignment, Result, Work } from "../../src/hud/types.ts";
import type { ThreadRow } from "../../src/threads/monitor.ts";

export type TreeRow<T> = {
  item: T;
  depth: number;
  ancestry: "resolved" | "missing-parent" | "unresolved";
};

export function treeRows<T>(
  items: T[],
  idOf: (item: T) => string,
  parentOf: (item: T) => string | null,
  compare: (a: T, b: T) => number = (a, b) => idOf(a).localeCompare(idOf(b)),
): TreeRow<T>[] {
  const byId = new Map(items.map((item) => [idOf(item), item]));
  const children = new Map<string, T[]>();
  for (const item of items) {
    const parent = parentOf(item);
    if (!parent) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(item);
    children.set(parent, siblings);
  }
  for (const siblings of children.values()) siblings.sort(compare);

  const rows: TreeRow<T>[] = [];
  const visited = new Set<string>();
  const visit = (item: T, depth: number, ancestry: TreeRow<T>["ancestry"]) => {
    const id = idOf(item);
    if (visited.has(id)) return;
    visited.add(id);
    rows.push({ item, depth, ancestry });
    for (const child of children.get(id) ?? []) visit(child, depth + 1, ancestry);
  };

  const roots = items
    .filter((item) => {
      const parent = parentOf(item);
      return !parent || !byId.has(parent);
    })
    .sort(compare);
  for (const root of roots) {
    const parent = parentOf(root);
    visit(root, 0, parent && !byId.has(parent) ? "missing-parent" : "resolved");
  }
  for (const item of [...items].sort(compare)) {
    if (!visited.has(idOf(item))) visit(item, 0, "unresolved");
  }
  return rows;
}

export const assignmentRows = (assignments: Assignment[]) =>
  treeRows(
    assignments,
    (assignment) => assignment.id,
    (assignment) => assignment.parentAssignmentId,
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );

export const nativeRows = (threads: ThreadRow[]) =>
  treeRows(
    threads,
    (thread) => thread.id,
    (thread) => thread.parentThreadId,
    (a, b) => (a.name ?? a.nickname ?? a.id).localeCompare(b.name ?? b.nickname ?? b.id),
  );

export const workRows = (works: Work[]) =>
  treeRows(
    works,
    (work) => work.id,
    (work) => work.parentId,
    (a, b) => b.priority - a.priority || b.updatedAt.localeCompare(a.updatedAt),
  );

export function latestResult(results: Result[], assignmentId: string): Result | undefined {
  return results
    .filter((result) => result.assignmentId === assignmentId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

export function pendingAcceptance(results: Result[]): Result[] {
  return results.filter((result) => result.reviews.at(-1)?.decision !== "accepted");
}

export function pendingPresentation(results: Result[]): Result[] {
  return results.filter(
    (result) => result.reviews.at(-1)?.decision === "accepted" && !result.presentations.length,
  );
}
