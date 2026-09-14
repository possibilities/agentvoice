import type { ThreadRow } from "../threads/monitor.ts";

export type Evidence = { ref: string; note?: string };
export type NativeBinding = {
  instanceId: string;
  generation: number;
  rootThreadId: string;
  threadId: string;
  turnId: string;
  evidence: Evidence[];
};
export type Work = {
  scopeRevision?: number;
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  objective: string;
  scope: string;
  authority: Evidence[];
  lead: string;
  parentId: string | null;
  dependencies: string[];
  priority: number;
  disposition: "open" | "active" | "paused" | "waiting" | "completed" | "cancelled";
  nextAction: string;
  attentionRefs: string[];
};
export type Assignment = {
  scopeRevision?: number;
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  workId: string;
  parentAssignmentId: string | null;
  issuer: string;
  assignee: string;
  taskName: string;
  resultContract: string;
  binding: NativeBinding | null;
};
export type Review = {
  actor: string;
  decision: "accepted" | "changes_required";
  evidence: Evidence[];
  at: string;
};
export type Presentation = { actor: string; evidence: Evidence[]; at: string };
export type Result = {
  scopeRevision?: number;
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  workId: string;
  assignmentId: string | null;
  actor: string;
  outcome: "completed" | "failed" | "interrupted" | "partial";
  dispatchResolution?: "not_dispatched" | "dispatch_failed" | null;
  summary: string;
  evidence: Evidence[];
  binding: NativeBinding | null;
  reviews: Review[];
  presentations: Presentation[];
};
export type WorkEvent = {
  sequence: number;
  operationId: string;
  actor: string;
  action: string;
  entityId: string;
  at: string;
};
export type WorkSnapshot = {
  revision: number;
  works: Work[];
  assignments: Assignment[];
  results: Result[];
  events: WorkEvent[];
};
export type Counts = {
  knownWorking: number;
  waiting: number;
  idle: number;
  failed: number;
  loaded: number;
  exact: boolean;
};
export type AssignmentView = {
  assignmentId: string;
  execution:
    | "not_dispatched"
    | "dispatch_failed"
    | "dispatch_unknown"
    | "unavailable"
    | "not_observed"
    | "different_turn"
    | "working"
    | "waiting"
    | "idle"
    | "completed"
    | "failed"
    | "interrupted"
    | "unknown";
  threadId: string | null;
};
export type HudSnapshot = {
  schemaVersion: 1;
  observedAt: string;
  store: WorkSnapshot;
  native: {
    availability: "observed" | "unavailable";
    phase: string;
    workspace: string | null;
    instanceId: string | null;
    generation: number | null;
    seq: number | null;
    rootThreadId: string | null;
    inventory: "pending" | "ready" | "incomplete" | "unavailable";
    threads: ThreadRow[];
    counts: Counts;
    coordinator: ThreadRow | null;
  };
  workViews: {
    workId: string;
    counts: Counts;
    assignmentViews: AssignmentView[];
    pendingReview: number;
    pendingPresentation: number;
  }[];
  unassignedThreads: ThreadRow[];
};
