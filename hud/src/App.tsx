import { useEffect, useState } from "react";
import type {
  Assignment,
  AssignmentView,
  Counts,
  Evidence,
  HudSnapshot,
  NativeBinding,
  Result,
  Work,
} from "../../src/hud/types.ts";
import type { ThreadRow } from "../../src/threads/monitor.ts";
import {
  assignmentRows,
  latestResult,
  nativeRows,
  pendingAcceptance,
  pendingPresentation,
  workRows,
} from "./view-model.ts";

type ReadState = {
  snapshot?: HudSnapshot;
  error?: string;
};

const executionCopy: Record<AssignmentView["execution"], string> = {
  not_dispatched: "Not dispatched",
  dispatch_failed: "Dispatch failed",
  dispatch_unknown: "Dispatch unknown",
  unavailable: "Observation unavailable",
  not_observed: "Bound thread not observed",
  different_turn: "Thread moved to another turn",
  working: "Working",
  waiting: "Waiting",
  idle: "Idle",
  completed: "Turn completed",
  failed: "Turn failed",
  interrupted: "Turn interrupted",
  unknown: "State unknown",
};

const resultCopy: Record<Result["outcome"], string> = {
  completed: "Returned complete",
  partial: "Returned partial",
  failed: "Returned failed",
  interrupted: "Returned interrupted",
};

const dispositionCopy: Record<Work["disposition"], string> = {
  open: "Open",
  active: "Active",
  paused: "Paused",
  waiting: "Waiting",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function App() {
  const [state, setState] = useState<ReadState>({});
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const response = await fetch("/api/hud", {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]),
        });
        if (!response.ok) throw new Error(`HUD returned ${response.status}`);
        const snapshot = (await response.json()) as HudSnapshot;
        if (snapshot.schemaVersion !== 1) throw new Error("Unsupported HUD snapshot");
        if (!controller.signal.aborted) setState({ snapshot });
      } catch (error) {
        if (!controller.signal.aborted) {
          setState((current) => ({
            ...current,
            error: error instanceof Error ? error.message : "HUD unavailable",
          }));
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(read, 1_000);
      }
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  if (!state.snapshot) return <OpeningState error={state.error} />;
  return <Hud snapshot={state.snapshot} error={state.error} />;
}

function OpeningState({ error }: { error?: string }) {
  return (
    <main className="opening-state">
      <p className="brand">AgentHUD</p>
      <h1>{error ? "Work view unavailable" : "Loading durable work…"}</h1>
      <p role="status">
        {error
          ? "The work store could not be read. No completion state has been inferred. Retrying automatically."
          : "Reading declared work and native observations."}
      </p>
    </main>
  );
}

