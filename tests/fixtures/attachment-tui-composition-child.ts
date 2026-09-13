/** Child apps for the isolated attachment TUI composition probe; no native media. */
import { runAttachment } from "../../src/attachment/launcher.ts";
import { connectFrontend } from "../../src/frontend/client.ts";
import { frontendSocketPath } from "../../src/frontend/protocol.ts";

const root = process.env["AGENTVOICE_TUI_PROBE_ROOT"];
if (!root) throw new Error("Missing attachment TUI probe root");
const stateDir = `${root}/state/agentvoice`;
const target = process.argv[2];

if (target === "client") {
  const client = await connectFrontend(
    frontendSocketPath(stateDir),
    () => {},
    process.env["AGENTVOICE_CLIENT_ID"],
  );
  console.log("POINTER FRONTEND FIXTURE · NO MEDIA");
  await client.done;
} else if (target === "attach" && process.argv[3] === "agent") {
  const workspace = process.argv[5];
  const threadId = process.argv[7];
  if (!workspace || !threadId) throw new Error("Missing attachment selection");
  process.exitCode = await runAttachment({ workspace, threadId }, stateDir);
} else if (target === "attach" && process.argv[3] === "voice") {
  console.log("VOICE TRANSCRIPT FIXTURE · NO MEDIA");
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGHUP", resolve);
  });
} else throw new Error(`Unknown attachment TUI probe child ${process.argv.slice(2).join(" ")}`);
