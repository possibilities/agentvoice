import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startControlServer } from "../../src/control/index.ts";
import { CONTROL_PROTOCOL_VERSION } from "../../src/control/types.ts";
import { ObservationError } from "../../src/events/conversation.ts";
import { LifecycleFeed } from "../../src/events/feed.ts";
import { EventSocketServer, eventSocketPath } from "../../src/events/socket.ts";
import { connectFrontend } from "../../src/frontend/client.ts";
import { frontendSocketPath } from "../../src/frontend/protocol.ts";
import { VoiceServer } from "../../src/frontend/server.ts";
import { recordingDirectory } from "../../src/recording/store.ts";
import type { AgentItem } from "../server/messages.ts";

export async function fixture(attachment?: (value: unknown) => Promise<unknown>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "av-web-")));
  const stateDir = join(root, "agentvoice");
  const instanceId = randomUUID();
  const feed = new LifecycleFeed(instanceId);
  let generation = 1;
  let threadId = "main";
  let changed = () => {};
  let starts = 0;
  let closes = 0;
  const methods: string[] = [];
  let history: AgentItem[] = [];
  let delayHistory: Promise<void> | undefined;
  const forbidden = async (): Promise<never> => {
    throw new Error("Mutation forbidden");
  };
  const control = await startControlServer({
    stateDir,
    instanceId,
    attachment,
    backend: {
      status: () => ({
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        instanceId,
        generation,
        workspace: root,
        threadId,
        runtime: { phase: "ready" },
        recentOperations: [],
      }),
      redial: forbidden,
      restart: forbidden,
      newSession: forbidden,
      mailboxOpen: forbidden,
      voiceSet: forbidden,
    },
  });
  const events = new EventSocketServer(
    eventSocketPath(stateDir, instanceId),
    feed,
    async (method, params) => {
      methods.push(method);
      if (
        params.expectedInstanceId !== instanceId ||
        params.expectedGeneration !== generation ||
        params.rootThreadId !== threadId ||
        !("threadId" in params) ||
        params.threadId !== threadId
      )
        throw new ObservationError("stale_generation");
      if (method === "conversation.live.get") return feed.live(threadId);
      if (method !== "conversation.items.list") throw new Error(`Unexpected method ${method}`);
      const selected = history;
      const selectedThread = threadId;
      const selectedGeneration = generation;
      await delayHistory;
      const offset = "cursor" in params ? Number(params.cursor ?? 0) : 0;
      const page = [...selected].reverse().slice(offset, offset + 2);
      return {
        method,
        instanceId,
        generation: selectedGeneration,
        rootThreadId: selectedThread,
        threadId: selectedThread,
        data: page,
        revisionBefore: 0,
        revisionAfter: 0,
        changedDuringRead: false,
        nextCursor: offset + 2 < selected.length ? String(offset + 2) : null,
      };
    },
  );
  await events.start();
  const server = new VoiceServer(frontendSocketPath(stateDir), async (notify) => {
    starts++;
    changed = notify;
    return {
      identity: () => ({ workspace: root, threadId, generation }),
      state: () => ({
        available: true,
        codingActivity: "unknown",
        phase: "live",
        mic: { muted: true, effectiveMuted: true },
        speaker: { muted: true, effectiveMuted: true },
      }),
      start: async () => {},
      command: (command) => {
        if (command.action !== "release") throw new Error("No pointer input");
      },
      close: async () => {
        closes++;
      },
    };
  });
  await server.start();
  const runtime = () =>
    feed.runtime(generation, { phase: "ready", workspace: root, mainThreadId: threadId });
  runtime();
  let owner: Awaited<ReturnType<typeof connectFrontend>> | undefined;
  const recording = () => {
    const directory = recordingDirectory(stateDir, root);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${threadId}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({ type: "voice_transcript", format: "agentvoice", workspace: root, threadId })}\n`,
      { mode: 0o600 },
    );
    return path;
  };
  let recordingPath = recording();
  return {
    stateDir,
    root,
    feed,
    methods,
    control,
    counts: () => ({ starts, closes }),
    history: (rows: AgentItem[]) => {
      history = rows;
    },
    delayHistory: (delay?: Promise<void>) => {
      delayHistory = delay;
    },
    voice: (event: string, data: object) =>
      appendFileSync(
        recordingPath,
        `${JSON.stringify({ v: 2, type: "event", event, data: { ...data, threadId, instanceId, generation, sequence: 1 }, observedAt: "2026-09-13T12:00:00Z" })}\n`,
      ),
    start: async () => {
      owner = await connectFrontend(server.path, () => {}, randomUUID());
    },
    hangup: async () => {
      await owner?.close();
      owner = undefined;
    },
    replace: (nextThread = threadId) => {
      generation++;
      threadId = nextThread;
      runtime();
      changed();
      recordingPath = recording();
    },
    close: async () => {
      await owner?.close();
      await server.close();
      events.close();
      await control.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
