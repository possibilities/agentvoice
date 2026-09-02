import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventJournal } from "../src/events.ts";
import {
  describeSidecar,
  VoiceSession,
  type VoiceSessionOptions,
} from "../src/tui/voice-session.ts";

const FAKE_SIDECAR = join(import.meta.dir, "support", "fake-voice-sidecar.ts");

const sessions: VoiceSession[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "codpiece-session-test-"));
  directories.push(directory);
  return directory;
}

async function start(
  overrides: Partial<VoiceSessionOptions> = {},
  env: Record<string, string> = {},
): Promise<VoiceSession> {
  const previous = { ...process.env };
  Object.assign(process.env, env);
  try {
    const session = await VoiceSession.start({
      sidecarPath: "/nonexistent/sidecar",
      command: ["bun", FAKE_SIDECAR],
      executionProfile: "legacy-app-server",
      workspace: scratch(),
      voice: "cove",
      orchestratorModel: "gpt-5.6-terra",
      reasoningEffort: "medium",
      includeStartupContext: false,
      journal: new EventJournal(),
      ...overrides,
    });
    sessions.push(session);
    return session;
  } finally {
    for (const name of Object.keys(env)) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

describe("sidecar description", () => {
  test("binds the binary to its adjacent metadata", () => {
    const directory = scratch();
    const binary = join(directory, "codex-voice-sidecar");
    writeFileSync(binary, "not really a binary");
    writeFileSync(
      join(directory, "metadata.json"),
      JSON.stringify({
        schemaVersion: 2,
        sourceRevision: "abc123",
        binarySha256: "0000000000000000000000000000000000000000000000000000000000000000",
      }),
    );
    expect(() => describeSidecar(binary)).toThrow("does not match its metadata");
    writeFileSync(join(directory, "metadata.json"), JSON.stringify({ schemaVersion: 3 }));
    expect(describeSidecar(binary)).toMatchObject({
      schemaVersion: 3,
      sourceRevision: null,
      requiresFxCredentialAuthority: true,
    });
  });
});

describe("voice session", () => {
  test("opens a thread and runs one realtime session at a time", async () => {
    const closes: string[] = [];
    const session = await start({ onClosed: (reason) => closes.push(reason) });
    expect(session.threadId).toBe("thread-1");
    expect(session.voices).toEqual({ voices: ["cove"] });
    expect(session.realtimeActive).toBe(false);

    const answer = await session.startRealtime("offer-1");
    expect(answer).toBe("answer:offer-1");
    expect(session.realtimeActive).toBe(true);
    await expect(session.startRealtime("offer-2")).rejects.toThrow("already running");

    await session.stopRealtime();
    expect(session.realtimeActive).toBe(false);
    expect(closes).toEqual([]);

    const second = await session.startRealtime("offer-3");
    expect(second).toBe("answer:offer-3");
  });

  test("surfaces a realtime error and clears the session", async () => {
    const errors: string[] = [];
    const session = await start({ onError: (message) => errors.push(message) });
    await expect(session.startRealtime("please fail")).rejects.toThrow("thread/realtime/error");
    expect(session.realtimeActive).toBe(false);
    expect(errors).toEqual(["boom"]);
    await expect(session.startRealtime("offer-ok")).resolves.toBe("answer:offer-ok");
  });

  test("reports an upstream close as closed, not as a stop we requested", async () => {
    const closes: string[] = [];
    const session = await start(
      { onClosed: (reason) => closes.push(reason) },
      { FAKE_SIDECAR_UPSTREAM_CLOSE_MS: "50" },
    );
    await session.startRealtime("offer-1");
    await Bun.sleep(200);
    expect(closes).toEqual(["transport_closed"]);
    expect(session.realtimeActive).toBe(false);
  });

  test("close is idempotent and stops a running session first", async () => {
    const journal = new EventJournal();
    const session = await start({ journal });
    await session.startRealtime("offer-1");
    await session.close();
    await session.close();
    expect(journal.count("session.closed")).toBe(1);
    expect(journal.count("appserver.thread/realtime/closed")).toBe(1);
  });
});
