import {
  type MouseEvent,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
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
import { type PanePreference, readPanePreference, savePanePreference } from "./pane-preferences.ts";
import { readLiveView } from "./read-live-view.ts";
import { reconcileView, transcriptPresentationView } from "./reconcile-view.ts";
import type { SaveClipboardImage } from "./transcript-ui/transcript/composer-images";
import type { ListReferenceFiles } from "./transcript-ui/transcript/file-references";
import {
  DocumentViewerProvider,
  Transcript,
  TranscriptComposer,
} from "./transcript-ui/transcript/react.ts";
import type { AgentControlsView, LiveView } from "./types.ts";

const listReferenceFiles: ListReferenceFiles = async (request, signal) => {
  const response = await fetch("/api/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Files could not be listed.");
  return result;
};

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

function preserveNativeBrowserFind(event: KeyboardEvent) {
  const onePrimaryModifier = event.metaKey !== event.ctrlKey;
  if (event.key.toLowerCase() !== "f" || !onePrimaryModifier || event.altKey || event.shiftKey)
    return;
  // Prevent later page handlers from cancelling the browser command. Stopping
  // propagation does not cancel the browser's native find action.
  event.stopImmediatePropagation();
}

export function App() {
  useLayoutEffect(() => {
    window.addEventListener("keydown", preserveNativeBrowserFind, { capture: true });
    return () =>
      window.removeEventListener("keydown", preserveNativeBrowserFind, { capture: true });
  }, []);
  const persistenceInstanceId = kioskPersistenceInstanceId();
  const [panePreference, setPanePreference] = useState(() =>
    readPanePreference(persistenceInstanceId),
  );
  const [preferenceSaved, setPreferenceSaved] = useState(true);
  const choosePane = (next: PanePreference) => {
    setPreferenceSaved(savePanePreference(next, persistenceInstanceId));
    setPanePreference(next);
  };
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
    (hasSession && (view.agentHistoryLoading || view.voiceHistoryLoading)) ||
    (!hasSession && view.agent.length === 0 && view.voice.length === 0);
  const statusText = !preferenceSaved
    ? "View saved for this visit only."
    : holding && hasSession
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
    <DocumentViewerProvider load={loadDocument} resetKey={view.id}>
      <main aria-label="AgentVoice live transcripts" className="live-view">
        <header className="app-header">
          <h1 className="app-brand">AgentVoice</h1>
          <p className="app-status" data-visible={statusText ? true : undefined} role="status">
            {statusText}
          </p>
          <fieldset className="pane-switch" aria-label="Transcript view">
            {(["agent", "voice", "both"] as const).map((mode) => (
              <button
                className="pane-switch-button"
                key={mode}
                type="button"
                aria-pressed={panePreference === mode}
                onClick={() => choosePane(mode)}
              >
                {mode === "agent" ? "Agent" : mode === "voice" ? "Voice" : "Both"}
              </button>
            ))}
          </fieldset>
        </header>
        <div className="dual-pane" data-panes={panePreference} hidden={!!holding}>
          {(["agent", "voice"] as const).map((lane) => (
            <section
              className="lane"
              key={lane}
              data-lane={lane}
              data-concealed={(panePreference !== "both" && panePreference !== lane) || undefined}
              inert={panePreference !== "both" && panePreference !== lane}
              aria-hidden={(panePreference !== "both" && panePreference !== lane) || undefined}
              aria-label={lane === "voice" ? "Voice" : "Agent"}
            >
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
                onClick={lane === "agent" ? focusComposerFromDock : undefined}
                style={lane === "voice" ? { height: dockHeight } : undefined}
                aria-hidden={lane === "voice" ? true : undefined}
                hidden={lane === "voice" && (panePreference !== "both" || dockHeight === 0)}
              >
                {lane === "agent" && displayedControls ? (
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
          ))}
        </div>
      </main>
    </DocumentViewerProvider>
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
  const empty = messages.length === 0 && !holding && phase !== "offline" && phase !== "empty";
  return (
    <div className="transcript-lane">
      <Transcript
        transcriptId={`${viewId}:${lane}`}
        messages={messages}
        // Reveal both initial batches at the end; later refreshes retain each lane's scroller.
        loading={!!holding}
        windowed
        showJumpToLatest
        aria-label={`${lane === "voice" ? "Voice" : "Agent"} transcript`}
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
            <h2>{lane === "voice" ? "No voice text yet" : "No agent messages yet"}</h2>
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
        listReferenceFiles={listReferenceFiles}
        alwaysShowSend
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
        onQueue={(text, submission) => agentCommand({ action: "queue", text }, submission)}
        onSteerQueued={(id) => agentCommand({ action: "steerQueued", id })}
        onResumeQueued={(id) => agentCommand({ action: "resume", id })}
        onRemoveQueued={(id) => agentCommand({ action: "remove", id })}
        onEditQueued={(id, text, images) => agentCommand({ action: "edit", id, text, images })}
        onEditingQueuedChange={(id) => agentCommand({ action: "editing", id })}
      />
    </>
  );
});
