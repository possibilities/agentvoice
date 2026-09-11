/** Real desktop smolmux and codex-viewer, fake mobile owner and orchestrator. No media/inference. */
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runComposition } from "../../src/composition/launch.ts";
import { startControlServer } from "../../src/control/index.ts";
import { CONTROL_PROTOCOL_VERSION } from "../../src/control/types.ts";
import { LifecycleFeed } from "../../src/events/feed.ts";
import { connectFrontend } from "../../src/frontend/client.ts";
import { discoverServer } from "../../src/frontend/discovery.ts";
import { frontendSocketPath } from "../../src/frontend/protocol.ts";
import { VoiceServer } from "../../src/frontend/server.ts";
import { recordCall } from "../../src/recording/call.ts";

const selected = process.env["AGENTVOICE_ATTACHMENT_FIXTURE"];
if (!selected) throw new Error("Set AGENTVOICE_ATTACHMENT_FIXTURE to a new private directory");
const root = realpathSync(selected);
appendFileSync(join(root, "pids"), `${process.pid} ${process.argv[2] ?? "desktop-view"}\n`, {
  mode: 0o600,
});
if (process.argv[2] === "__attach-agent") {
  console.log(
    "ORCHESTRATOR · TEST FIXTURE\nBackend ready while phone media negotiates.\nType a steering message:",
  );
  process.stdin.on("data", (data) => {
    const message = data.toString().trim();
    console.log(`STEER RECEIVED: ${message}`);
    appendFileSync(join(root, "steering"), `${message}\n`, { mode: 0o600 });
  });
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGHUP", resolve);
  });
  process.stdin.pause();
} else {
  process.env["XDG_STATE_HOME"] = root;
  process.env["XDG_CONFIG_HOME"] = root;
  process.env["SMOLMUX_CONFIG_PATH"] = join(root, "smolmux", "config.toml");
  process.env["SMOLMUX_ZMX_DIR"] = join(root, "companion");
  mkdirSync(join(root, "companion"), { mode: 0o700 });
  const stateDir = join(root, "agentvoice");
  const feed = new LifecycleFeed("mobile-fixture");
  const recording = recordCall(feed, stateDir, console.error);
  feed.runtime(1, { workspace: root, mainThreadId: "mobile-fixture-thread", phase: "starting" });
  const forbidden = async (): Promise<never> => {
    throw new Error("Fixture does not mutate the backend");
  };
  const control = await startControlServer({
    stateDir,
    instanceId: "mobile-fixture",
    backend: {
      status: () => ({
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        instanceId: "mobile-fixture",
        workspace: root,
        threadId: "mobile-fixture-thread",
        generation: 1,
        runtime: { phase: "starting", attachmentReady: true },
        recentOperations: [],
      }),
      redial: forbidden,
      restart: forbidden,
      mailboxOpen: forbidden,
      voiceSet: forbidden,
    },
  });
  let closed = false;
  const server = new VoiceServer(frontendSocketPath(stateDir), async () => ({
    identity: () => ({ workspace: root, threadId: "mobile-fixture-thread" }),
    state: () => ({
      available: true,
      codingActivity: "unknown" as const,
      phase: "negotiating",
      mic: { muted: true, effectiveMuted: true },
      speaker: { muted: false, effectiveMuted: true },
    }),
    start: async () => {},
    command: () => {},
    close: async () => {
      closed = true;
    },
  }));
  await server.start();
  const owner = await connectFrontend(server.path);
  for (const [id, role, text] of [
    ["u1", "user", "Inspect the mobile conversation."],
    ["a1", "assistant", "The desktop is attached. The phone owns this call."],
  ] as const)
    feed.voice({
      event: "voice.item.completed",
      data: {
        threadId: "mobile-fixture-thread",
        item: { type: "transcriptSegment", id, realtimeSessionId: "fixture-session", role, text },
      },
    });
  try {
    await runComposition(undefined, [process.execPath, import.meta.path], [], { attach: true });
    const live = await discoverServer(stateDir);
    writeFileSync(
      join(root, "result.json"),
      JSON.stringify({ ownerStillConnected: live?.busy && !closed }),
      { mode: 0o600 },
    );
  } finally {
    await owner.close();
    await server.close();
    recording.close();
    await control.close();
  }
}
