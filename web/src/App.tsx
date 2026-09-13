import { Transcript, TranscriptComposer } from "@agentchats/transcript/react";
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LiveView } from "./types.ts";

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
  const agentCommand = async (fields: object) => {
    let response: Response;
    try {
      response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ viewId: view.id, requestId: crypto.randomUUID(), ...fields }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error("Delivery is unknown. Check the transcript and queue before trying again.");
    }
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      throw new Error(body?.error ?? "Agent request failed. Check the current call.");
    }
    setReadRevision((revision) => revision + 1);
  };
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
          setView(JSON.parse(text));
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
    view.phase === "connecting" ||
    (view.phase === "live" && (view.agentHistoryLoading || view.voiceHistoryLoading)) ||
    (view.phase !== "live" && view.agent.length === 0 && view.voice.length === 0);
  const showStatus = holding || view.phase !== "live";
  return (
    <main
      aria-label="AgentVoice live transcripts"
      className="live-view"
      style={{ "--dock-height": `${dockHeight}px` } as CSSProperties}
    >
      {showStatus ? (
        <p className={`view-status${holding ? "" : " view-status--notice"}`} role="status">
          {view.phase === "live" || view.phase === "connecting"
            ? "Loading conversation…"
            : copy[view.phase]}
        </p>
      ) : null}
      <div className="dual-pane" hidden={!!holding}>
        {(["agent", "voice"] as const).map((lane) => (
          <section className="lane" key={lane} aria-labelledby={`${lane}-heading`}>
            <h1 id={`${lane}-heading`}>{lane === "voice" ? "Voice" : "Agent"}</h1>
            <Transcript
              transcriptId={`${view.id}:${lane}`}
              messages={view[lane]}
              // Reveal both initial batches at the end; later refreshes retain each lane's scroller.
              loading={!!holding}
              detail="full"
              showJumpToLatest
              footer={<div className="transcript-dock-clearance" aria-hidden="true" />}
              aria-label={`${lane === "voice" ? "Voice" : "Agent"} transcript`}
              header={
                view[`${lane}Notice`] ? (
                  <p className="transcript-notice" role="status">
                    {view[`${lane}Notice`]}
                  </p>
                ) : null
              }
              empty={
                view.phase === "live" && !view[`${lane}Notice`] ? (
                  <p className="transcript-notice">
                    {lane === "voice" ? "Waiting for speech." : "Waiting for agent messages."}
                  </p>
                ) : null
              }
            />
            <div
              ref={lane === "agent" ? agentDock : undefined}
              className={lane === "agent" ? "agent-dock" : "voice-dock"}
              style={lane === "voice" ? { height: dockHeight } : undefined}
              aria-hidden={lane === "voice" ? true : undefined}
              hidden={lane === "voice" && dockHeight === 0}
            >
              {lane === "agent" && view.agentControls ? (
                <>
                  {view.agentControls.notice ? (
                    <p className="transcript-notice" role="status">
                      {view.agentControls.notice}
                    </p>
                  ) : null}
                  <TranscriptComposer
                    transcriptId={view.id}
                    active={view.agentControls.active}
                    pending={view.agentControls.pending}
                    stopping={view.agentControls.stopping}
                    disabled={view.phase !== "live" || !view.agentControls.available}
                    aria-label="Message Agent"
                    placeholder="Message Agent…"
                    queue={view.agentControls.queue}
                    onSend={(text) => agentCommand({ action: "send", text })}
                    onSteer={(text) => agentCommand({ action: "steer", text })}
                    onQueue={(text) => agentCommand({ action: "queue", text })}
                    onSteerQueued={(id) => agentCommand({ action: "steerQueued", id })}
                    onResumeQueued={(id) => agentCommand({ action: "resume", id })}
                    onRemoveQueued={(id) => agentCommand({ action: "remove", id })}
                    onEditQueued={(id, text) => agentCommand({ action: "edit", id, text })}
                    onEditingQueuedChange={(id) => agentCommand({ action: "editing", id })}
                  />
                </>
              ) : null}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
