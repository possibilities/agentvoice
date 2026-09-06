import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { startControlServer } from "../src/control/index.ts";
import { CONTROL_PROTOCOL_VERSION } from "../src/control/types.ts";
import { EVENT_PROTOCOL_VERSION } from "../src/events/contract.ts";
import { eventSocketPath } from "../src/events/socket.ts";

for (const flags of [[], ["--stream"], ["--completed"]]) {
  const streaming = !flags.includes("--completed");
  for (const version of [
    EVENT_PROTOCOL_VERSION - 1,
    EVENT_PROTOCOL_VERSION,
    EVENT_PROTOCOL_VERSION + 1,
  ]) {
    test(`voice viewer handles controller event protocol ${version}, flags=${JSON.stringify(flags)}`, async () => {
      const root = realpathSync(mkdtempSync("/tmp/av-viewer-"));
      const stateDir = join(root, "agentvoice");
      const control = await startControlServer({
        stateDir,
        instanceId: "viewer",
        backend: {
          status: () => ({
            protocolVersion: CONTROL_PROTOCOL_VERSION,
            instanceId: "viewer",
            workspace: root,
            threadId: "main",
            generation: 1,
            runtime: { phase: "failed" },
            recentOperations: [],
          }),
          redial: async () => {
            throw new Error("unexpected mutation");
          },
          restart: async () => {
            throw new Error("unexpected mutation");
          },
        },
      });
      const requests: Array<{ v: number; params: unknown }> = [];
      const server = createServer((socket) => {
        let pending = "";
        socket.on("data", (chunk) => {
          pending += chunk.toString();
          const lines = pending.split("\n");
          pending = lines.pop()!;
          for (const line of lines) {
            const request = JSON.parse(line);
            requests.push(request);
            const response = { v: version, type: "response", id: request.id };
            if (request.v !== version) {
              socket.write(
                `${JSON.stringify({ ...response, ok: false, error: { code: "invalid_request", message: "invalid socket request" } })}\n`,
              );
              continue;
            }
            const event = (name: string, item: unknown) => ({
              v: version,
              type: "event",
              event: name,
              data: { threadId: "main", item },
            });
            const segment = (role: string, text: string) => ({
              id: role,
              realtimeSessionId: "session",
              type: "transcriptSegment",
              role,
              text,
            });
            socket.end(
              [
                { ...response, ok: true },
                event("voice.item.started", segment("user", "")),
                event("conversation.item.completed", segment("assistant", "ignore")),
                event("voice.item.completed", {
                  id: "session",
                  realtimeSessionId: "session",
                  type: "realtimeSessionStarted",
                }),
                event("voice.item.completed", segment("user", "Hello café")),
                event("voice.item.completed", segment("assistant", "Hi 👋")),
              ]
                .map((frame) => `${JSON.stringify(frame)}\n`)
                .join(""),
            );
          }
        });
      });
      let child: ReturnType<typeof Bun.spawn> | undefined;
      try {
        const path = eventSocketPath(stateDir, "viewer");
        await new Promise<void>((resolve) => server.listen(path, resolve));
        chmodSync(path, 0o600);
        const viewer = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, "../scripts/voice-messages.ts"),
            "--workspace",
            root,
            ...flags,
          ],
          { env: { ...process.env, XDG_STATE_HOME: root }, stdout: "pipe", stderr: "pipe" },
        );
        child = viewer;
        const timeout = setTimeout(() => child?.kill(), 3_000);
        const [stdout, stderr, exit] = await Promise.all([
          new Response(viewer.stdout).text(),
          new Response(viewer.stderr).text(),
          viewer.exited,
        ]);
        clearTimeout(timeout);
        expect(requests.map((request) => request.v)).toEqual([EVENT_PROTOCOL_VERSION]);
        for (const request of requests)
          expect(request.params).toEqual({
            events: streaming ? ["voice.item.*"] : ["voice.item.completed"],
          });
        if (version !== EVENT_PROTOCOL_VERSION) {
          expect(exit).toBe(1);
          expect(stdout).toBe("");
          expect(stderr).toContain(`Event protocol mismatch: controller uses ${version}`);
          expect(stderr).toContain("fully quit and relaunch AgentVoice");
        } else {
          expect(exit).toBe(0);
          expect(stdout).toBe("user: Hello café\nassistant: Hi 👋\n");
          expect(stderr).toContain(
            streaming ? "Streaming voice messages" : "Listening for completed voice messages",
          );
        }
      } finally {
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
}
