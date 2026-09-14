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

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

test("observer retains call identity across frontend disconnect and reconnect without owning it", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "av-observe-")));
  const path = frontendSocketPath(root);
  const id = randomUUID();
  let changed = () => {};
  let phase: FrontendState["phase"] = "negotiating";
  let closed = false;
  let creates = 0;
  const attachments: boolean[] = [];
  const server = new VoiceServer(path, async (notify) => {
    creates++;
    changed = notify;
    return {
      identity: () => ({ workspace: root, threadId: "thread", generation: 7 }),
      state: () => ({
        available: true,
        codingActivity: "unknown" as const,
        phase,
        mic: { muted: false, effectiveMuted: false },
        speaker: { muted: false, effectiveMuted: false },
      }),
      start: async () => {},
      setFrontendAttached: async (attached) => {
        attachments.push(attached);
      },
      close: async () => {
        closed = true;
      },
      command: () => {},
    };
  });
  const states: FrontendObservation[] = [];
  let observer: Awaited<ReturnType<typeof observeFrontend>> | undefined;
  let client: Awaited<ReturnType<typeof connectFrontend>> | undefined;
  let reconnected: typeof client;
  try {
    await server.start();
    observer = await observeFrontend(path, (state) => states.push(state));
    expect(observer.initial.busy).toBe(false);
    await expect(
      observer.socket.request("call", { clientId: crypto.randomUUID() }),
    ).rejects.toThrow("Observers cannot own");
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
      generation: 7,
      state: { phase: "live" },
    });
    const second = await observeFrontend(path, () => {});
    expect(second.initial).toMatchObject({ clientId: id, state: { phase: "live" } });
    second.socket.close();
    await second.socket.done;
    expect(closed).toBe(false);
    await client.close();
    while (states.at(-1)?.busy && Date.now() < deadline) await Bun.sleep(5);
    expect(states.at(-1)).toMatchObject({
      busy: false,
      clientId: null,
      workspace: root,
      threadId: "thread",
      generation: 7,
      state: null,
    });
    expect(closed).toBe(false);
    expect(attachments).toEqual([true, false]);
    reconnected = await connectFrontend(path, () => {}, randomUUID());
    await until(() => attachments.at(-1) === true);
    expect(creates).toBe(1);
    expect(states.at(-1)).toMatchObject({ workspace: root, threadId: "thread", generation: 7 });
    await reconnected.close();
    await server.close();
    expect(closed).toBe(true);
  } finally {
    observer?.socket.close();
    await client?.close();
    await reconnected?.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("media detach observation wait ends on server shutdown or observer disconnect", async () => {
  for (const end of ["server", "observer"] as const) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "av-observe-close-")));
    const stopping = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const server = new VoiceServer(frontendSocketPath(root), async () => ({
      state: () => ({
        available: true,
        codingActivity: "unknown" as const,
        phase: "live",
        mic: { muted: false, effectiveMuted: false },
        speaker: { muted: false, effectiveMuted: false },
      }),
      start: async () => {},
      command: () => {},
      setFrontendAttached: async (attached) => {
        if (attached) return;
        stopping.resolve();
        await cleanup.promise;
      },
      close: async () => {},
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
