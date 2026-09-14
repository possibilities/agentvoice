import type { HudSnapshot } from "../../src/hud/types.ts";
import type { ThreadRow } from "../../src/threads/monitor.ts";

const now = "2026-09-13T22:42:00.000Z";
const binding = (threadId: string, turnId: string) => ({
  instanceId: "instance-live-01",
  generation: 7,
  rootThreadId: "root-agentvoice",
  threadId,
  turnId,
  evidence: [{ ref: `native:${threadId}:${turnId}` }],
});

const thread = (
  id: string,
  parentThreadId: string | null,
  name: string,
  status: ThreadRow["status"],
  turnStatus: NonNullable<ThreadRow["turn"]>["status"] | null,
  extra: Partial<ThreadRow> = {},
): ThreadRow => ({
  id,
  parentThreadId,
  name,
  status,
  activeFlags: [],
  turn: turnStatus ? { id: `turn-${id}`, status: turnStatus } : null,
  model: "gpt-6-astra",
  effort: "high",
  nickname: null,
  ...extra,
});

const threads: ThreadRow[] = [
  thread("root-agentvoice", null, "Coordinator", "active", "inProgress", { effort: "xhigh" }),
  thread("thread-research", "root-agentvoice", "Research evidence", "idle", "completed"),
  thread("thread-ui", "root-agentvoice", "HUD interface", "active", "inProgress"),
  thread("thread-review", "thread-ui", "Accessibility review", "active", "inProgress"),
  thread("thread-deep-1", "thread-review", "Hierarchy fixture", "active", "inProgress"),
  thread("thread-deep-2", "thread-deep-1", "Dense-state review", "idle", "completed"),
  thread("thread-wait", "root-agentvoice", "Installer handoff", "active", "inProgress", {
    activeFlags: ["waitingOnUserInput"],
  }),
  thread("thread-unassigned", "thread-ui", "Observed native helper", "idle", "completed", {
    model: null,
    effort: null,
  }),
  thread("thread-orphan", "parent-not-loaded", "Recovered orphan", "systemError", "failed"),
];

