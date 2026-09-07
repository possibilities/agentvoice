import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { startControlServer } from "../src/control/index.ts";
import { CONTROL_PROTOCOL_VERSION } from "../src/control/types.ts";
import { EVENT_PROTOCOL_VERSION as v } from "../src/events/contract.ts";
import { eventSocketPath } from "../src/events/socket.ts";

for (const shutdown of ["disconnect", "signal"] as const) {
  test(`voice recorder discovers workspace, opens initial file, records through ${shutdown}`, async () => {
    const root = realpathSync(mkdtempSync("/tmp/av-record-cli-"));
    const stateDir = join(root, "agentvoice");
    const control = await startControlServer({
      stateDir,
      instanceId: "recorder",
      backend: {
        status: () => ({
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          instanceId: "recorder",
          workspace: root,
          threadId: "main",
          generation: 1,
          runtime: { phase: "ready" },
        }),
      },
    });
    const requests: string[] = [];
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let signalTimer: ReturnType<typeof setTimeout> | undefined;
    const server = createServer((socket) => {
      let pending = "";
      socket.on("data", (chunk) => {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop()!;
        for (const line of lines) {
          const request = JSON.parse(line);
          requests.push(request.method);
          const response = { v, type: "response", id: request.id, ok: true };
          if (request.method === "event.subscribe") {
            expect(request.params).toEqual({ events: ["voice.item.*", "runtime.state.changed"] });
            socket.write(`${JSON.stringify({ ...response, result: { subscribed: true } })}\n`);
          } else {
            const context = { instanceId: "recorder", generation: 1, sequence: 1 };
            const runtime = { phase: "ready", workspace: root, mainThreadId: "main" };
            const event = {
              v,
              type: "event",
              event: "voice.item.completed",
              data: {
                ...context,
                threadId: "main",
                item: {
                  id: "a",
                  realtimeSessionId: "call",
                  type: "transcriptSegment",
                  role: "assistant",
                  text: "  Captured 雪  ",
                },
              },
            };
            socket.write(
              [
                { ...response, result: { ...context, runtime, inventory: "ready", threads: [] } },
                event,
              ]
                .map((frame) => `${JSON.stringify(frame)}\n`)
                .join(""),
            );
            if (shutdown === "disconnect") socket.end();
            else signalTimer = setTimeout(() => child?.kill("SIGINT"), 150);
          }
        }
      });
    });
    try {
      const path = eventSocketPath(stateDir, "recorder");
      await new Promise<void>((resolve) => server.listen(path, resolve));
      chmodSync(path, 0o600);
      const recorder = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "../scripts/voice-record.ts"),
          "--workspace",
          root,
          "--out-dir",
          join(root, "recordings"),
        ],
        { env: { ...process.env, XDG_STATE_HOME: root }, stdout: "pipe", stderr: "pipe" },
      );
      child = recorder;
      const timeout = setTimeout(() => child?.kill(), 5_000);
      const [stdout, stderr, exit] = await Promise.all([
        new Response(recorder.stdout).text(),
        new Response(recorder.stderr).text(),
        recorder.exited,
      ]);
      clearTimeout(timeout);
      expect(exit, stderr).toBe(0);
      expect(requests).toEqual(["event.subscribe", "state.get"]);
      expect(stdout.trim()).toBe(join(root, "recordings", "main.jsonl"));
      const records = readFileSync(stdout.trim(), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records[2].data.item.text).toBe("  Captured 雪  ");
      expect(records.at(-1)).toMatchObject({
        type: "recording.ended",
        reason: shutdown === "signal" ? "stopped" : "disconnected",
      });
    } finally {
      clearTimeout(signalTimer);
      if (child && child.exitCode === null) {
        child.kill();
        await child.exited;
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await control.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
