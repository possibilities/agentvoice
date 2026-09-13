/** Manual PTY fixture: real smolmux and pointer UI, fake call and attachment apps. */
import { appendFileSync, existsSync, mkdirSync, realpathSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runComposition } from "../../src/composition/launch.ts";
import { connectFrontend } from "../../src/frontend/client.ts";
import { type FrontendState, frontendSocketPath } from "../../src/frontend/protocol.ts";
import { VoiceServer } from "../../src/frontend/server.ts";

const root = process.env["AGENTVOICE_COMPOSITION_FIXTURE"];
if (!root) throw new Error("Set AGENTVOICE_COMPOSITION_FIXTURE to a disposable private directory");
const target = process.argv[2];
appendFileSync(join(root, "pids"), `${process.pid} ${target ?? "composition"}\n`, { mode: 0o600 });
if (target === "client") {
  const client = await connectFrontend(
    frontendSocketPath(join(root, "agentvoice")),
    () => {},
    process.env["AGENTVOICE_CLIENT_ID"],
  );
  const stop = () => {
    void client.close();
  };
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);
  console.log("CLIENT FIXTURE — no media");
  try {
    await client.done;
  } finally {
    await client.close();
  }
} else if (target === "attach") {
  console.log(process.argv[3] === "voice" ? "VOICE TRANSCRIPT FIXTURE" : "WORKING AGENT FIXTURE");
  console.log(process.argv.at(-1));
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGHUP", resolve);
  });
} else {
  process.env["XDG_STATE_HOME"] = root;
  process.env["XDG_CONFIG_HOME"] = root;
  process.env["SMOLMUX_CONFIG_PATH"] = join(root, "smolmux", "config.toml");
  process.env["SMOLMUX_ZMX_DIR"] = join(root, "companion");
  mkdirSync(join(root, "companion"), { mode: 0o700 });
  const workspace = realpathSync(root);
  let phase: FrontendState["phase"] = "negotiating";
  let generation = 1;
  let changed = () => {};
  const watcher = watch(root, () => {
    if (existsSync(join(root, "replace"))) {
      generation = 2;
      phase = existsSync(join(root, "replacement-ready")) ? "live" : "waiting-ready";
      changed();
    } else if (existsSync(join(root, "live"))) {
      phase = "live";
      changed();
    }
  });
  const server = new VoiceServer(frontendSocketPath(join(root, "agentvoice")), async (notify) => {
    changed = notify;
    return {
      identity: () => ({
        workspace,
        threadId: generation === 1 ? "fixture-thread" : "successor-thread",
        generation,
      }),
      state: () => ({
        available: true,
        codingActivity: "unknown" as const,
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
  }
}