function Hud({ snapshot, error }: { snapshot: HudSnapshot; error?: string }) {
  const acceptance = pendingAcceptance(snapshot.store.results);
  const presentation = pendingPresentation(snapshot.store.results);
  const openWork = snapshot.store.works.filter(
    (work) => !["completed", "cancelled"].includes(work.disposition),
  ).length;
  const rows = workRows(snapshot.store.works);
  const health = observationHealth(snapshot, error);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#work-ledger">
        Skip to work
      </a>
      <header className="masthead">
        <div>
          <p className="brand">AgentHUD</p>
          <p className="brand-detail">Durable work and native execution</p>
        </div>
        <div className="observation-stamp">
          <span className={`state-mark state-mark--${health.tone}`} aria-hidden="true" />
          <span>{health.label}</span>
          <span className="mono">{formatRecency(snapshot.observedAt)}</span>
        </div>
      </header>

      <main id="work-ledger">
        <section className="overview" aria-labelledby="page-title">
          <div className="overview-copy">
            <h1 id="page-title">Work</h1>
            <p>
              {openWork} open · {acceptance.length} awaiting acceptance · {presentation.length}{" "}
              awaiting presentation
            </p>
          </div>
          <dl className="headline-counts" aria-label="Work summary">
            <Metric label="Open work" value={openWork} />
            <Metric
              label="Known working"
              value={snapshot.native.counts.knownWorking}
              qualifier={snapshot.native.counts.exact ? undefined : "at least"}
            />
            <Metric label="Awaiting acceptance" value={acceptance.length} />
            <Metric label="Awaiting presentation" value={presentation.length} />
          </dl>
        </section>

        {health.notice ? (
          <p className={`system-notice system-notice--${health.tone}`} role="status">
            <span className="state-symbol" aria-hidden="true">
              {health.tone === "warning" ? "!" : "·"}
            </span>
            {health.notice}
          </p>
        ) : null}

        <div className="dashboard-grid">
          <OutcomeQueues
            acceptance={acceptance}
            presentation={presentation}
            works={snapshot.store.works}
          />

          <aside className="native-column" aria-labelledby="native-heading">
            <NativeView snapshot={snapshot} />
          </aside>

          <section className="ledger-section" aria-labelledby="work-heading">
            <SectionHeading
              id="work-heading"
              title="Work ledger"
              detail={`${snapshot.store.works.length} declared · revision ${snapshot.store.revision}`}
            />
            {rows.length ? (
              <div className="work-list">
                {rows.map(({ item: work, depth, ancestry }) => (
                  <WorkView
                    key={work.id}
                    work={work}
                    workDepth={depth}
                    ancestry={ancestry}
                    snapshot={snapshot}
                  />
                ))}
              </div>
            ) : (
              <EmptyState title="No declared work" detail="The durable work store is empty." />
            )}
          </section>
        </div>
      </main>
      <footer>
        <span>AgentHUD</span>
        <span>Read-only projection · no state inferred from silence</span>
      </footer>
    </div>
  );
}

function Metric({ label, value, qualifier }: { label: string; value: number; qualifier?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {value}
        {qualifier ? <span>{qualifier}</span> : null}
      </dd>
    </div>
  );
}

function OutcomeQueues({
  acceptance,
  presentation,
  works,
}: {
  acceptance: Result[];
  presentation: Result[];
  works: Work[];
}) {
  return (
    <section className="outcome-section" aria-labelledby="outcomes-heading">
      <SectionHeading
        id="outcomes-heading"
        title="Returned outcomes"
        detail={`${acceptance.length + presentation.length} lead obligations`}
      />
      <div className="queue-grid">
        <OutcomeQueue
          title="Awaiting acceptance"
          description="Returned evidence has not been accepted by the work lead."
          results={acceptance}
          works={works}
          kind="acceptance"
        />
        <OutcomeQueue
          title="Awaiting presentation"
          description="Accepted evidence has not been recorded as presented to the human."
          results={presentation}
          works={works}
          kind="presentation"
        />
      </div>
    </section>
  );
}

