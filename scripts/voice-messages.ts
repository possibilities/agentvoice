#!/usr/bin/env bun
import { createConnection } from "node:net";
import { EVENT_PROTOCOL_VERSION } from "../src/events/contract.ts";
import { voiceItemSchema } from "../src/events/voice.ts";
import { runEventSocketCommand } from "../src/main.ts";
import { VoiceMessageStream } from "./voice-message-stream.ts";

const usage = `Print completed user/assistant voice messages from a running AgentVoice.

Usage: bun run scripts/voice-messages.ts [--workspace <dir>] [--thread <main-thread-id>] [--stream]

Workspace defaults to the current directory. Use --thread to select a controller
when several are running there. Only future completed voice segments are shown;
missed speech is not replayed. Add --stream to print text deltas as they arrive.
Completion does not mean audio playback finished.
Press Ctrl+C to stop.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    console.log(usage);
    return;
  }
  const streaming = argv.includes("--stream");
  const stream = new VoiceMessageStream((text) => process.stdout.write(text));
  let path = "";
  await runEventSocketCommand(
    argv.filter((arg) => arg !== "--stream"),
    {
      write: (output) => {
        path = output.trim();
      },
    },
  );
  const socket = createConnection(path);
  socket.setEncoding("utf8");
  socket.write(
    `${JSON.stringify({
      v: EVENT_PROTOCOL_VERSION,
      type: "request",
      id: "subscribe",
      method: "event.subscribe",
      params: { events: streaming ? ["voice.item.*"] : ["voice.item.completed"] },
    })}\n`,
  );
  let pending = "";
  let subscribed = false;
  const timeout = setTimeout(() => {
    socket.destroy(new Error("Voice subscription timed out"));
  }, 5_000);
  try {
    for await (const chunk of socket) {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line) > 1 << 20) throw new Error("Event frame too large");
        const frame = JSON.parse(line);
        if (frame.v !== EVENT_PROTOCOL_VERSION)
          throw new Error(
            `Event protocol mismatch: controller uses ${frame.v}, viewer requires ${EVENT_PROTOCOL_VERSION}. Run both from the current checkout and fully quit and relaunch AgentVoice; a voice runtime restart does not replace the controller.`,
          );
        if (frame.type === "response" && frame.id === "subscribe") {
          if (!frame.ok) throw new Error(frame.error?.message ?? "Voice subscription failed");
          subscribed = true;
          clearTimeout(timeout);
          console.error(
            streaming
              ? "Streaming voice messages. Ctrl+C to stop."
              : "Listening for completed voice messages. Ctrl+C to stop.",
          );
        } else if (streaming && frame.type === "event") {
          stream.accept(frame);
        } else if (frame.type === "event" && frame.event === "voice.item.completed") {
          const item = voiceItemSchema.parse(frame.data.item);
          if (item.type === "transcriptSegment") console.log(`${item.role}: ${item.text.trim()}`);
        }
        newline = pending.indexOf("\n");
      }
      if (Buffer.byteLength(pending) > 1 << 20) throw new Error("Event frame too large");
    }
    if (pending) throw new Error("Connection closed during an event frame");
    if (!subscribed) throw new Error("Connection closed before voice subscription");
    console.error("Voice event connection closed. Run the script again to reconnect.");
  } finally {
    stream.finish();
    clearTimeout(timeout);
    socket.destroy();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
