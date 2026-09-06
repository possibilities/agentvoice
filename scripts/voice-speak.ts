#!/usr/bin/env bun
import { homedir } from "node:os";
import { acquireAttachment } from "../src/attachment/bootstrap.ts";
import type { AttachmentTicket } from "../src/attachment/gateway.ts";
import { parseMcpConfigCommand } from "../src/main.ts";
import { stateDirectory } from "../src/paths.ts";

const usage = `Send text for the current AgentVoice conversation to speak.

Usage: bun run scripts/voice-speak.ts [--workspace <dir>] [--thread <id>] "Text to say"

Workspace defaults to the current directory. Use --thread if multiple controllers
share it. Use -- before text beginning with a dash. Acceptance does not confirm
audio playback. Requests are sent once, without automatic retries.
`;

export function parseSpeechArgs(argv: string[]) {
  const selection: string[] = [];
  const words: string[] = [];
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!literal && arg === "--") literal = true;
    else if (!literal && (arg === "--workspace" || arg === "--thread")) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      selection.push(arg, value);
    } else if (!literal && arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else words.push(arg);
  }
  const text = words.join(" ");
  if (!text.trim() || Buffer.byteLength(text) > 64 * 1024)
    throw new Error("Speech text must be nonempty and at most 64 KiB");
  const selected = parseMcpConfigCommand(selection);
  if (selected.help) throw new Error("Unexpected help option");
  return { ...selected, text };
}

export async function sendSpeech(ticket: AttachmentTicket, text: string): Promise<void> {
  const headers = { Authorization: `Bearer ${ticket.token}` };
  const watcher = new WebSocket(`${ticket.url}/watch`, { headers });
  let socket: WebSocket | undefined;
  let sent = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (message: string) =>
        reject(
          new Error(
            sent ? `${message}; speech delivery is unknown. The request was not retried.` : message,
          ),
        );
      timer = setTimeout(() => fail("Speech request timed out"), 10_000);
      watcher.addEventListener("error", () => fail("Speech attachment failed"));
      watcher.addEventListener("close", () => fail("Speech attachment closed"));
      watcher.addEventListener(
        "message",
        ({ data }) => {
          try {
            if (typeof data !== "string" || JSON.parse(data).ready !== true)
              throw new Error("Invalid watcher response");
            socket = new WebSocket(ticket.url, { headers });
            socket.addEventListener("error", () => fail("Speech connection failed"));
            socket.addEventListener("close", () => fail("Speech connection closed"));
            socket.addEventListener("open", () =>
              socket!.send(
                JSON.stringify({
                  id: "initialize",
                  method: "initialize",
                  params: {
                    clientInfo: { name: "agentvoice-speak", version: "0.1.0" },
                    capabilities: { experimentalApi: true },
                  },
                }),
              ),
            );
            socket.addEventListener("message", ({ data }) => {
              try {
                if (typeof data !== "string" || Buffer.byteLength(data) > 4 * 1024 * 1024)
                  throw new Error("Invalid speech response");
                const frame = JSON.parse(data);
                if (frame.method) return;
                if (frame.id !== "initialize" && frame.id !== "speech") return;
                if (frame.error) {
                  reject(
                    new Error(
                      `Speech request rejected: ${String(frame.error.message ?? "unknown error")}. If appendSpeech is unsupported, restart the voice runtime from the updated checkout.`,
                    ),
                  );
                  return;
                }
                if (!Object.hasOwn(frame, "result")) throw new Error("Missing result");
                if (frame.id === "initialize" && !sent) {
                  socket!.send(JSON.stringify({ method: "initialized", params: {} }));
                  sent = true;
                  socket!.send(
                    JSON.stringify({
                      id: "speech",
                      method: "thread/realtime/appendSpeech",
                      params: { threadId: ticket.threadId, text },
                    }),
                  );
                } else if (frame.id === "speech" && sent) resolve();
              } catch {
                fail("Invalid speech response");
              }
            });
          } catch {
            fail("Could not open speech connection");
          }
        },
        { once: true },
      );
    });
  } finally {
    clearTimeout(timer);
    socket?.close(1000);
    watcher.close(1000);
  }
}

if (import.meta.main) {
  try {
    const argv = process.argv.slice(2);
    if (argv[0] === "--help") console.log(usage);
    else {
      const selected = parseSpeechArgs(argv);
      const ticket = await acquireAttachment(
        stateDirectory(process.env, homedir()),
        selected.workspace,
        selected.threadId,
      );
      await sendSpeech(ticket, selected.text);
      console.log("Speech request accepted; audio playback is not confirmed.");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
