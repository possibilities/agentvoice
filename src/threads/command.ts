import { parseArgs, parseMcpConfigCommand, UsageError } from "../main.ts";
import { discoverThreadMonitor, formatThreadMonitor } from "./monitor.ts";

export async function runThreadsCommand(argv: string[], stateDir: string): Promise<number> {
  const args = parseArgs(argv, {
    value: new Set(["--workspace", "--thread"]),
    bool: new Set(["--help"]),
  });
  if (args.help) {
    console.log(
      "Usage: agentvoice threads [--workspace <dir>] [--thread <root-id>]\nShow loaded threads in the active call, with children indented.\nMonitor with: watch -n 1 agentvoice threads",
    );
    return 0;
  }
  const threadId = args.values["thread"];
  if (threadId !== undefined && !threadId.trim())
    throw new UsageError("--thread requires a non-empty root id");
  const workspace = args.values["workspace"];
  const selection =
    workspace === undefined ? undefined : parseMcpConfigCommand(["--workspace", workspace]);
  const snapshot = await discoverThreadMonitor(
    stateDir,
    selection && !selection.help ? selection.workspace : undefined,
    threadId,
  );
  process.stdout.write(formatThreadMonitor(snapshot));
  return 0;
}
