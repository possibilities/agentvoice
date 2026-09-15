import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectFrontend } from "../src/frontend/client.ts";
import { frontendSocketPath } from "../src/frontend/protocol.ts";
import { VoiceServer } from "../src/frontend/server.ts";

// Exercise the actual TUI transport policy without loading devices or the renderer.
test("automatic terminal takeover replaces a connected owner and retains native work", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-tui-takeover-"));
  let creates = 0;
  let starts = 0;
  let closes = 0;
  const attachments: boolean[] = [];
  const server = new VoiceServer(frontendSocketPath(root), async () => {
    creates++;
    return {
      start: async () => {
        starts++;
      },
      close: async () => {
        closes++;
      },
      command: () => {},
      identity: () => ({ workspace: root, threadId: "retained-root", generation: 1 }),
      setFrontendAttached: async (attached) => {
        attachments.push(attached);
      },
      state: () => ({
        available: true,
        codingActivity: "working" as const,
        phase: "live" as const,
        mic: { muted: true, effectiveMuted: true },
        speaker: { muted: false, effectiveMuted: false },
      }),
    };
  });
  let first: Awaited<ReturnType<typeof connectFrontend>> | undefined;
  let second: typeof first;
  try {
    await server.start();
    first = await connectFrontend(server.path);
    second = await connectFrontend(server.path, () => {}, undefined, { takeover: "auto" });
    await first.done;
    expect(creates).toBe(1);
    expect(starts).toBe(1);
    expect(closes).toBe(0);
    expect(attachments).toEqual([true, false, true]);
    expect(second.state().codingActivity).toBe("working");
    await second.close();
    await server.close();
    expect(closes).toBe(1);
  } finally {
    await first?.close();
    await second?.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
