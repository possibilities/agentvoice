import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { discoverControllerStatus } from "../control/discovery.ts";
import { loadConfigFile } from "../core/config.ts";
import { discoverServer } from "../frontend/discovery.ts";
import { parseArgs, parseMcpConfigCommand, UsageError } from "../main.ts";
import { defaultConfigPath, expandTilde } from "../paths.ts";
import { savedRecordings } from "../recording/store.ts";
import { currentWorkspace } from "../workspace.ts";

export function parseAttachCommand(argv: string[]) {
  const target = argv[0];
  if (target !== "agent" && target !== "voice")
    throw new UsageError("Choose agentvoice attach agent or agentvoice attach voice [--list]");
  const flags = parseArgs(argv.slice(1), {
    value: new Set(["--workspace", "--thread"]),
    bool: new Set(target === "voice" ? ["--list", "--help"] : ["--help"]),
  });
  const list = argv.slice(1).includes("--list");
  const threadId = flags.values["thread"];
  if (threadId !== undefined && !threadId.trim())
    throw new UsageError("--thread requires a non-empty id");
  if (list && threadId) throw new UsageError("--list and --thread cannot be combined");
  const workspace = flags.values["workspace"];
  const selected =
    workspace === undefined ? undefined : parseMcpConfigCommand(["--workspace", workspace]);
  return {
    target,
    list,
    help: flags.help,
    threadId,
    workspace: selected && !selected.help ? selected.workspace : undefined,
  };
}

export async function attachmentSelection(stateDir: string, workspace?: string, threadId?: string) {
  const server = await discoverServer(stateDir, workspace);
  if (!workspace) {
    if (server?.busy && !server.workspace)
      throw new Error("Default call is initializing; retry attachment shortly");
    if (server?.workspace) workspace = server.workspace;
    else {
      const file = await loadConfigFile(defaultConfigPath(process.env, homedir()), false);
      const configured = file.orchestrator?.workspace;
      workspace =
        configured === undefined
          ? currentWorkspace(stateDir, false)
          : realpathSync(resolve(expandTilde(configured, homedir())));
    }
  }
  let liveThread = server?.busy ? (server.threadId ?? undefined) : undefined;
  // Explicit workspaces can also belong to a server using the stable default endpoint.
  if (!server) {
    try {
      liveThread = (await discoverControllerStatus(stateDir, workspace, threadId)).status.threadId;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("no live AgentVoice controller"))
        throw error;
    }
  }
  return {
    workspace,
    threadId: threadId ?? liveThread,
    active: !!liveThread && (!threadId || threadId === liveThread),
    busy: server?.busy ?? false,
  };
}

export async function runAttachCommand(argv: string[], stateDir: string): Promise<number> {
  const command = parseAttachCommand(argv);
  if (command.help) {
    console.log(
      `agentvoice attach ${command.target} [--workspace <dir>] [--thread <id>]${command.target === "voice" ? " [--list]" : ""}`,
    );
    return 0;
  }
  const selected = await attachmentSelection(stateDir, command.workspace, command.threadId);
  if (command.target === "agent") {
    const { runAttachment } = await import("./launcher.ts");
    return runAttachment(selected, stateDir);
  }
  const recordings = savedRecordings(stateDir, selected.workspace);
  if (command.list) {
    for (const recording of recordings)
      console.log(
        `${recording.threadId}\t${recording.updatedAt}\t${recording.path}${recording.interrupted ? "\tactive or interrupted" : ""}`,
      );
    if (!recordings.length) console.log(`No voice recordings for ${selected.workspace}`);
    return 0;
  }
  if (selected.busy && !selected.threadId)
    throw new Error("Call is initializing; retry voice attachment shortly");
  const recording = selected.threadId
    ? recordings.find((entry) => entry.threadId === selected.threadId)
    : recordings[0];
  if (!recording)
    throw new Error(
      `No saved voice transcript for ${selected.workspace}${selected.threadId ? ` and thread ${selected.threadId}` : ""}. Recording begins with calls made after this update.`,
    );
  if (recording.interrupted && !selected.active)
    console.error("This recording was not finalized; its last speech may be incomplete.");
  const { runVoiceViewer } = await import("./voice-launcher.ts");
  return runVoiceViewer(recording.path);
}
