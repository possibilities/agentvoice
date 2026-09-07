/** Real-terminal harness for the actual host/TUI; fake media and no inference. */

import { runConsoleHost } from "../../src/console/host.ts";
import { createVoiceTui } from "../../src/console/tui.ts";
import { parseArgs } from "../../src/main.ts";
import { hostHarness } from "./host-harness.ts";

const h = hostHarness();
const { fast } = parseArgs(process.argv.slice(2));
h.native.tiers = fast !== undefined;
// Fixture-only notice injection for real-PTY checks, never a production switch.
const refusalTimer =
  process.env["AGENTVOICE_DEMO_REFUSAL"] === "1"
    ? setInterval(() => {
        h.native.options?.onRefusal?.(
          "Refused tool/requestUserInput: AgentVoice has no approval/input UI. Full access does not grant connector consent or answer tool questions. Use a supported Codex client for required interaction.",
        );
      }, 250)
    : undefined;
try {
  await runConsoleHost(h.config, "terminal-probe", {
    observe: createVoiceTui,
    mediaFactory: h.mediaFactory,
    runtime: { ...h.runtimeOptions, fast },
  });
  if (
    h.native.closes !== 1 ||
    !h.calls.includes("audio:stop") ||
    !h.calls.includes("transport:stop")
  )
    throw new Error("foreground cleanup incomplete");
  console.log(`foreground cleanup: PASS; conversations created: ${h.native.threads.length}`);
} finally {
  clearInterval(refusalTimer);
  await h.cleanup();
}
