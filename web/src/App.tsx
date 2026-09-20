import {
  type MouseEvent,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { LocalImageAttachment } from "../../src/attachment/image-contract";
import { loadDocument } from "./document-loader.ts";
import { kioskPersistenceInstanceId } from "./kiosk-context.ts";
import {
  type OptimisticSubmission,
  observed,
  optimisticMessages,
  optimisticQueue,
} from "./optimistic.ts";
import { readLiveView } from "./read-live-view.ts";
import { reconcileView, transcriptPresentationView } from "./reconcile-view.ts";
import type { SaveClipboardImage } from "./transcript-ui/transcript/composer-images";
import {
  DocumentViewerProvider,
  Transcript,
  TranscriptComposer,
} from "./transcript-ui/transcript/react.ts";
import type { AgentControlsView, LiveView } from "./types.ts";

const copy = {
  offline: "No agent voice server to connect to.",
  empty: "AgentVoice is ready. Start a client to begin a workspace session.",
  connecting: "Connecting to AgentVoice…",
  unavailable: "Agent transcript is reconnecting…",
};

const webReaderUnavailable =
  "Agent input is unavailable because the web reader disconnected. Your draft is still editable.";

const interactiveComposerTarget =
  'a[href], button, input, textarea, select, option, label, summary, [contenteditable="true"], [role="button"], [role="checkbox"], [role="combobox"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="radio"], [role="slider"], [role="spinbutton"], [role="switch"], [role="tab"], [role="textbox"], [tabindex]:not([tabindex="-1"])';

function focusComposerFromDock(event: MouseEvent<HTMLDivElement>) {
  if (!(event.target instanceof Element) || event.target.closest(interactiveComposerTarget)) return;
  event.currentTarget.querySelector<HTMLTextAreaElement>("textarea")?.focus();
}

export function App() {
  const persistenceInstanceId = kioskPersistenceInstanceId();
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
    let etag: string | undefined;
    const read = async () => {
      try {
        const result = await readLiveView(controller.signal, etag);
        etag = result.etag;
        if (!controller.signal.aborted && !result.unchanged) {
          setView((current) => reconcileView(current, result.view));
        }
      } catch {
        if (!controller.signal.aborted) {
          // The unavailable projection is local. Force the authoritative body
          // on recovery instead of accepting a 304 against hidden old state.
          etag = undefined;
          setView((current) => ({
            ...current,
            phase: "unavailable",
            agentNotice: "Agent transcript disconnected. Reconnecting…",
            agentControls: current.agentControls
              ? {
                  ...current.agentControls,
                  available: false,
                  inputUnavailableReason: webReaderUnavailable,
                }
              : undefined,
          }));
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

  const hasSession = !!view.persistenceScope && !!view.agentControls;
  const holding =
    (hasSession && view.agentHistoryLoading) || (!hasSession && view.agent.length === 0);
  const statusText =
    holding && hasSession
      ? "Loading conversation…"
      : view.phase === "live" || view.phase === "detached"
        ? ""
        : copy[view.phase];
  // Initial reveal and incarnation replacement stay atomic; only subsequent
  // history updates may lag behind the immediately available input controls.
  const transcriptView = transcriptPresentationView(view, renderedView);
  const localSubmissions = useMemo(
    () => submissions.filter((row) => row.viewId === view.id),
    [submissions, view.id],
  );
  const displayedAgent = useMemo(
    () => optimisticMessages(transcriptView.agent, localSubmissions),
    [transcriptView.agent, localSubmissions],
  );
  const observedSubmissionKey = JSON.stringify([
    ...view.agent
      .filter((row) => row.id.startsWith("client:") && row.status === "complete")
      .map((row) => row.id.slice(7)),
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
    <DocumentViewerProvider load={loadDocument} resetKey={view.id}>
      <main aria-label="Live Agent transcript" className="live-view">
        <div className="transcript-pane">
          {statusText ? (
            <p className="transcript-status" role="status">
              {statusText}
            </p>
          ) : null}
          <section className="lane" data-lane="agent" aria-label="Agent" hidden={!!holding}>
            <TranscriptLane
              viewId={transcriptView.id}
              phase={transcriptView.phase}
              notice={transcriptView.agentNotice}
              messages={displayedAgent}
              holding={!!holding}
            />
            {/* biome-ignore lint/a11y: Blank dock clicks focus the native textarea; keyboard users focus it directly. */}
            <div className="agent-dock" onClick={focusComposerFromDock}>
              {displayedControls ? (
                <AgentInput
                  viewId={view.id}
                  persistenceScope={view.persistenceScope}
                  persistenceInstanceId={persistenceInstanceId}
                  observedSubmissionIds={observedSubmissionIds}
                  controls={displayedControls}
                  disabled={
                    (view.phase !== "live" && view.phase !== "detached") ||
                    !displayedControls.available
                  }
                  onAccepted={commandAccepted}
                  onBegin={beginSubmission}
                  onSettle={settleSubmission}
                  isObserved={submissionObserved}
                />
              ) : null}
            </div>
          </section>
        </div>
      </main>
    </DocumentViewerProvider>
  );
}

const TranscriptLane = memo(function TranscriptLane({
  viewId,
  phase,
  notice,
  messages,
  holding,
}: {
  viewId: string;
  phase: LiveView["phase"];
  notice?: string;
  messages: LiveView["agent"];
  holding: boolean;
}) {
  const empty = messages.length === 0 && !holding && phase !== "offline" && phase !== "empty";
  return (
    <div className="transcript-lane">
      <Transcript
        transcriptId={`${viewId}:agent`}
        messages={messages}
        // Reveal the initial Agent batch atomically; later refreshes retain the scroller.
        loading={!!holding}
        windowed
        showJumpToLatest
        aria-label="Agent transcript"
        header={
          notice && !empty ? (
            <p className="transcript-notice" role="status">
              {notice}
            </p>
          ) : null
        }
      />
      {empty ? (
        <div className="transcript-empty">
          <div className="transcript-empty__copy">
            <h2>No agent messages yet</h2>
          </div>
        </div>
      ) : null}
    </div>
  );
});

const AgentInput = memo(function AgentInput({
  viewId,
  persistenceScope,
  persistenceInstanceId,
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
  persistenceInstanceId?: string;
  observedSubmissionIds: string[];
  controls: AgentControlsView;
  disabled: boolean;
  onAccepted: () => void;
  onBegin: (row: Omit<OptimisticSubmission, "anchor" | "state">) => void;
  onSettle: (id: string, state: OptimisticSubmission["state"] | "rejected") => void;
  isObserved: (viewId: string, id: string) => boolean;
}) {
  const saveClipboardImage = useCallback<SaveClipboardImage>(
    async (file, imageId, signal) => {
      let response: Response;
      try {
        response = await fetch("/api/clipboard-image", {
          method: "POST",
          headers: {
            "Content-Type": file.type,
            "X-AgentVoice-View-Id": viewId,
            "X-AgentVoice-Image-Id": imageId,
          },
          body: file,
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        });
      } catch {
        throw new Error(
          "Image save could not be confirmed. Paste it again when connected. Your draft has been kept.",
        );
      }
      const result = await response.json().catch(() => undefined);
      if (!response.ok || typeof result?.path !== "string" || !result.path.startsWith("/"))
        throw new Error(result?.error ?? "Clipboard image could not be saved. Paste it again.");
      return { path: result.path };
    },
    [viewId],
  );

  const agentCommand = async (
    fields: object,
    submission?: {
      clientId: string;
      mode: "send" | "steer" | "queue";
      images?: LocalImageAttachment[];
    },
  ) => {
    const requestId = submission?.clientId ?? crypto.randomUUID();
    if (submission)
      onBegin({
        id: requestId,
        viewId,
        text: (fields as { text: string }).text,
        images: submission.images,
        action: submission.mode,
      });
    let response: Response;
    try {
      response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          viewId,
          requestId,
          ...fields,
          ...(submission?.images ? { images: submission.images } : {}),
        }),
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
      {controls.inputUnavailableReason ? (
        <p className="transcript-notice transcript-input-notice" role="status">
          {controls.inputUnavailableReason}
        </p>
      ) : null}
      <TranscriptComposer
        transcriptId={viewId}
        persistenceScope={persistenceScope}
        persistenceInstanceId={persistenceInstanceId}
        observedSubmissionIds={observedSubmissionIds}
        saveClipboardImage={saveClipboardImage}
        optimisticSubmit
        reachable={!disabled}
        active={controls.active}
        pending={controls.pending}
        stopping={controls.stopping}
        actionsDisabled={disabled}
        aria-label="Message Agent"
        placeholder="Message Agent…"
        queue={controls.queue}
        onSend={(text, submission) => agentCommand({ action: "send", text }, submission)}
        onSteer={(text, submission) => agentCommand({ action: "steer", text }, submission)}
        onRemoveQueued={(id) => agentCommand({ action: "remove", id })}
      />
    </>
  );
});
