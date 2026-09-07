#!/usr/bin/env bun
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { EVENT_PROTOCOL_VERSION } from "../src/events/contract.ts";
import { eventSnapshotSchema } from "../src/events/schema.ts";
import { parseArgs, parseMcpConfigCommand, runEventSocketCommand } from "../src/main.ts";
import { expandTilde } from "../src/paths.ts";
import { VoiceRecording } from "../src/recording/writer.ts";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), {
    value: new Set(["--workspace", "--thread", "--out-dir"]),
    bool: new Set(["--help"]),
  });
  if (args.help) {
    console.log(
      "Usage: bun run voice:record [--workspace <dir>] [--thread <id>] --out-dir <dir>\nRecords future voice events to one JSONL file per conversation. Ctrl+C finishes recording.",
    );
    return;
  }
  const output = args.values["out-dir"];
  if (!output?.trim()) throw new Error("--out-dir is required");
  const selection = Object.entries(args.values)
    .filter(([key]) => key !== "out-dir")
    .flatMap(([key, value]) => [`--${key}`, value]);
  const selected = parseMcpConfigCommand(selection);
  if (selected.help) return;
  let path = "";
  await runEventSocketCommand(selection, {
    write: (text) => {
      path = text.trim();
    },
  });
  const recording = new VoiceRecording(
    selected.workspace,
    resolve(expandTilde(output, homedir())),
    (file) => console.log(file),
  );
  const socket = createConnection(path);
  socket.setEncoding("utf8");
  let stopped = false;
  let reason: "stopped" | "disconnected" | "error" = "error";
  const stop = () => {
    stopped = true;
    socket.end();
    socket.destroy();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  const request = (id: string, method: string, params: object) =>
    socket.write(
      `${JSON.stringify({ v: EVENT_PROTOCOL_VERSION, type: "request", id, method, params })}\n`,
    );
  const timer = setTimeout(() => socket.destroy(new Error("Voice subscription timed out")), 5_000);
  let pending = "";
  let subscribed = false;
  try {
    request("subscribe", "event.subscribe", { events: ["voice.item.*", "runtime.state.changed"] });
    for await (const chunk of socket) {
      pending += chunk;
      for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line) > 1 << 20) throw new Error("Event frame exceeds 1 MiB");
        const frame = JSON.parse(line);
        if (frame.v !== EVENT_PROTOCOL_VERSION)
          throw new Error(
            "Event protocol mismatch; fully quit and relaunch AgentVoice from the current checkout",
          );
        if (frame.type === "response") {
          if (!frame.ok) throw new Error(frame.error?.message ?? "Voice observation failed");
          if (frame.id === "subscribe") {
            subscribed = true;
            clearTimeout(timer);
            request("state", "state.get", {});
            console.error("Recording future voice messages. Ctrl+C to stop.");
          } else if (frame.id === "state") {
            const snapshot = eventSnapshotSchema.parse(frame.result);
            if (snapshot.runtime.mainThreadId) recording.openThread(snapshot.runtime.mainThreadId);
          }
        } else if (frame.type === "event" && frame.event === "runtime.state.changed") {
          if (!["starting", "ready"].includes(frame.data.runtime.phase))
            recording.gap("runtime_unavailable");
          if (frame.data.runtime.mainThreadId)
            recording.openThread(frame.data.runtime.mainThreadId);
        } else if (frame.type === "event" && frame.event.startsWith("voice.item."))
          recording.accept(frame);
      }
      if (Buffer.byteLength(pending) > 1 << 20) throw new Error("Event frame exceeds 1 MiB");
    }
    if (!stopped && pending) throw new Error("Connection ended during an event frame");
    if (!stopped && !subscribed) throw new Error("Connection ended before voice subscription");
    reason = stopped ? "stopped" : "disconnected";
  } catch (error) {
    if (!stopped) throw error;
    reason = "stopped";
  } finally {
    clearTimeout(timer);
    socket.destroy();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("SIGHUP", stop);
    recording.close(reason);
  }
  console.error(
    reason === "stopped"
      ? "Recording stopped."
      : "Voice connection closed; rerun to append more messages.",
  );
}
try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
