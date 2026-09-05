/** Real-terminal harness for the actual host/TUI; fake media and no inference. */
import { runConsoleHost } from "../../src/console/host.ts";
import { hostHarness } from "./host-harness.ts";

const h = hostHarness();
try {
  await runConsoleHost(h.config, "terminal-probe", {
    mediaFactory: h.mediaFactory,
    runtime: h.runtimeOptions,
  });
  if (
    h.native.closes !== 1 ||
    !h.calls.includes("audio:stop") ||
    !h.calls.includes("transport:stop")
  )
    throw new Error("foreground cleanup incomplete");
  console.log(`foreground cleanup: PASS; conversations created: ${h.native.threads.length}`);
} finally {
  await h.cleanup();
}
