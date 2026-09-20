import { parseArgs, parseMcpConfigCommand, UsageError } from "../main.ts";
import { parseTimingTargets } from "./exact-turns.ts";
import { exportThreadMonitor } from "./export.ts";
import { discoverThreadMonitor, formatThreadMonitor } from "./monitor.ts";

export async function runThreadsCommand(
  argv: string[],
  stateDir: string,
  dependencies: {
    observe?: typeof discoverThreadMonitor;
    write?: (text: string) => void | Promise<void>;
  } = {},
): Promise<number> {
  const write =
    dependencies.write ??
    ((text: string) => {
      return new Promise<void>((resolve, reject) => {
        process.stdout.write(text, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    });
  const args = parseArgs(argv, {
    value: new Set(["--workspace", "--thread", "--timing-targets"]),
    bool: new Set(["--help", "--json"]),
  });
  if (args.help) {
    await write(
      "Usage: agentvoice threads [--workspace <dir>] [--thread <root-id>] [--json] [--timing-targets <json>]\nShow loaded and persisted native descendant threads, with children indented.\nMonitor with: watch -n 1 agentvoice threads\n--json exports versioned metadata with exact observed identity and parentage diagnostics; no socket or credential fields.\n--timing-targets requests at most 128 exact root/thread/turn metadata lookups (64 KiB JSON); unresolved reads are explicit.\n",
    );
    return 0;
  }
  const timingText = args.values["timing-targets"];
  if (timingText !== undefined && !argv.includes("--json"))
    throw new UsageError("--timing-targets requires --json");
  const timingTargets = timingText === undefined ? [] : parseTimingTargets(timingText);
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
      timingTargets,
    );
    await write(
      argv.includes("--json")
        ? `${JSON.stringify(exportThreadMonitor(snapshot))}\n`
        : formatThreadMonitor(snapshot),
    );
    return 0;
  } catch (error) {
    if (!argv.includes("--json")) throw error;
    await write(
      `${JSON.stringify(exportThreadMonitor({ phase: "unavailable", inventory: "unavailable", historyCoverage: "unavailable", threads: [], missingSettings: 0 }))}\n`,
    );
    return 1;
  }
}
