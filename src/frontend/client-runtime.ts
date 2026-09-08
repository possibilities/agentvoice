import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { stateDirectory } from "../paths.ts";
import { checkServiceRuntime, serviceRuntimeExecutable } from "../service-runtime.ts";

/** Use the installer-owned audio permission identity, never modify Homebrew Bun or TCC. */
export async function launchClientRuntime(
  args: string[],
  source: string,
): Promise<number | undefined> {
  if (process.platform !== "darwin") return;
  const stateDir = stateDirectory(process.env, homedir());
  const executable = serviceRuntimeExecutable(stateDir);
  if (!existsSync(executable))
    throw new Error("Install AgentVoice before opening native client audio on macOS");
  checkServiceRuntime(stateDir);
  if (realpathSync(process.execPath) === realpathSync(executable)) return;
  const child = Bun.spawn([executable, source, "client", ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    child.kill("SIGTERM");
    deadline ??= setTimeout(() => child.kill("SIGKILL"), 7000);
  };
  for (const signal of signals) process.once(signal, stop);
  try {
    return await child.exited;
  } finally {
    clearTimeout(deadline);
    for (const signal of signals) process.off(signal, stop);
  }
}
