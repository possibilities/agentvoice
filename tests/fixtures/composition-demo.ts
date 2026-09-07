/** Manual PTY fixture: real smolmux, pointer UI and voice viewer; fake call and working agent. */
import { appendFileSync, existsSync, mkdirSync, realpathSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runVoiceViewer } from "../../src/attachment/voice-launcher.ts";
import { runComposition } from "../../src/composition/launch.ts";
import { runFrontend } from "../../src/frontend/client.ts";
import { type FrontendState, frontendSocketPath } from "../../src/frontend/protocol.ts";
import { VoiceServer } from "../../src/frontend/server.ts";
import { recordingDirectory } from "../../src/recording/store.ts";
import { VoiceRecording } from "../../src/recording/writer.ts";

const root = process.env["AGENTVOICE_COMPOSITION_FIXTURE"];
if (!root) throw new Error("Set AGENTVOICE_COMPOSITION_FIXTURE to a disposable private directory");
const target = process.argv[2];
appendFileSync(join(root, "pids"), `${process.pid} ${target ?? "composition"}\n`, { mode: 0o600 });
if (target === "client") {
  await runFrontend();
} else if (target === "attach") {
  if (process.argv[3] === "voice") {
    await runVoiceViewer(
      join(
        recordingDirectory(join(root, "agentvoice"), realpathSync(root)),
        "fixture-thread.jsonl",
      ),
    );
  } else {
    console.log("WORKING AGENT FIXTURE");
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGHUP", resolve);
    });
  }
} else {
  process.env["XDG_STATE_HOME"] = root;
  process.env["XDG_CONFIG_HOME"] = root;
  process.env["SMOLMUX_CONFIG_PATH"] = join(root, "smolmux", "config.toml");
  process.env["SMOLMUX_ZMX_DIR"] = join(root, "companion");
  mkdirSync(join(root, "companion"), { mode: 0o700 });
  const workspace = realpathSync(root);
  const recording = new VoiceRecording(
    workspace,
    recordingDirectory(join(root, "agentvoice"), workspace),
  );
  recording.openThread("fixture-thread");
  let phase: FrontendState["phase"] = "negotiating";
  let sent = false;
  let changed = () => {};
  const watcher = watch(root, () => {
    const next = existsSync(join(root, "live")) ? "live" : "negotiating";
    if (next !== phase) {
      phase = next;
      changed();
    }
    if (!sent && existsSync(join(root, "message"))) {
      sent = true;
      recording.accept({
        v: 2,
        type: "event",
        event: "voice.item.completed",
        data: {
          instanceId: "fixture-controller",
          generation: 1,
          sequence: 1,
          threadId: "fixture-thread",
          item: {
            id: "first",
            type: "transcriptSegment",
            realtimeSessionId: "fixture-call",
            role: "user",
            text: "First voice message",
          },
        },
      });
    }
  });
  const server = new VoiceServer(frontendSocketPath(join(root, "agentvoice")), async (notify) => {
    changed = notify;
    return {
      identity: () => ({ workspace, threadId: "fixture-thread" }),
      state: () => ({
        available: true,
        phase,
        mic: { muted: false, effectiveMuted: false },
        speaker: { muted: false, effectiveMuted: false },
      }),
      start: async () => {},
      command: () => {},
      close: async () => {
        writeFileSync(join(root, "call-closed"), "closed", { mode: 0o600 });
      },
    };
  });
  try {
    await server.start();
    await runComposition(undefined, [process.execPath, import.meta.path]);
  } finally {
    watcher.close();
    await server.close();
    recording.close("stopped");
  }
}
