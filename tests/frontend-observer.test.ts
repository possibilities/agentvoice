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