export function completeSnapshot(observedAt = new Date().toISOString()): HudSnapshot {
  const works: HudSnapshot["store"]["works"] = [
    {
      id: "work-durable-hud",
      revision: 5,
      createdAt: now,
      updatedAt: now,
      objective: "Make durable work and native execution legible at a glance",
      scope:
        "A local, read-only HUD for work outcomes, exact thread hierarchy, and honest recovery state.",
      authority: [
        { ref: "session:request" },
        { ref: "https://example.com/request-evidence", note: "Safe-link fixture" },
        { ref: "javascript:alert(document.domain)", note: "Untrusted protocol fixture" },
      ],
      lead: "root/hud-recovery",
      parentId: null,
      dependencies: [],
      priority: 10,
      disposition: "active",
      nextAction: "Review the rendered HUD and accept the integrated result.",
      attentionRefs: [],
    },
    {
      id: "work-installer",
      revision: 3,
      createdAt: now,
      updatedAt: "2026-09-13T22:38:00.000Z",
      objective: "Install the HUD without coupling it to an active voice call",
      scope: "Package the sibling service and preserve the existing AgentVoice lifecycle.",
      authority: [{ ref: "session:request" }],
      lead: "root/hud-recovery",
      parentId: "work-durable-hud",
      dependencies: [],
      priority: 6,
      disposition: "waiting",
      nextAction: "Record installation evidence after integration.",
      attentionRefs: [],
    },
  ];
  const assignments: HudSnapshot["store"]["assignments"] = [
    {
      id: "assignment-research",
      revision: 2,
      createdAt: "2026-09-13T22:24:00.000Z",
      updatedAt: now,
      workId: "work-durable-hud",
      parentAssignmentId: null,
      issuer: "root/hud-recovery",
      assignee: "root/hud-recovery/research",
      taskName: "Recover the source contract and visual constraints",
      resultContract: "Return product evidence and boundaries.",
      binding: binding("thread-research", "turn-thread-research"),
    },
    {
      id: "assignment-ui",
      revision: 2,
      createdAt: "2026-09-13T22:25:00.000Z",
      updatedAt: now,
      workId: "work-durable-hud",
      parentAssignmentId: null,
      issuer: "root/hud-recovery",
      assignee: "root/hud-recovery/ui",
      taskName: "Build the standalone HUD interface",
      resultContract: "Return a responsive build, tests, and rendered screenshots.",
      binding: binding("thread-ui", "turn-thread-ui"),
    },
    {
      id: "assignment-review",
      revision: 2,
      createdAt: "2026-09-13T22:26:00.000Z",
      updatedAt: now,
      workId: "work-durable-hud",
      parentAssignmentId: "assignment-ui",
      issuer: "root/hud-recovery/ui",
      assignee: "root/hud-recovery/ui/review",
      taskName: "Verify accessibility and responsive behavior",
      resultContract: "Return reviewed screenshots and browser assertions.",
      binding: binding("thread-review", "turn-thread-review"),
    },
    {
      id: "assignment-deep-1",
      revision: 2,
      createdAt: "2026-09-13T22:27:00.000Z",
      updatedAt: now,
      workId: "work-durable-hud",
      parentAssignmentId: "assignment-review",
      issuer: "root/hud-recovery/ui/review",
      assignee: "root/hud-recovery/ui/review/fixtures",
      taskName: "Exercise the third assignment depth",
      resultContract: "Keep every nested assignment visible.",
      binding: binding("thread-deep-1", "turn-thread-deep-1"),
    },
    {
      id: "assignment-deep-2",
      revision: 2,
      createdAt: "2026-09-13T22:28:00.000Z",
      updatedAt: now,
      workId: "work-durable-hud",
      parentAssignmentId: "assignment-deep-1",
      issuer: "root/hud-recovery/ui/review/fixtures",
      assignee: "root/hud-recovery/ui/review/fixtures/dense",
      taskName: "Return a fourth-depth nested result",
      resultContract: "Prove hierarchy does not flatten after two levels.",
      binding: binding("thread-deep-2", "turn-thread-deep-2"),
    },
    {
      id: "assignment-undispatched",
      revision: 1,
      createdAt: "2026-09-13T22:29:00.000Z",
      updatedAt: now,
      workId: "work-installer",
      parentAssignmentId: null,
      issuer: "root/hud-recovery",
      assignee: "root/hud-recovery/installer",
      taskName: "Prepare the installed sibling service",
      resultContract: "Return installer checks.",
      binding: null,
    },
  ];
  const results: HudSnapshot["store"]["results"] = [
    {
      id: "result-research",
      revision: 1,
      createdAt: "2026-09-13T22:31:00.000Z",
      updatedAt: "2026-09-13T22:31:00.000Z",
      workId: "work-durable-hud",
      assignmentId: "assignment-research",
      actor: "root/hud-recovery/research",
      outcome: "completed",
      summary: "Recovered the durable work boundaries and the exact observation contract.",
      evidence: [{ ref: "wiki:durable-work-owner" }],
      binding: binding("thread-research", "turn-thread-research"),
      reviews: [],
      presentations: [],
    },
    {
      id: "result-deep",
      revision: 2,
      createdAt: "2026-09-13T22:33:00.000Z",
      updatedAt: "2026-09-13T22:34:00.000Z",
      workId: "work-durable-hud",
      assignmentId: "assignment-deep-2",
      actor: "root/hud-recovery/ui/review/fixtures/dense",
      outcome: "partial",
      summary: "Dense hierarchy is visible; narrow-screen review remains to be accepted.",
      evidence: [{ ref: "artifact:hud-dense.png" }],
      binding: binding("thread-deep-2", "turn-thread-deep-2"),
      reviews: [
        {
          actor: "root/hud-recovery",
          decision: "changes_required",
          evidence: [{ ref: "review:mobile" }],
          at: "2026-09-13T22:34:00.000Z",
        },
      ],
      presentations: [],
    },
    {
      id: "result-ui-accepted",
      revision: 2,
      createdAt: "2026-09-13T22:35:00.000Z",
      updatedAt: "2026-09-13T22:36:00.000Z",
      workId: "work-durable-hud",
      assignmentId: "assignment-ui",
      actor: "root/hud-recovery/ui",
      outcome: "completed",
      summary: "The first HUD slice builds and renders from complete synthetic data.",
      evidence: [{ ref: "artifact:hud-desktop.png" }],
      binding: binding("thread-ui", "turn-thread-ui"),
      reviews: [
        {
          actor: "root/hud-recovery",
          decision: "accepted",
          evidence: [{ ref: "check:hud-build" }],
          at: "2026-09-13T22:36:00.000Z",
        },
      ],
      presentations: [],
    },
  ];
  return {
    schemaVersion: 1,
    observedAt,
    store: { revision: 28, works, assignments, results, events: [] },
    native: {
      availability: "observed",
      phase: "live",
      workspace: "/Users/arthack/worktrees/agentvoice/durable-work-hud/agentvoice",
      instanceId: "instance-live-01",
      generation: 7,
      seq: 148,
      rootThreadId: "root-agentvoice",
      inventory: "ready",
      threads,
      counts: { knownWorking: 3, waiting: 1, idle: 3, failed: 1, loaded: 8, exact: true },
      coordinator: threads[0]!,
    },
    workViews: [
      {
        workId: "work-durable-hud",
        counts: { knownWorking: 2, waiting: 0, idle: 2, failed: 0, loaded: 4, exact: true },
        assignmentViews: [
          {
            assignmentId: "assignment-research",
            execution: "completed",
            threadId: "thread-research",
          },
          { assignmentId: "assignment-ui", execution: "working", threadId: "thread-ui" },
          { assignmentId: "assignment-review", execution: "working", threadId: "thread-review" },
          { assignmentId: "assignment-deep-1", execution: "working", threadId: "thread-deep-1" },
          { assignmentId: "assignment-deep-2", execution: "completed", threadId: "thread-deep-2" },
        ],
        pendingReview: 2,
        pendingPresentation: 1,
      },
      {
        workId: "work-installer",
        counts: { knownWorking: 0, waiting: 0, idle: 0, failed: 0, loaded: 0, exact: true },
        assignmentViews: [
          { assignmentId: "assignment-undispatched", execution: "not_dispatched", threadId: null },
        ],
        pendingReview: 0,
        pendingPresentation: 0,
      },
    ],
    unassignedThreads: [threads[6]!, threads[7]!, threads[8]!],
  };
}

export function partialSnapshot(): HudSnapshot {
  const snapshot = completeSnapshot();
  snapshot.native.inventory = "incomplete";
  snapshot.native.counts.exact = false;
  for (const view of snapshot.workViews) view.counts.exact = false;
  return snapshot;
}

export function unavailableSnapshot(): HudSnapshot {
  const snapshot = completeSnapshot();
  snapshot.native = {
    availability: "unavailable",
    phase: "offline",
    workspace: null,
    instanceId: null,
    generation: null,
    seq: null,
    rootThreadId: null,
    inventory: "unavailable",
    threads: [],
    counts: { knownWorking: 0, waiting: 0, idle: 0, failed: 0, loaded: 0, exact: false },
    coordinator: null,
  };
  snapshot.workViews = snapshot.workViews.map((view) => ({
    ...view,
    counts: { knownWorking: 0, waiting: 0, idle: 0, failed: 0, loaded: 0, exact: false },
    assignmentViews: view.assignmentViews.map((assignment) => ({
      ...assignment,
      execution: assignment.execution === "not_dispatched" ? "not_dispatched" : "unavailable",
    })),
  }));
  snapshot.unassignedThreads = [];
  return snapshot;
}
