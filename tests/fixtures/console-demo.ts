/** Real-terminal harness for the actual host/TUI; fake media and no inference. */
import { runConsoleHost } from "../../src/console/host.ts";
import { parseArgs } from "../../src/main.ts";
import { hostHarness } from "./host-harness.ts";

const h = hostHarness();
const { fast } = parseArgs(process.argv.slice(2));
h.native.tiers = fast !== undefined;
try {
  await runConsoleHost(h.config, "terminal-probe", {
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
  await h.cleanup();
}
