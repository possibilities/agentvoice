import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { streamRemoteAttachment } from "../attachment/bridge.ts";
import { streamAttachmentSession } from "../attachment/session.ts";
import { observeFrontend } from "../frontend/observer.ts";
import { frontendSocketPath } from "../frontend/protocol.ts";
import { ControlSocket } from "../ipc/control-client.ts";
import { stateDirectory } from "../paths.ts";
import { AttachmentComposition } from "./attachment.ts";
import { Composition } from "./controller.ts";

// smolmux protocol 2 identifies a named Instance by config directory and name.
export function muxSocketPath(name: string, env = process.env, home = homedir()) {
  const directory = join(env["XDG_CONFIG_HOME"] || join(home, ".config"), "smolmux");
  const id = createHash("sha256")
    .update(`smolmux-instance:${directory}:${name}`)
    .digest("hex")
    .slice(0, 12);
  return `/tmp/smolmux-${process.getuid?.()}/${id}.api`;
}

export async function runComposition(
  workspace?: string,
  command = [process.execPath, fileURLToPath(new URL("../main.ts", import.meta.url))],
  clientArgs: string[] = [],
  options: { attach?: boolean; host?: string } = {},
) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("agentvoice requires a terminal (TTY)");
  const smolmux = Bun.which("smolmux");
  if (!smolmux)
    throw new Error(
      "Install smolmux with its local PTY helper before running agentvoice; agentvoice client runs the voice controls alone.",
    );
  if (!Bun.which("codex-viewer"))
    throw new Error(
      "Install codex-viewer before running agentvoice; agentvoice client runs the voice controls alone.",
    );
  const clientId = randomUUID();
  const name = `agentvoice-${randomUUID().slice(0, 16)}`;
  let composition: Composition | AttachmentComposition | undefined;
  const stateDir = stateDirectory(process.env, homedir());
  const observation = options.attach
    ? undefined
    : await observeFrontend(frontendSocketPath(stateDir, workspace), (state) => {
        if (composition instanceof Composition) composition.observe(state);
      });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let mux: ControlSocket | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  const stop = () => {
    abort.abort();
    composition?.stop();
    child?.kill("SIGTERM");
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  let work: Promise<void> | undefined;
  try {
    for (const signal of signals) process.once(signal, stop);
    await observation?.waitUntilAvailable({
      signal: abort.signal,
      waiting: () => console.error("Closing previous call…"),
    });
    child = Bun.spawn([smolmux, "start", "--foreground", "--name", name], {
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const deadline = Date.now() + 10_000;
    for (;;) {
      if (child.exitCode !== null)
        throw new Error(`smolmux exited during startup (${child.exitCode})`);
      try {
        mux = await ControlSocket.connect(muxSocketPath(name), 2, (frame) =>
          composition?.event(frame),
        );
        break;
      } catch (error) {
        if (
          !["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "") ||
          Date.now() >= deadline
        )
          throw error;
        await Bun.sleep(50);
      }
    }
    const status = (await mux.request("instance.status")) as Record<string, unknown>;
    if (status["name"] !== name || status["pid"] !== child.pid || status["host"] !== "foreground")
      throw new Error("smolmux did not identify the owned foreground process");
    composition = options.attach
      ? new AttachmentComposition(mux, command, options.host)
      : new Composition(mux, clientId, command, workspace, clientArgs);
    await mux.request("event.subscribe", { events: ["app.state"] });
    const current = composition;
    work = (async () => {
      await current.start();
      if (current instanceof AttachmentComposition) {
        const receive = (frame: Parameters<typeof current.receive>[0]) => current.receive(frame);
        if (options.host)
          await streamRemoteAttachment(options.host, workspace, receive, abort.signal);
        else await streamAttachmentSession(stateDir, workspace, receive, abort.signal);
        current.stop();
      }
    })();
    work.catch((error) => composition?.stop(error));
    await Promise.race([
      composition.done,
      child.exited,
      mux.done,
      ...(observation ? [observation.socket.done] : []),
    ]);
    composition.stop();
    if (composition.error()) throw composition.error();
    if (observation?.socket.error()) throw observation.socket.error();
    if (mux.error()) throw mux.error();
  } finally {
    composition?.stop();
    abort.abort();
    observation?.socket.close();
    // Foreground shutdown reaps every local PTY; only this exact child may be signalled.
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child?.kill("SIGKILL"), 7000);
      await child.exited;
    }
    if (killTimer) clearTimeout(killTimer);
    mux?.close();
    await work?.catch(() => {});
    await composition?.drained();
    for (const signal of signals) process.off(signal, stop);
  }
}