function OutcomeQueue({
  title,
  description,
  results,
  works,
  kind,
}: {
  title: string;
  description: string;
  results: Result[];
  works: Work[];
  kind: "acceptance" | "presentation";
}) {
  return (
    <section className="queue" aria-label={title}>
      <div className="queue-heading">
        <h3>{title}</h3>
        <span className="queue-count">{results.length}</span>
      </div>
      <p>{description}</p>
      {results.length ? (
        <ul className="queue-list">
          {results.map((result) => {
            const work = works.find((candidate) => candidate.id === result.workId);
            const changesRequested = result.reviews.at(-1)?.decision === "changes_required";
            return (
              <li key={result.id}>
                <div className="row-state">
                  <StateLabel tone={changesRequested ? "warning" : "neutral"}>
                    {kind === "presentation"
                      ? "Accepted"
                      : changesRequested
                        ? "Changes required"
                        : resultStateText(result)}
                  </StateLabel>
                  <time dateTime={result.updatedAt}>{formatDate(result.updatedAt)}</time>
                </div>
                <p className="queue-summary">{result.summary}</p>
                <p className="row-context">{work?.objective ?? result.workId}</p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="quiet-empty">None.</p>
      )}
    </section>
  );
}

function WorkView({
  work,
  workDepth,
  ancestry,
  snapshot,
}: {
  work: Work;
  workDepth: number;
  ancestry: "resolved" | "missing-parent" | "unresolved";
  snapshot: HudSnapshot;
}) {
  const assignments = snapshot.store.assignments.filter((item) => item.workId === work.id);
  const results = snapshot.store.results.filter((item) => item.workId === work.id);
  const view = snapshot.workViews.find((item) => item.workId === work.id);
  const execution = new Map(view?.assignmentViews.map((item) => [item.assignmentId, item]));
  return (
    <article className="work" aria-labelledby={`work-${work.id}`}>
      <header className="work-header">
        <div className="work-title" style={depthStyle(workDepth)} data-depth={workDepth}>
          <span className="tree-stem" aria-hidden="true" />
          <div>
            <div className="work-state-line">
              <StateLabel tone={dispositionTone(work.disposition)}>
                {dispositionCopy[work.disposition]}
              </StateLabel>
              <span className="mono">{work.id}</span>
              {workDepth > 0 ? <span>Work depth {workDepth}</span> : null}
              {ancestry !== "resolved" ? <span>{ancestryCopy(ancestry)}</span> : null}
            </div>
            <h3 id={`work-${work.id}`}>{work.objective}</h3>
          </div>
        </div>
        <time dateTime={work.updatedAt}>{formatDate(work.updatedAt)}</time>
      </header>

      <dl className="work-brief">
        <div>
          <dt>Scope</dt>
          <dd>{work.scope}</dd>
        </div>
        <div>
          <dt>Lead</dt>
          <dd className="mono">{work.lead}</dd>
        </div>
        <div>
          <dt>Next action</dt>
          <dd>{work.nextAction || "No next action declared."}</dd>
        </div>
      </dl>

      <details className="audit-disclosure work-audit">
        <summary>Work context</summary>
        <div className="audit-grid">
          <AuditField label="Scope revision">
            <p>{work.scopeRevision ?? 1}</p>
          </AuditField>
          <AuditField label="Authority">
            <EvidenceList evidence={work.authority} />
          </AuditField>
          <AuditField label="Relations">
            <AuditValues
              values={[
                work.parentId ? `Parent: ${work.parentId}` : "No parent Work",
                ...work.dependencies.map((dependency) => `Depends on: ${dependency}`),
              ]}
            />
          </AuditField>
          <AuditField label="Attention references">
            <ReferenceList refs={work.attentionRefs} empty="None." />
          </AuditField>
        </div>
      </details>

      {view ? (
        <CountLine
          counts={view.counts}
          unavailable={snapshot.native.availability === "unavailable"}
        />
      ) : null}

      <div className="work-details">
        <section aria-label={`Assignments for ${work.objective}`}>
          <h4>Assignments</h4>
          {assignments.length ? (
            <div className="assignment-list">
              {assignmentRows(assignments).map(
                ({ item: assignment, depth, ancestry: rowAncestry }) => (
                  <AssignmentRow
                    key={assignment.id}
                    assignment={assignment}
                    depth={depth}
                    ancestry={rowAncestry}
                    execution={execution.get(assignment.id)}
                    result={latestResult(results, assignment.id)}
                  />
                ),
              )}
            </div>
          ) : (
            <p className="quiet-empty">No assignments declared.</p>
          )}
        </section>
        <section aria-label={`Outcome history for ${work.objective}`}>
          <h4>Outcome history</h4>
          {results.length ? (
            <ul className="result-list">
              {[...results]
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                .map((result) => (
                  <ResultRow key={result.id} result={result} />
                ))}
            </ul>
          ) : (
            <p className="quiet-empty">No outcome returned.</p>
          )}
        </section>
      </div>
    </article>
  );
}

function AssignmentRow({
  assignment,
  depth,
  ancestry,
  execution,
  result,
}: {
  assignment: Assignment;
  depth: number;
  ancestry: "resolved" | "missing-parent" | "unresolved";
  execution?: AssignmentView;
  result?: Result;
}) {
  return (
    <div className="assignment-row" style={depthStyle(depth)} data-depth={depth}>
      <span className="tree-stem" aria-hidden="true" />
      <div className="assignment-main">
        <p>{assignment.taskName}</p>
        <p className="row-context">
          <span className="mono">{assignment.assignee}</span>
          <span className="mono">{assignment.id}</span>
          {depth > 0 ? <span>Depth {depth}</span> : null}
          {ancestry !== "resolved" ? <span>{ancestryCopy(ancestry)}</span> : null}
        </p>
      </div>
      <StateLabel tone={executionTone(execution?.execution)}>
        {execution ? executionCopy[execution.execution] : "Projection unavailable"}
      </StateLabel>
      <div className="assignment-result">
        <span>{result ? resultStateText(result) : "No return"}</span>
        {result ? <span>{reviewLabel(result)}</span> : null}
      </div>
      <details className="audit-disclosure assignment-audit">
        <summary>Assignment contract and binding</summary>
        <div className="audit-grid">
          <AuditField label="Result contract">
            <p>{assignment.resultContract}</p>
          </AuditField>
          <AuditField label="Issuance">
            <AuditValues
              values={[
                `Issuer: ${assignment.issuer}`,
                `Assigned scope revision: ${assignment.scopeRevision ?? 1}`,
                assignment.parentAssignmentId
                  ? `Parent assignment: ${assignment.parentAssignmentId}`
                  : "No parent assignment",
              ]}
            />
          </AuditField>
          <BindingAudit binding={assignment.binding} />
        </div>
      </details>
    </div>
  );
}

function ResultRow({ result }: { result: Result }) {
  return (
    <li>
      <div className="row-state">
        <StateLabel tone={resultTone(result)}>{resultStateText(result)}</StateLabel>
        <span>{reviewLabel(result)}</span>
      </div>
      <p>{result.summary}</p>
      <p className="row-context">
        <span className="mono">{result.id}</span>
        <span>{result.evidence.length} evidence ref.</span>
        <time dateTime={result.updatedAt}>{formatDate(result.updatedAt)}</time>
      </p>
      <details className="audit-disclosure result-audit">
        <summary>Returned evidence and receipts</summary>
        <div className="audit-grid">
          <AuditField label="Returned scope revision">
            <p>{result.scopeRevision ?? 1}</p>
          </AuditField>
          <AuditField label="Returned evidence">
            <EvidenceList evidence={result.evidence} />
          </AuditField>
          <BindingAudit binding={result.binding} />
          <AuditField label="Lead reviews">
            {result.reviews.length ? (
              <ul className="receipt-list">
                {result.reviews.map((review) => (
                  <li key={`${review.at}:${review.actor}:${review.decision}`}>
                    <p>
                      <span>
                        {review.decision === "accepted" ? "Accepted" : "Changes required"}
                      </span>
                      <span className="mono">{review.actor}</span>
                      <time dateTime={review.at}>{formatDate(review.at)}</time>
                    </p>
                    <EvidenceList evidence={review.evidence} />
                  </li>
                ))}
              </ul>
            ) : (
              <p>None recorded.</p>
            )}
          </AuditField>
          <AuditField label="Human presentations">
            {result.presentations.length ? (
              <ul className="receipt-list">
                {result.presentations.map((presentation) => (
                  <li key={`${presentation.at}:${presentation.actor}`}>
                    <p>
                      <span>Presented</span>
                      <span className="mono">{presentation.actor}</span>
                      <time dateTime={presentation.at}>{formatDate(presentation.at)}</time>
                    </p>
                    <EvidenceList evidence={presentation.evidence} />
                  </li>
                ))}
              </ul>
            ) : (
              <p>None recorded.</p>
            )}
          </AuditField>
        </div>
      </details>
    </li>
  );
}

function NativeView({ snapshot }: { snapshot: HudSnapshot }) {
  const native = snapshot.native;
  const unassigned = new Set(snapshot.unassignedThreads.map((thread) => thread.id));
  return (
    <section className="native-section">
      <SectionHeading
        id="native-heading"
        title="Native hierarchy"
        detail={
          native.availability === "observed"
            ? `${native.counts.loaded} loaded · ${native.inventory} inventory`
            : "Observation unavailable"
        }
      />
      <div className="native-meta">
        <div>
          <span>Runtime</span>
          <strong>{native.phase}</strong>
        </div>
        <div>
          <span>Generation</span>
          <strong className="mono">{native.generation ?? "unknown"}</strong>
        </div>
        <div>
          <span>Sequence</span>
          <strong className="mono">{native.seq ?? "unknown"}</strong>
        </div>
        <div className="native-workspace">
          <span>Workspace</span>
          <strong className="mono">{native.workspace ?? "not observed"}</strong>
        </div>
      </div>
      <CountLine counts={native.counts} unavailable={native.availability === "unavailable"} />

      {native.availability === "unavailable" ? (
        <EmptyState
          title="Native observation unavailable"
          detail="Durable work remains visible. No thread state is inferred until a fresh observation succeeds."
        />
      ) : native.threads.length ? (
        <div className="thread-tree">
          {nativeRows(native.threads).map(({ item: thread, depth, ancestry }) => (
            <ThreadRowView
              key={thread.id}
              thread={thread}
              depth={depth}
              ancestry={ancestry}
              coordinator={thread.id === native.rootThreadId}
              unassigned={unassigned.has(thread.id)}
            />
          ))}
        </div>
      ) : (
        <EmptyState title="No threads loaded" detail={`Inventory is ${native.inventory}.`} />
      )}

      <section className="unassigned-section" aria-labelledby="unassigned-heading">
        <div className="minor-heading">
          <h3 id="unassigned-heading">Unassigned observed threads</h3>
          <span>{snapshot.unassignedThreads.length}</span>
        </div>
        {snapshot.unassignedThreads.length ? (
          <ul>
            {snapshot.unassignedThreads.map((thread) => (
              <li key={thread.id}>
                <span>{thread.name ?? thread.nickname ?? "Unnamed thread"}</span>
                <span className="mono">{shortId(thread.id)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="quiet-empty">Every observed worker turn is bound to declared work.</p>
        )}
      </section>
    </section>
  );
}

function ThreadRowView({
  thread,
  depth,
  ancestry,
  coordinator,
  unassigned,
}: {
  thread: ThreadRow;
  depth: number;
  ancestry: "resolved" | "missing-parent" | "unresolved";
  coordinator: boolean;
  unassigned: boolean;
}) {
  const state = threadState(thread);
  return (
    <div className="thread-row" style={depthStyle(depth)} data-depth={depth}>
      <span className="tree-stem" aria-hidden="true" />
      <div className="thread-line">
        <div>
          <p>{thread.name ?? thread.nickname ?? "Unnamed thread"}</p>
          <p className="row-context">
            {coordinator ? <span>Coordinator</span> : null}
            {unassigned ? <span>Unassigned</span> : null}
            {depth > 0 ? <span>Depth {depth}</span> : null}
            {ancestry !== "resolved" ? <span>{ancestryCopy(ancestry)}</span> : null}
          </p>
        </div>
        <StateLabel tone={state.tone}>{state.label}</StateLabel>
      </div>
      <div className="thread-settings">
        <span>{thread.model ?? "Model unknown"}</span>
        <span>{thread.effort ?? "Effort unknown"}</span>
        <span className="mono" title={thread.id}>
          {shortId(thread.id)}
        </span>
      </div>
    </div>
  );
}

function CountLine({ counts, unavailable }: { counts: Counts; unavailable: boolean }) {
  const prefix = counts.exact ? "" : "≥";
  return (
    <dl className="count-line" aria-label="Observed execution counts">
      <div>
        <dt>Working</dt>
        <dd>{unavailable ? "?" : `${prefix}${counts.knownWorking}`}</dd>
      </div>
      <div>
        <dt>Waiting</dt>
        <dd>{unavailable ? "?" : `${prefix}${counts.waiting}`}</dd>
      </div>
      <div>
        <dt>Idle</dt>
        <dd>{unavailable ? "?" : `${prefix}${counts.idle}`}</dd>
      </div>
      <div>
        <dt>Failed</dt>
        <dd>{unavailable ? "?" : `${prefix}${counts.failed}`}</dd>
      </div>
    </dl>
  );
}

function SectionHeading({ id, title, detail }: { id: string; title: string; detail: string }) {
  return (
    <div className="section-heading">
      <h2 id={id}>{title}</h2>
      <p>{detail}</p>
    </div>
  );
}

function StateLabel({
  tone,
  children,
}: {
  tone: "positive" | "warning" | "negative" | "neutral";
  children: React.ReactNode;
}) {
  return (
    <span className={`state-label state-label--${tone}`}>
      <span className="state-mark" aria-hidden="true" />
      {children}
    </span>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <p>{title}</p>
      <p>{detail}</p>
    </div>
  );
}

function AuditField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="audit-field">
      <p className="audit-label">{label}</p>
      {children}
    </div>
  );
}

function BindingAudit({ binding }: { binding: NativeBinding | null }) {
  return (
    <AuditField label="Exact native binding">
      {binding ? (
        <>
          <dl className="binding-grid">
            <div>
              <dt>Instance</dt>
              <dd>{binding.instanceId}</dd>
            </div>
            <div>
              <dt>Generation</dt>
              <dd>{binding.generation}</dd>
            </div>
            <div>
              <dt>Root thread</dt>
              <dd>{binding.rootThreadId}</dd>
            </div>
            <div>
              <dt>Thread</dt>
              <dd>{binding.threadId}</dd>
            </div>
            <div>
              <dt>Turn</dt>
              <dd>{binding.turnId}</dd>
            </div>
          </dl>
          <EvidenceList evidence={binding.evidence} />
        </>
      ) : (
        <p>No native binding recorded.</p>
      )}
    </AuditField>
  );
}

function AuditValues({ values }: { values: string[] }) {
  return (
    <ul className="audit-values">
      {values.map((value) => (
        <li key={value}>
          <code>{value}</code>
        </li>
      ))}
    </ul>
  );
}

function ReferenceList({ refs, empty }: { refs: string[]; empty: string }) {
  if (!refs.length) return <p>{empty}</p>;
  return (
    <ul className="evidence-list">
      {refs.map((ref) => (
        <li key={ref}>
          <EvidenceReference value={ref} />
        </li>
      ))}
    </ul>
  );
}

function EvidenceList({ evidence }: { evidence: Evidence[] }) {
  if (!evidence.length) return <p>None recorded.</p>;
  return (
    <ul className="evidence-list">
      {evidence.map((item) => (
        <li key={`${item.ref}:${item.note ?? ""}`}>
          <EvidenceReference value={item.ref} />
          {item.note ? <span>{item.note}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function EvidenceReference({ value }: { value: string }) {
  const href = safeHttpHref(value);
  return href ? (
    <a href={href} target="_blank" rel="noreferrer">
      {value}
    </a>
  ) : (
    <code>{value}</code>
  );
}

function safeHttpHref(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function reviewLabel(result: Result): string {
  const decision = result.reviews.at(-1)?.decision;
  if (decision === "changes_required") return "Changes required";
  if (decision !== "accepted") return "Acceptance pending";
  return result.presentations.length ? "Presented" : "Presentation pending";
}

function resultStateText(result: Result): string {
  if (result.dispatchResolution === "not_dispatched") return "Not dispatched";
  if (result.dispatchResolution === "dispatch_failed") return "Dispatch failed";
  return resultCopy[result.outcome];
}

function resultTone(result: Result): "positive" | "warning" | "negative" | "neutral" {
  if (result.outcome === "failed" || result.outcome === "interrupted") return "negative";
  if (result.reviews.at(-1)?.decision === "changes_required" || result.outcome === "partial")
    return "warning";
  return result.reviews.at(-1)?.decision === "accepted" ? "positive" : "neutral";
}

function dispositionTone(
  disposition: Work["disposition"],
): "positive" | "warning" | "negative" | "neutral" {
  if (disposition === "completed") return "positive";
  if (disposition === "waiting" || disposition === "paused") return "warning";
  if (disposition === "cancelled") return "negative";
  return "neutral";
}

function executionTone(
  execution?: AssignmentView["execution"],
): "positive" | "warning" | "negative" | "neutral" {
  if (execution === "working" || execution === "completed") return "positive";
  if (execution === "failed" || execution === "interrupted" || execution === "dispatch_failed")
    return "negative";
  if (
    execution === "waiting" ||
    execution === "dispatch_unknown" ||
    execution === "unavailable" ||
    execution === "not_observed" ||
    execution === "different_turn"
  )
    return "warning";
  return "neutral";
}

function threadState(thread: ThreadRow): {
  label: string;
  tone: "positive" | "warning" | "negative" | "neutral";
} {
  if (thread.activeFlags.includes("waitingOnApproval"))
    return { label: "Waiting approval", tone: "warning" };
  if (thread.activeFlags.includes("waitingOnUserInput"))
    return { label: "Waiting input", tone: "warning" };
  if (thread.status === "systemError" || thread.turn?.status === "failed")
    return { label: "Failed", tone: "negative" };
  if (thread.status === "active" || thread.turn?.status === "inProgress")
    return { label: "Working", tone: "positive" };
  if (thread.turn?.status === "completed") return { label: "Turn completed", tone: "neutral" };
  if (thread.turn?.status === "interrupted") return { label: "Interrupted", tone: "negative" };
  if (thread.status === "idle") return { label: "Idle", tone: "neutral" };
  return { label: "Unknown", tone: "neutral" };
}

function observationHealth(snapshot: HudSnapshot, error?: string) {
  if (error)
    return {
      label: "Refresh unavailable",
      notice:
        "The latest refresh failed. Showing the last successful snapshot; no newer state is inferred.",
      tone: "warning" as const,
    };
  if (snapshot.native.availability === "unavailable")
    return {
      label: "Native unavailable",
      notice:
        "Native observation is unavailable. Durable work remains current; execution counts and thread state are unknown.",
      tone: "warning" as const,
    };
  if (snapshot.native.inventory !== "ready")
    return {
      label: `${snapshot.native.inventory} inventory`,
      notice: `Native inventory is ${snapshot.native.inventory}. Counts are observed minimums and missing threads remain unknown.`,
      tone: "warning" as const,
    };
  if (Date.now() - new Date(snapshot.observedAt).valueOf() > 5_000)
    return {
      label: "Snapshot stale",
      notice: "The browser has not received a fresh snapshot. Showing the last observation.",
      tone: "warning" as const,
    };
  return { label: "Observed", notice: "", tone: "positive" as const };
}

function depthStyle(depth: number) {
  return { "--depth": Math.min(depth, 10) } as React.CSSProperties;
}

function ancestryCopy(ancestry: "missing-parent" | "unresolved") {
  return ancestry === "missing-parent" ? "Parent not loaded" : "Ancestry unresolved";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatRecency(value: string): string {
  const age = Math.max(0, Date.now() - new Date(value).valueOf());
  if (!Number.isFinite(age)) return "unknown time";
  if (age < 5_000) return "just now";
  if (age < 60_000) return `${Math.floor(age / 1_000)}s ago`;
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  return `${Math.floor(age / 3_600_000)}h ago`;
}

function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 6)}…${id.slice(-5)}` : id;
}
