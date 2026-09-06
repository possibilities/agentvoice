import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { acquireAttachment } from "./bootstrap.ts";
import type { AttachmentTicket } from "./gateway.ts";

export const TUI_TOKEN_ENV = "AGENTVOICE_TUI_TOKEN";
export function attachmentArgv(ticket: AttachmentTicket): string[] {
  return [
    ticket.codex,
    "resume",
    "--remote",
    ticket.url,
    "--remote-auth-token-env",
    TUI_TOKEN_ENV,
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    ticket.workspace,
    ticket.threadId,
  ];
}

export async function runAttachment(
  selected: { workspace: string; threadId?: string },
  stateDir: string,
): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("agentvoice attach requires an interactive terminal");
  const ticket = await acquireAttachment(stateDir, selected.workspace, selected.threadId);
  const terminalState = execFileSync("stty", ["-g"], { stdio: ["inherit", "pipe", "ignore"] })
    .toString()
    .trim();
  let child: ChildProcess | undefined;
  let revoked = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const watcher = new WebSocket(`${ticket.url}/watch`, {
    headers: { Authorization: `Bearer ${ticket.token}` },
  });
  const terminate = () => {
    revoked = true;
    child?.kill("SIGTERM");
    if (child && !killTimer) killTimer = setTimeout(() => child?.kill("SIGKILL"), 2_000);
  };
  const closed = (event: CloseEvent) => {
    if (event.code !== 1000) terminate();
  };
  watcher.addEventListener("close", closed);
  watcher.addEventListener("error", terminate);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Attachment watcher timed out")), 5_000);
      watcher.addEventListener(
        "message",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      watcher.addEventListener(
        "close",
        () => reject(new Error("Attachment ended before TUI launch")),
        { once: true },
      );
      watcher.addEventListener("error", () => reject(new Error("Attachment watcher failed")), {
        once: true,
      });
    });
    if (revoked) throw new Error("Attachment ended before TUI launch");
    const [bin, ...args] = attachmentArgv(ticket);
    child = spawn(bin!, args, {
      cwd: ticket.workspace,
      env: { ...process.env, [TUI_TOKEN_ENV]: ticket.token },
      stdio: "inherit",
    });
    // SIGINT belongs to the foreground TUI. The wrapper must remain to restore terminal state.
    const ignoreInterrupt = () => {};
    process.on("SIGINT", ignoreInterrupt);
    process.on("SIGTERM", terminate);
    try {
      return await new Promise<number>((resolve, reject) => {
        child!.once("exit", (code) => resolve(revoked ? 1 : (code ?? 1)));
        child!.once("error", () => reject(new Error("Could not launch the configured Codex TUI")));
      });
    } finally {
      process.off("SIGINT", ignoreInterrupt);
      process.off("SIGTERM", terminate);
    }
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    watcher.removeEventListener("close", closed);
    watcher.removeEventListener("error", terminate);
    watcher.close();
    execFileSync("stty", [terminalState], { stdio: ["inherit", "ignore", "ignore"] });
    if (revoked) {
      process.stdout.write(
        "\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\r\n",
      );
      console.error("Attachment ended. Run agentvoice attach again for the current voice thread.");
    }
  }
}
