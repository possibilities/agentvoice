import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceRuntime } from "../src/core/runtime.ts";
import { voiceContinuity } from "../src/recording/continuity.ts";
import { recordingDirectory } from "../src/recording/store.ts";
import { VoiceRecording } from "../src/recording/writer.ts";
import { runtimeHarness } from "./fixtures/runtime-harness.ts";

function speech(
  writer: VoiceRecording,
  threadId: string,
  id: string,
  role: "user" | "assistant",
  text: string,
  event = "voice.item.completed",
) {
  writer.accept({
    v: 2,
    type: "event",
    event,
    data: {
      instanceId: "controller",
      generation: 1,
      sequence: 1,
      threadId,
      item: { id, realtimeSessionId: "old-call", type: "transcriptSegment", role, text },
    },
  });
}

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "voice-context-")));
  const writer = new VoiceRecording(directory, recordingDirectory(directory, directory));
  writer.openThread("root");
  return {
    directory,
    writer,
    path: join(recordingDirectory(directory, directory), "root.jsonl"),
    read: () => voiceContinuity(directory, directory, "root"),
    cleanup() {
      writer.close("stopped");
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("same-root voice continuity", () => {
  test("completed speech retains roles, deduplicates completion, skips partial speech and isolates roots", () => {
    const f = fixture();
    try {
      speech(f.writer, "root", "1", "user", "Say ding-ding when an item closes.");
      speech(f.writer, "root", "2", "assistant", "Ding-ding, six remain.");
      speech(f.writer, "root", "2", "assistant", "Ding-ding, six remain.");
      speech(f.writer, "root", "3", "user", "unfinished", "voice.item.started");
      const result = f.read();
      expect(result.truncated).toBe(false);
      expect(result.items.slice(0, -1)).toEqual([
        { role: "user", text: "Say ding-ding when an item closes." },
        { role: "assistant", text: "Ding-ding, six remain." },
      ]);
      expect(result.items.at(-1)?.role).toBe("developer");
      expect(result.items.at(-1)?.text).toContain("Wait for new user input");
      expect(voiceContinuity(f.directory, f.directory, "new-root").items).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  test("whole recent messages stay below native count and UTF-8 token limits", () => {
    const f = fixture();
    try {
      for (let i = 0; i < 160; i++) speech(f.writer, "root", String(i), "user", `message ${i}`);
      expect(f.read().items).toHaveLength(128);
      expect(f.read().truncated).toBe(true);
      speech(f.writer, "root", "unicode", "assistant", "🙂".repeat(7000));
      const { items, truncated } = f.read();
      expect(truncated).toBe(true);
      expect(items.at(-2)?.text).toBe("🙂".repeat(7000));
      expect(
        items.reduce((sum, item) => sum + Math.ceil(Buffer.byteLength(item.text) / 4), 0),
      ).toBeLessThanOrEqual(8192);
    } finally {
      f.cleanup();
    }
  });

  test("incomplete tail is ignored without altering disk; unsafe or foreign records are refused", () => {
    const f = fixture();
    try {
      speech(f.writer, "root", "1", "user", "retained");
      appendFileSync(f.path, '{"type":');
      const before = readFileSync(f.path);
      expect(f.read().items[0]?.text).toBe("retained");
      expect(f.read().truncated).toBe(true);
      expect(readFileSync(f.path)).toEqual(before);
      chmodSync(f.path, 0o644);
      expect(f.read).toThrow("Unsafe");
      chmodSync(f.path, 0o600);
      writeFileSync(f.path, before.toString().replace('"threadId":"root"', '"threadId":"foreign"'));
      expect(f.read).toThrow("identity mismatch");
    } finally {
      f.cleanup();
    }
  });

  test("symlink input is rejected", () => {
    const f = fixture();
    try {
      symlinkSync(f.path, join(recordingDirectory(f.directory, f.directory), "alias.jsonl"));
      expect(() => voiceContinuity(f.directory, f.directory, "alias")).toThrow();
    } finally {
      f.cleanup();
    }
  });

  test("redial, detach/reattach and replacement restore latest speech without submitting work", async () => {
    const h = runtimeHarness({}, { savedThread: "existing" });
    h.native.main("existing", h.directory);
    h.runtimeOptions.nativeStateDir = h.directory;
    const writer = new VoiceRecording(h.directory, recordingDirectory(h.directory, h.directory));
    writer.openThread("existing");
    let replacement: VoiceRuntime | undefined;
    const offer = async (runtime: VoiceRuntime) => {
      const before = h.native.calls.length;
      await runtime.offer("sdp");
      const calls = h.native.calls.slice(before);
      expect(calls.map((c) => c.method)).toEqual(["thread/realtime/start"]);
      const params = calls[0]!.params;
      expect(params["threadId"]).toBe("existing");
      expect(params["initialItems"]).toContainEqual({
        role: "user",
        text: "Ring two bells on closure",
      });
      h.native.options.onNotification("thread/realtime/started", params);
      return params;
    };
    try {
      await h.runtime.start();
      speech(writer, "existing", "1", "user", "Ring two bells on closure");
      await offer(h.runtime);
      speech(writer, "existing", "2", "assistant", "Ding-ding, six remain");
      expect((await offer(h.runtime))["initialItems"]).toContainEqual({
        role: "assistant",
        text: "Ding-ding, six remain",
      });
      await h.runtime.setVoiceAttached(false);
      await h.runtime.setVoiceAttached(true);
      await offer(h.runtime);
      await h.runtime.shutdown();
      writer.close("stopped");
      h.native.alive = true;
      replacement = new VoiceRuntime(h.config, "test", h.events, h.runtimeOptions);
      await replacement.start();
      await offer(replacement);
      expect(
        h.native.calls.some(
          (c) => c.method === "turn/start" || c.method === "thread/realtime/appendText",
        ),
      ).toBe(false);
    } finally {
      await replacement?.shutdown();
      writer.close("stopped");
      await h.cleanup();
    }
  });

  test("voice append instructions coexist with history; invalid recording warns without losing the root", async () => {
    const h = runtimeHarness({}, { savedThread: "existing" });
    h.native.main("existing", h.directory);
    h.runtimeOptions.nativeStateDir = h.directory;
    const warnings: string[] = [];
    h.events.onWarning = (warning) => warnings.push(warning);
    writeFileSync(
      join(h.directory, "VOICE_AGENT_APPEND_SYSTEM_PROMPT.md"),
      "Keep this role guidance.",
    );
    const dir = recordingDirectory(h.directory, h.directory);
    const writer = new VoiceRecording(h.directory, dir);
    speech(writer, "existing", "1", "user", "Remember the bell agreement");
    try {
      await h.runtime.start();
      await h.runtime.offer("first");
      const first = h.native.calls.at(-1)!.params;
      expect(first["includeStartupContext"]).toBe(true);
      expect(first["initialItems"]).toContainEqual({
        role: "user",
        text: "Remember the bell agreement",
      });
      const resume = h.native.calls.find((c) => c.method === "thread/resume")!.params;
      expect(resume["config"]).toMatchObject({
        experimental_realtime_ws_startup_context: "Keep this role guidance.",
      });
      h.native.options.onNotification("thread/realtime/started", first);
      appendFileSync(join(dir, "existing.jsonl"), "invalid completed record\n");
      await h.runtime.offer("redial");
      expect(h.native.calls.at(-1)!.params).not.toHaveProperty("initialItems");
      expect(warnings).toContain(
        "Voice continuity is unavailable; working-thread history is retained",
      );
      expect(h.runtime.currentReady?.threadId).toBe("existing");
      expect(h.native.calls.some((c) => c.method === "turn/start")).toBe(false);
    } finally {
      writer.close("stopped");
      await h.cleanup();
    }
  });

  test("native completion survives delayed controller persistence and is not duplicated after disk catches up", async () => {
    const h = runtimeHarness({}, { savedThread: "existing" });
    h.native.main("existing", h.directory);
    h.runtimeOptions.nativeStateDir = h.directory;
    const writer = new VoiceRecording(h.directory, recordingDirectory(h.directory, h.directory));
    writer.openThread("existing");
    const pending: Array<() => void> = [];
    // This is the production child→controller callback boundary; hold its disk side.
    h.runtimeOptions.onVoice = (notification) =>
      pending.push(() =>
        writer.accept({
          v: 2,
          type: "event",
          ...notification,
          data: { ...notification.data, instanceId: "controller", generation: 1, sequence: 1 },
        }),
      );
    const item = {
      id: "just-spoken",
      realtimeSessionId: "old-call",
      type: "transcriptSegment",
      role: "user",
      text: "Ring five bells when zero remain",
    };
    try {
      await h.runtime.start();
      h.native.options.onNotification("thread/realtime/item/completed", {
        threadId: "existing",
        item,
      });
      expect(pending).toHaveLength(1);
      expect(voiceContinuity(h.directory, h.directory, "existing").items).toEqual([]);
      for (const flush of [false, true]) {
        if (flush) pending.shift()!();
        await h.runtime.offer("redial");
        const params = h.native.calls.at(-1)!.params;
        const items = params["initialItems"] as Array<{ text: string }>;
        expect(items.filter((i) => i.text === item.text)).toHaveLength(1);
        h.native.options.onNotification("thread/realtime/started", params);
      }
      expect(h.native.calls.some((c) => c.method === "turn/start")).toBe(false);
    } finally {
      writer.close("stopped");
      await h.cleanup();
    }
  });

  test("an oversized newest complete utterance reports the bound without inventing a partial message", () => {
    const f = fixture();
    try {
      speech(f.writer, "root", "1", "user", "older");
      speech(f.writer, "root", "2", "user", "x".repeat(32769));
      expect(f.read()).toEqual({ items: [], truncated: true });
    } finally {
      f.cleanup();
    }
  });

  for (const extra of [
    { initialItems: [] },
    { initialItems: null },
    { initialItems: [{ role: "developer", text: "custom" }] },
    { version: "v1" },
    { version: "v3", transport: { type: "existingCall", callId: "owned-call" } },
  ]) {
    test(`explicit context/protocol remains authoritative: ${JSON.stringify(extra)}`, async () => {
      const h = runtimeHarness({ voice: { extra } }, { savedThread: "existing" });
      h.native.main("existing", h.directory);
      h.runtimeOptions.nativeStateDir = h.directory;
      const writer = new VoiceRecording(h.directory, recordingDirectory(h.directory, h.directory));
      speech(writer, "existing", "1", "user", "old speech");
      try {
        await h.runtime.start();
        await h.runtime.offer("sdp");
        const params = h.native.calls.at(-1)!.params;
        expect(params).toMatchObject(extra);
        if (!("initialItems" in extra)) expect(params).not.toHaveProperty("initialItems");
      } finally {
        writer.close("stopped");
        await h.cleanup();
      }
    });
  }
});
