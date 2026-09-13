import { Transcript } from "@agentchats/transcript/react";
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
            detail="full"
            showJumpToLatest={false}
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
        </section>
      ))}
    </main>
  );
}
