import { Transcript, TranscriptComposer } from "@agentchats/transcript/react";
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type OptimisticSubmission,
  observed,
  optimisticMessages,
  optimisticQueue,
} from "./optimistic.ts";
import { reconcileView } from "./reconcile-view.ts";
import type { AgentControlsView, LiveView } from "./types.ts";

const copy = {
  offline: "No agent voice server to connect to.",
  waiting: "Waiting for a call.",
  connecting: "Connecting to AgentVoice…",
  unavailable: "AgentVoice is unavailable. Reconnecting…",
  live: "",
};

export function App() {
  const agentDock = useRef<HTMLDivElement>(null);
  const [dockHeight, setDockHeight] = useState(0);
  useLayoutEffect(() => {
    const dock = agentDock.current;
    if (!dock) return;
    const measure = () => setDockHeight(dock.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    return () => observer.disconnect();
  }, []);
  const [readRevision, setReadRevision] = useState(0);
  const [view, setView] = useState<LiveView>({
    phase: "connecting",
    id: "connecting",
    voice: [],
    agent: [],
  });
  const latestView = useRef(view);
  latestView.current = view;
  const [submissions, setSubmissions] = useState<OptimisticSubmission[]>([]);
  const beginSubmission = useCallback((row: Omit<OptimisticSubmission, "anchor" | "state">) => {
    setSubmissions((current) => [
      ...current,
      {
        ...row,
        anchor: optimisticMessages(
          latestView.current.agent,
          current.filter((entry) => entry.viewId === row.viewId),
        ).at(-1)?.id,
        state: "pending",
      },
    ]);
  }, []);
  const settleSubmission = useCallback(
    (id: string, state: OptimisticSubmission["state"] | "rejected") => {
      setSubmissions((current) =>
        state === "rejected"
          ? current.filter((row) => row.id !== id)
          : current.map((row) => (row.id === id ? { ...row, state } : row)),
      );
    },
    [],
  );
  const submissionObserved = useCallback(
    (viewId: string, id: string) =>
      latestView.current.id === viewId && observed(latestView.current, id),
    [],
  );
  const commandAccepted = useCallback(() => setReadRevision((revision) => revision + 1), []);
  // Transcript rendering can yield to typing; controls use the current view immediately.
  const renderedView = useDeferredValue(view);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Acknowledged commands restart polling immediately to refresh native controls.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let previous = "";
    const read = async () => {
      try {
        const response = await fetch("/api/live", {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Unavailable");
        const text = await response.text();
        if (!controller.signal.aborted && text !== previous) {
          const next: LiveView = JSON.parse(text);
          setView((current) => reconcileView(current, next));
          previous = text;
        }
      } catch {
        if (!controller.signal.aborted) {
          previous = "";
          setView((current) => ({ ...current, phase: "unavailable" }));
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(read, 1000);
      }
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [readRevision]);

  const holding =
    (view.phase === "live" && (view.agentHistoryLoading || view.voiceHistoryLoading)) ||
    (view.phase !== "live" && view.agent.length === 0 && view.voice.length === 0);
  const showStatus = holding || view.phase !== "live";
  // Initial reveal and incarnation replacement stay atomic; only subsequent
  // history updates may lag behind the immediately available input controls.
  const transcriptView =
    renderedView.id !== view.id ||
    renderedView.agentHistoryLoading ||
    renderedView.voiceHistoryLoading
      ? view
      : renderedView;
  const localSubmissions = useMemo(
    () => submissions.filter((row) => row.viewId === view.id),
    [submissions, view.id],
  );
  const displayedAgent = useMemo(
    () => optimisticMessages(transcriptView.agent, localSubmissions),
    [transcriptView.agent, localSubmissions],
  );
  const observedSubmissionKey = JSON.stringify([
    ...view.agent.filter((row) => row.id.startsWith("client:")).map((row) => row.id.slice(7)),
    ...(view.agentControls?.queue.map((row) => row.id) ?? []),
  ]);
  // Streaming text must not invalidate the input boundary when exact acknowledgments are unchanged.
  const observedSubmissionIds = useMemo(
    () => JSON.parse(observedSubmissionKey) as string[],
    [observedSubmissionKey],
  );
  const displayedControls = useMemo(() => {
    const controls = view.agentControls;
    if (!controls) return undefined;
    const queue = optimisticQueue(controls.queue, localSubmissions, view.agent);
    return queue === controls.queue ? controls : { ...controls, queue };
  }, [view.agentControls, localSubmissions, view.agent]);
  // Keep placeholders until the rendered native snapshot contains their exact identity.
  useEffect(() => {
    setSubmissions((current) => {
      const next = current.filter(
        (row) =>
          row.viewId === view.id &&
          !observed({ ...transcriptView, agentControls: view.agentControls }, row.id),
      );
      return next.length === current.length ? current : next;
    });
  }, [transcriptView, view.id, view.agentControls]);
  return (
    <main aria-label="AgentVoice live transcripts" className="live-view">
      {showStatus ? (
        <p className={`view-status${holding ? "" : " view-status--notice"}`} role="status">
          {holding && (view.phase === "live" || view.phase === "connecting")
            ? "Loading conversation…"
            : copy[view.phase]}
        </p>
      ) : null}
      <div className="dual-pane" hidden={!!holding}>
        {(["agent", "voice"] as const).map((lane) => (
          <section className="lane" key={lane} aria-labelledby={`${lane}-heading`}>
            <h1 id={`${lane}-heading`}>{lane === "voice" ? "Voice" : "Agent"}</h1>
            <TranscriptLane
              lane={lane}
              viewId={transcriptView.id}
              phase={transcriptView.phase}
              notice={transcriptView[`${lane}Notice`]}
              messages={lane === "agent" ? displayedAgent : transcriptView.voice}
              holding={!!holding}
            />
            <div
              ref={lane === "agent" ? agentDock : undefined}
              className={lane === "agent" ? "agent-dock" : "voice-dock"}
              style={lane === "voice" ? { height: dockHeight } : undefined}
              aria-hidden={lane === "voice" ? true : undefined}
              hidden={lane === "voice" && dockHeight === 0}
            >
              {lane === "agent" && displayedControls ? (
                <AgentInput
                  viewId={view.id}
                  persistenceScope={view.persistenceScope}
                  observedSubmissionIds={observedSubmissionIds}
                  controls={displayedControls}
                  disabled={view.phase !== "live" || !displayedControls.available}
                  onAccepted={commandAccepted}
                  onBegin={beginSubmission}
                  onSettle={settleSubmission}
                  isObserved={submissionObserved}
                />
              ) : null}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}

const TranscriptLane = memo(function TranscriptLane({
  lane,
  viewId,
  phase,
  notice,
  messages,
  holding,
}: {
  lane: "agent" | "voice";
  viewId: string;
  phase: LiveView["phase"];
  notice?: string;
  messages: LiveView["agent"];
  holding: boolean;
}) {
  return (
    <Transcript
      transcriptId={`${viewId}:${lane}`}
      messages={messages}
      // Reveal both initial batches at the end; later refreshes retain each lane's scroller.
      loading={!!holding}
      detail="full"
      windowed
      showJumpToLatest
      aria-label={`${lane === "voice" ? "Voice" : "Agent"} transcript`}
      header={
        notice ? (
          <p className="transcript-notice" role="status">
            {notice}
          </p>
        ) : null
      }
      empty={
        phase === "live" && !notice ? (
          <p className="transcript-notice">
            {lane === "voice" ? "Waiting for speech." : "Waiting for agent messages."}
          </p>
        ) : null
      }
    />
  );
});

const AgentInput = memo(function AgentInput({
  viewId,
  persistenceScope,
  observedSubmissionIds,
  controls,
  disabled,
  onAccepted,
  onBegin,
  onSettle,
  isObserved,
}: {
  viewId: string;
  persistenceScope?: string;
  observedSubmissionIds: string[];
  controls: AgentControlsView;
  disabled: boolean;
  onAccepted: () => void;
  onBegin: (row: Omit<OptimisticSubmission, "anchor" | "state">) => void;
  onSettle: (id: string, state: OptimisticSubmission["state"] | "rejected") => void;
  isObserved: (viewId: string, id: string) => boolean;
}) {
  const agentCommand = async (
    fields: object,
    submission?: { clientId: string; mode: "send" | "steer" | "queue" },
  ) => {
    const requestId = submission?.clientId ?? crypto.randomUUID();
    if (submission)
      onBegin({
        id: requestId,
        viewId,
        text: (fields as { text: string }).text,
        action: submission.mode,
      });
    let response: Response;
    try {
      response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ viewId, requestId, ...fields }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      if (submission && isObserved(viewId, requestId)) {
        onAccepted();
        return;
      }
      if (submission) onSettle(requestId, "unknown");
      throw new Error("Delivery is unknown. Check the transcript and queue before trying again.");
    }
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      if (submission && isObserved(viewId, requestId)) {
        onAccepted();
        return;
      }
      if (submission)
        onSettle(
          requestId,
          body?.delivery === "unknown" || response.status >= 500 ? "unknown" : "rejected",
        );
      throw new Error(body?.error ?? "Agent request failed. Check the current call.");
    }
    if (submission) onSettle(requestId, "accepted");
    onAccepted();
  };
  return (
    <>
      {controls.notice ? (
        <p className="transcript-notice" role="status">
          {controls.notice}
        </p>
      ) : null}
      <TranscriptComposer
        transcriptId={viewId}
        persistenceScope={persistenceScope}
        observedSubmissionIds={observedSubmissionIds}
        alwaysShowSend
        optimisticSubmit
        active={controls.active}
        pending={controls.pending}
        stopping={controls.stopping}
        actionsDisabled={disabled}
        aria-label="Message Agent"
        placeholder="Message Agent…"
        queue={controls.queue}
        onSend={(text, submission) => agentCommand({ action: "send", text }, submission)}
        onSteer={(text, submission) => agentCommand({ action: "steer", text }, submission)}
        onQueue={(text, submission) => agentCommand({ action: "queue", text }, submission)}
        onSteerQueued={(id) => agentCommand({ action: "steerQueued", id })}
        onResumeQueued={(id) => agentCommand({ action: "resume", id })}
        onRemoveQueued={(id) => agentCommand({ action: "remove", id })}
        onEditQueued={(id, text) => agentCommand({ action: "edit", id, text })}
        onEditingQueuedChange={(id) => agentCommand({ action: "editing", id })}
      />
    </>
  );
});
