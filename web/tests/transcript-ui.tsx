import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { TranscriptMessage } from "../src/transcript-ui/transcript/index.ts";
import { Transcript } from "../src/transcript-ui/transcript/react.ts";
import "../src/transcript-ui/styles.css";

const initial: TranscriptMessage[] = [
  { id: "initial", role: "assistant", content: "Initial message", status: "complete" },
];

function Fixture() {
  const [messages, setMessages] = useState(initial);
  const [detail, setDetail] = useState<"messages" | "full">("messages");
  const [windowed, setWindowed] = useState(false);
  Object.assign(window, { transcriptFixture: { setMessages, setDetail, setWindowed } });
  return (
    <main style={{ height: 600, display: "flex", flexDirection: "column" }}>
      <Transcript
        transcriptId="component-fixture"
        messages={messages}
        detail={detail}
        windowed={windowed}
        aria-label="Component transcript"
      />
    </main>
  );
}

createRoot(document.getElementById("transcript-fixture")!).render(<Fixture />);
