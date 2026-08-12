import { describe, expect, test } from "bun:test";
import type { ServerConfig } from "../src/server/config.ts";
import { ConfigWatcher, configWithVoiceName } from "../src/server/config-watch.ts";
import { realtimeParams } from "../src/server/params.ts";

function config(voiceName: string | undefined, model = "orchestrator-a"): ServerConfig {
  return {
    port: 7890,
    codex: "codex",
    debug: false,
    configDir: "/config",
    accounts: { balance: false, switchThreshold: 95 },
    orchestrator: {
      workspace: "/workspace",
      sandbox: "read-only",
      approvalPolicy: "never",
      model,
    },
    voice: { version: "v3", name: voiceName },
  };
}

function harness(initialName = "cove") {
  let next: ServerConfig | Error = config(initialName);
  const redials: Array<string | undefined> = [];
  const rejected: unknown[] = [];
  const watcher = new ConfigWatcher(
    {
      path: "/config/server.json",
      load: () => (next instanceof Error ? Promise.reject(next) : Promise.resolve(next)),
    },
    config(initialName),
    {
      voiceNameChanged: (name) => redials.push(name),
      rejected: (error) => rejected.push(error),
    },
  );
  return {
    watcher,
    redials,
    rejected,
    setNext(value: ServerConfig | Error) {
      next = value;
    },
  };
}

describe("reactive voice config", () => {
  test("applies a valid voice.name change once", async () => {
    const run = harness();
    run.setNext(config("ember"));
    await run.watcher.reload();
    expect(run.redials).toEqual(["ember"]);
    expect(run.rejected).toEqual([]);
  });

  test("rejects an invalid voice without advancing the applied value", async () => {
    const run = harness();
    run.setNext(config("marin"));
    await run.watcher.reload();
    expect(run.redials).toEqual([]);
    expect(run.rejected).toHaveLength(1);

    run.setNext(config("ember"));
    await run.watcher.reload();
    expect(run.redials).toEqual(["ember"]);
  });

  test("keeps the current session on an invalid config file", async () => {
    const run = harness();
    run.setNext(new Error("voice.name must be a string"));
    await run.watcher.reload();
    expect(run.redials).toEqual([]);
    expect(run.rejected).toHaveLength(1);
  });

  test("ignores unrelated and no-op changes", async () => {
    const run = harness();
    run.setNext(config("cove", "orchestrator-b"));
    await run.watcher.reload();
    await run.watcher.reload();
    expect(run.redials).toEqual([]);
    expect(run.rejected).toEqual([]);
  });

  test("a replacement changes only the realtime voice and preserves the thread", () => {
    const initial = config("cove");
    const replacement = configWithVoiceName(initial, "vale");
    const params = realtimeParams(replacement, {}, "thread-persistent", "rt-replacement", "v=0");

    expect(replacement.orchestrator).toBe(initial.orchestrator);
    expect(initial.voice.name).toBe("cove");
    expect(params).toMatchObject({
      threadId: "thread-persistent",
      realtimeSessionId: "rt-replacement",
      voice: "vale",
    });
  });
});
