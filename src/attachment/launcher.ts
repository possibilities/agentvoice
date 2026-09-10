import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import type { z } from "zod";
import { OwnedProcessTree } from "../core/owned-processes.ts";
import { acquireAttachment, type attachmentTargetSchema } from "./bootstrap.ts";
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
    "-C",
    ticket.workspace,
    ticket.threadId,
  ];
}

export async function runAttachment(
  selected: { workspace: string; threadId?: string },
  stateDir: string,
  expected?: z.infer<typeof attachmentTargetSchema>,
): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("agentvoice attach agent requires an interactive terminal");
  const ticket = await acquireAttachment(stateDir, selected.workspace, selected.threadId, expected);
  const terminalState = execFileSync("stty", ["-g"], { stdio: ["inherit", "pipe", "ignore"] })
    .toString()
    .trim();
  let child: ChildProcess | undefined;
  let owned: OwnedProcessTree | undefined;
  let stopping: Promise<void> | undefined;
  let revoked = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const watcher = new WebSocket(`${ticket.url}/watch`, {
    headers: { Authorization: `Bearer ${ticket.token}` },
  });
  const terminate = () => {
    revoked = true;
    if (!child || stopping) return;
    const target = child;
    killTimer = setTimeout(() => target.kill("SIGKILL"), 2_000);
    stopping = (async () => {
      // Capture descendants before a wrapper exits and reparents the actual TUI.
      try {
        await owned?.signalCaptured("SIGTERM");
      } finally {
        target.kill("SIGTERM");
      }
      const remaining = await owned?.waitForCapturedExit(2_000);
      if (remaining && !remaining.complete) {
        await owned!.signalCaptured("SIGKILL");
        const final = await owned!.waitForCapturedExit(1_000);
        if (!final.complete) throw new Error("Could not verify attached TUI process cleanup");
      }
    })();
    // Teardown awaits this promise even if the immediate child exits first.
    void stopping.catch(() => {});
  };
  const finishChild = async () => {
    if (!stopping && owned && !(await owned.waitForCapturedExit(0)).complete) terminate();
    await stopping;
  };
  const closed = (event: CloseEvent) => {
    if (event.code !== 1000) terminate();
    // A normal detach lets Codex restore itself, but must not leave a hung wrapper.
    else closeTimer = setTimeout(terminate, 2_000);
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
    if (revoked || watcher.readyState !== WebSocket.OPEN)
      throw new Error("Attachment ended before TUI launch");
    const [bin, ...args] = attachmentArgv(ticket);
    child = spawn(bin!, args, {
      cwd: ticket.workspace,
      env: { ...process.env, [TUI_TOKEN_ENV]: ticket.token },
      stdio: "inherit",
    });
    const exited = new Promise<number>((resolve, reject) => {
      child!.once("exit", (code) => resolve(code ?? 1));
      child!.once("error", () => reject(new Error("Could not launch the configured Codex TUI")));
    });
    if (child.pid) {
      owned = new OwnedProcessTree(child.pid);
      void owned.snapshotNow().catch(() => terminate());
    }
    // SIGINT belongs to the foreground TUI. The wrapper must remain to restore terminal state.
    const ignoreInterrupt = () => {};
    process.on("SIGINT", ignoreInterrupt);
    process.on("SIGTERM", terminate);
    process.on("SIGHUP", terminate);
    try {
      const code = await exited;
      await finishChild();
      return revoked ? 1 : code;
    } finally {
      process.off("SIGINT", ignoreInterrupt);
      process.off("SIGTERM", terminate);
      process.off("SIGHUP", terminate);
    }
  } finally {
    clearTimeout(timer);
    clearTimeout(closeTimer);
    watcher.removeEventListener("close", closed);
    watcher.removeEventListener("error", terminate);
    watcher.close();
    try {
      await finishChild();
    } finally {
      clearTimeout(killTimer);
      owned?.stopTracking();
      execFileSync("stty", [terminalState], { stdio: ["inherit", "ignore", "ignore"] });
      if (revoked) {
        process.stdout.write(
          "\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\r\n",
        );
        console.error(
          "Attachment ended. Run agentvoice attach agent again for the current voice thread.",
        );
      }
    }
  }
}
