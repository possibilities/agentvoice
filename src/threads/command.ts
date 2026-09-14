import { parseArgs, parseMcpConfigCommand, UsageError } from "../main.ts";
import { exportThreadMonitor } from "./export.ts";
import { discoverThreadMonitor, formatThreadMonitor } from "./monitor.ts";

export async function runThreadsCommand(
  argv: string[],
  stateDir: string,
  dependencies: { observe?: typeof discoverThreadMonitor; write?: (text: string) => void } = {},
): Promise<number> {
  const write =
    dependencies.write ??
    ((text: string) => {
      process.stdout.write(text);
    });
  const args = parseArgs(argv, {
    value: new Set(["--workspace", "--thread"]),
    bool: new Set(["--help", "--json"]),
  });
  if (args.help) {
    write(
      "Usage: agentvoice threads [--workspace <dir>] [--thread <root-id>] [--json]\nShow loaded and persisted native descendant threads, with children indented.\nMonitor with: watch -n 1 agentvoice threads\n--json exports versioned metadata with exact observed identity and parentage diagnostics; no socket or credential fields.\n",
    );
    return 0;
  }
  const threadId = args.values["thread"];
  if (threadId !== undefined && !threadId.trim())
    throw new UsageError("--thread requires a non-empty root id");
  const workspace = args.values["workspace"];
  const selection =
    workspace === undefined ? undefined : parseMcpConfigCommand(["--workspace", workspace]);
  try {
    const snapshot = await (dependencies.observe ?? discoverThreadMonitor)(
      stateDir,
      selection && !selection.help ? selection.workspace : undefined,
      threadId,
    );
    write(
      argv.includes("--json")
        ? `${JSON.stringify(exportThreadMonitor(snapshot))}\n`
        : formatThreadMonitor(snapshot),
    );
    return 0;
  } catch (error) {
    if (!argv.includes("--json")) throw error;
    write(
      `${JSON.stringify(exportThreadMonitor({ phase: "unavailable", inventory: "unavailable", historyCoverage: "unavailable", threads: [], missingSettings: 0 }))}\n`,
    );
    return 1;
  }
}
