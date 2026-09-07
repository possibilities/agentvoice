import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectFrontend } from "../src/frontend/client.ts";
import { observeFrontend } from "../src/frontend/observer.ts";
import {
  type FrontendObservation,
  type FrontendState,
  frontendSocketPath,
} from "../src/frontend/protocol.ts";
import { VoiceServer } from "../src/frontend/server.ts";

test("read-only observer gets current and future call identity without owning or closing a call", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "av-observe-")));
  const path = frontendSocketPath(root);
  const id = randomUUID();
  let changed = () => {};
  let phase: FrontendState["phase"] = "negotiating";
  let closed = false;
  const server = new VoiceServer(path, async (notify) => {
    changed = notify;
    return {
      identity: () => ({ workspace: root, threadId: "thread" }),
      state: () => ({
        available: true,
        phase,
        mic: { muted: false, effectiveMuted: false },
        speaker: { muted: false, effectiveMuted: false },
      }),
      start: async () => {},
      close: async () => {
        closed = true;
      },
      command: () => {},
    };
  });
  const states: FrontendObservation[] = [];
  let observer: Awaited<ReturnType<typeof observeFrontend>> | undefined;
  let client: Awaited<ReturnType<typeof connectFrontend>> | undefined;
  try {
    await server.start();
    observer = await observeFrontend(path, (state) => states.push(state));
    expect(observer.initial.busy).toBe(false);
    await expect(observer.socket.request("call")).rejects.toThrow("Observers cannot own");
    await expect(observer.socket.request("input", { action: "release" })).rejects.toThrow(
      "does not own",
    );
    client = await connectFrontend(path, () => {}, id);
    phase = "live";
    changed();
    const deadline = Date.now() + 2000;
    while (!states.some((state) => state.state?.phase === "live") && Date.now() < deadline)
      await Bun.sleep(5);
    expect(states.at(-1)).toMatchObject({
      busy: true,
      clientId: id,
      workspace: root,
      threadId: "thread",
      state: { phase: "live" },
    });
    const second = await observeFrontend(path, () => {});
    expect(second.initial).toMatchObject({ clientId: id, state: { phase: "live" } });
    second.socket.close();
    await second.socket.done;
    expect(closed).toBe(false);
    await client.close();
    while (states.at(-1)?.busy && Date.now() < deadline) await Bun.sleep(5);
    expect(states.at(-1)).toMatchObject({ busy: false, clientId: null, state: null });
    expect(closed).toBe(true);
  } finally {
    observer?.socket.close();
    await client?.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup observation wait ends on server shutdown or observer disconnect", async () => {
  for (const end of ["server", "observer"] as const) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "av-observe-close-")));
    const stopping = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const server = new VoiceServer(frontendSocketPath(root), async () => ({
      state: () => ({
        available: true,
        phase: "live",
        mic: { muted: false, effectiveMuted: false },
        speaker: { muted: false, effectiveMuted: false },
      }),
      start: async () => {},
      command: () => {},
      close: async () => {
        stopping.resolve();
        await cleanup.promise;
      },
    }));
    let observer: Awaited<ReturnType<typeof observeFrontend>> | undefined;
    let shutdown: Promise<void> | undefined;
    try {
      await server.start();
      const first = await connectFrontend(server.path);
      await first.close();
      await stopping.promise;
      observer = await observeFrontend(server.path, () => {});
      expect(observer.initial.availability).toBe("closing");
      const result = observer.waitUntilAvailable().catch((error: Error) => error);
      if (end === "server") shutdown = server.close();
      else observer.socket.close();
      expect(await result).toBeInstanceOf(Error);
      expect(((await result) as Error).message).toContain(
        end === "server" ? "unavailable" : "disconnected",
      );
    } finally {
      cleanup.resolve();
      observer?.socket.close();
      await shutdown;
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
