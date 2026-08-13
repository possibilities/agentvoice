import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { tokenPath } from "../paths.ts";
import {
  AGENTVOICE_THREAD_IDENTITIES_METHOD,
  AGENTVOICE_VOICE_OBSERVATION_METHOD,
} from "../protocol.ts";
import { ChatsConnection, ChatsConnectionError } from "./client.ts";
import { ChatsModel, type RawStreamEvent } from "./model.ts";
import { runChatsUi } from "./ui.ts";

export interface ChatsConfig {
  url: string;
  token?: string;
  version: string;
}

function readToken(): string {
  const path = tokenPath(process.env, homedir());
  try {
    const token = readFileSync(path, "utf8").trim();
    if (token) return token;
  } catch {
    // The error below names the recovery and stable path contract.
  }
  throw new ChatsConnectionError(
    `no AgentVoice connection token at ${path} — start agentvoice server first or pass --token`,
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function runChats(config: ChatsConfig): Promise<void> {
  const model = new ChatsModel();
  let eventHandler: ((event: RawStreamEvent) => void) | null = null;
  let connected = false;
  const connection = new ChatsConnection({
    url: config.url,
    token: config.token ?? readToken(),
    version: config.version,
    onFrame(params) {
      const event = model.recordEnvelope(params);
      if (event) eventHandler?.(event);
    },
    onNotification(method, params) {
      if (method === AGENTVOICE_THREAD_IDENTITIES_METHOD) {
        model.replaceAgentVoiceThreadIdentities(params["data"]);
      } else if (method === AGENTVOICE_VOICE_OBSERVATION_METHOD) {
        const event = model.recordVoiceObservation(params);
        if (event) eventHandler?.(event);
      }
    },
    onClosed() {
      connected = false;
    },
  });
  const ensureConnected = async (): Promise<void> => {
    if (connected) return;
    await connection.connect();
    connected = true;
  };
  await ensureConnected();

  const loadedThreadIds = async (): Promise<string[]> => {
    await ensureConnected();
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const result = record(
        await connection.request("thread/loaded/list", {
          ...(cursor ? { cursor } : {}),
          limit: 100,
        }),
      );
      if (!result) throw new ChatsConnectionError("thread/loaded/list returned no result");
      const page = Array.isArray(result["data"])
        ? result["data"].filter((id): id is string => typeof id === "string")
        : [];
      ids.push(...page);
      cursor = typeof result["nextCursor"] === "string" ? result["nextCursor"] : null;
    } while (cursor);
    return ids;
  };

  const refreshThreads = async (reread = false): Promise<void> => {
    const ids = await loadedThreadIds();
    const known = new Map(
      ids.flatMap((id) => {
        const card = model.threads.get(id);
        return card ? [[id, card.raw] as const] : [];
      }),
    );
    const idsToRead = reread ? ids : ids.filter((id) => !known.has(id));
    const reads = await Promise.allSettled(
      idsToRead.map((threadId) =>
        connection.request("thread/read", { threadId, includeTurns: false }),
      ),
    );
    for (const [index, read] of reads.entries()) {
      if (read.status !== "fulfilled") continue;
      const result = record(read.value);
      const id = idsToRead[index];
      const thread = record(result?.["thread"]);
      if (id && thread) known.set(id, thread);
    }
    model.replaceThreads(ids.flatMap((id) => (known.has(id) ? [known.get(id)] : [])));
  };

  try {
    await refreshThreads();
    await runChatsUi({
      connection,
      model,
      refreshThreads,
      setEventHandler(handler) {
        eventHandler = handler;
      },
      onClosed() {
        eventHandler = null;
      },
    });
  } finally {
    connection.close();
  }
}
