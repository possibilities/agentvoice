import { execFileSync, spawn } from "node:child_process";
import { OwnedProcessTree } from "../core/owned-processes.ts";

export function voiceViewerArgv(path: string): string[] {
  return ["codex-viewer", "--voice-jsonl", path, "--follow"];
}

/** Viewer lifetime is independent of the server and recording writer. */
export async function runVoiceViewer(path: string): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "agentvoice attach voice requires an interactive terminal (use --list to inspect saved paths)",
    );
  const terminal = execFileSync("stty", ["-g"], { stdio: ["inherit", "pipe", "ignore"] })
    .toString()
    .trim();
  const [bin, ...args] = voiceViewerArgv(path);
  const child = spawn(bin!, args, { stdio: "inherit", env: process.env });
  const owned = child.pid ? new OwnedProcessTree(child.pid) : undefined;
  let stopping: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopping) return;
    timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    stopping = (async () => {
      try {
        await owned?.signalCaptured("SIGTERM");
      } finally {
        child.kill("SIGTERM");
      }
      const remaining = await owned?.waitForCapturedExit(2000);
      if (remaining && !remaining.complete) {
        await owned!.signalCaptured("SIGKILL");
        if (!(await owned!.waitForCapturedExit(1000)).complete)
          throw new Error("Could not verify voice viewer cleanup");
      }
    })();
    void stopping.catch(() => {});
  };
  const interrupt = () => {};
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  try {
    const exited = new Promise<number>((resolve, reject) => {
      child.once("exit", (code) => resolve(code ?? 1));
      child.once("error", () =>
        reject(new Error("Could not launch codex-viewer; install it on PATH")),
      );
    });
    void owned?.snapshotNow().catch(stop);
    return await exited;
  } finally {
    try {
      if (owned && !(await owned.waitForCapturedExit(0)).complete) stop();
      await stopping;
    } finally {
      clearTimeout(timer);
      owned?.stopTracking();
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", stop);
      process.off("SIGHUP", stop);
      execFileSync("stty", [terminal], { stdio: ["inherit", "ignore", "ignore"] });
    }
  }
}
