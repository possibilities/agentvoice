import { Transcript, TranscriptComposer } from "@agentchats/transcript/react";
import { useEffect, useState } from "react";
import type { LiveView } from "./types.ts";

const copy = {
  offline: "No agent voice server to connect to.",
  waiting: "Waiting for a call.",
  connecting: "Connecting to AgentVoice…",
  unavailable: "AgentVoice is unavailable. Reconnecting…",
  live: "",
};

export function App() {
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
  };
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
  }, []);

  return (
    <main aria-label="AgentVoice live transcripts" className="dual-pane">
      {(["voice", "agent"] as const).map((lane) => (
        <section className="lane" key={lane} aria-labelledby={`${lane}-heading`}>
          <h1 id={`${lane}-heading`}>{lane === "voice" ? "Voice" : "Agent"}</h1>
          {view.phase !== "live" ? (
            <p className="connection" role="status">
              {copy[view.phase]}
            </p>
          ) : null}
          <Transcript
            transcriptId={`${view.id}:${lane}`}
            messages={view[lane]}
            // The first Agent history batch resets to the end; Voice and later refreshes keep their scroller.
            loading={lane === "agent" && view.agentHistoryLoading}
            detail="full"
            showJumpToLatest
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
                onInterrupt={() => agentCommand({ action: "interrupt" })}
                onSteerQueued={(id) => agentCommand({ action: "steerQueued", id })}
                onResumeQueued={(id) => agentCommand({ action: "resume", id })}
                onRemoveQueued={(id) => agentCommand({ action: "remove", id })}
                onEditQueued={(id, text) => agentCommand({ action: "edit", id, text })}
                onEditingQueuedChange={(id) => agentCommand({ action: "editing", id })}
              />
            </>
          ) : null}
        </section>
      ))}
    </main>
  );
}
