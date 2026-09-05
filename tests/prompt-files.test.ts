import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEGACY_PROMPT_FILES,
  PROMPT_FIELDS,
  type PromptFilesValues,
  parseJsonConfig,
  promptPaths,
  readPrompts,
  resolveConfig,
} from "../src/core/config.ts";
import { loadLaunchConfig, parseArgs } from "../src/main.ts";
import { runtimeHarness } from "./fixtures/runtime-harness.ts";

describe("explicit prompt files", () => {
  test("strict optional paths; empty text is a file content choice, not an empty path", () => {
    expect(parseJsonConfig("{}", "settings")).not.toHaveProperty("prompt-files");
    expect(resolveConfig({}, {}, {}, "/test")).not.toHaveProperty("promptFiles");
    expect(parseJsonConfig('{"prompt-files":{}}', "settings")).toEqual({ "prompt-files": {} });
    for (const key of Object.keys(PROMPT_FIELDS)) {
      expect(
        parseJsonConfig(
          JSON.stringify({ "prompt-files": { [key]: "../my prompt.md" } }),
          "settings",
        ),
      ).toEqual({ "prompt-files": { [key]: "../my prompt.md" } });
      for (const value of ["", " \n ", null, false, 42, [], {}])
        expect(() =>
          parseJsonConfig(JSON.stringify({ "prompt-files": { [key]: value } }), "settings"),
        ).toThrow(`prompt-files.${key}`);
    }
    expect(() => parseJsonConfig('{"prompt-files":{"typo":"x"}}', "settings")).toThrow(
      'unknown option "prompt-files.typo"',
    );
    expect(() =>
      parseJsonConfig('{"prompt-files":{"__proto__":{"polluted":true}}}', "settings"),
    ).toThrow('unknown option "prompt-files.__proto__"');
    for (const value of [null, [], "file"])
      expect(() => parseJsonConfig(JSON.stringify({ "prompt-files": value }), "settings")).toThrow(
        "prompt-files",
      );
  });

  test("paths use the selected config directory, not workspace; CLI values win per role", () => {
    const config = resolveConfig(
      { "prompt-files": { voice: "cli.md", orchestrator: undefined } },
      {
        orchestrator: { workspace: "/workspace" },
        "prompt-files": {
          voice: "file.md",
          orchestrator: "~/work.md",
          "voice-seed-user": "/shared/seed.md",
        },
      },
      {},
      "/test-home",
      { configDir: "/settings", launchCwd: "/launch" },
    );
    expect(config.promptFiles).toEqual({
      voice: "/settings/cli.md",
      orchestrator: "/test-home/work.md",
      "voice-seed-user": "/shared/seed.md",
    });
    expect(promptPaths(config)).toEqual([
      "/settings/cli.md",
      "/test-home/work.md",
      "/shared/seed.md",
    ]);
  });

  test("--config relocation loads arbitrary explicit names and preserves empty/Unicode text", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentvoice-explicit-prompts-"));
    try {
      mkdirSync(join(root, "settings"));
      writeFileSync(join(root, "settings/voice.txt"), "");
      writeFileSync(join(root, "settings/work.txt"), "Speak precisely 🎤\n");
      writeFileSync(
        join(root, "settings/settings.json"),
        JSON.stringify({ "prompt-files": { voice: "voice.txt", orchestrator: "work.txt" } }),
      );
      const config = await loadLaunchConfig(
        parseArgs(["--config", "settings/settings.json"]),
        root,
      );
      expect(await readPrompts(config)).toEqual({
        voicePrompt: "",
        orchestratorDeveloperInstructions: "Speak precisely 🎤\n",
      });
      expect(promptPaths(config)).toEqual([
        join(root, "settings/voice.txt"),
        join(root, "settings/work.txt"),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("all legacy filenames are ignored across continue/redial/Fresh, including unreadable files", async () => {
    const h = runtimeHarness();
    const warnings: string[] = [];
    h.events.onStatus = (line) => warnings.push(line);
    h.native.main("existing", h.directory);
    for (const name of Object.values(LEGACY_PROMPT_FILES)) {
      writeFileSync(join(h.directory, name), "DO NOT LOAD THIS LEGACY TEXT");
      chmodSync(join(h.directory, name), 0o000);
    }
    try {
      await h.runtime.start();
      h.runtime.offer("first");
      h.runtime.offer("redial");
      await h.runtime.fresh();
      h.runtime.offer("fresh");
      expect(h.runtime.currentReady!.prompts).toEqual([]);
      expect(
        warnings.filter((line) => line.startsWith("Ignoring legacy prompt file")),
      ).toHaveLength(8);
      expect(warnings.join()).not.toContain("DO NOT LOAD THIS LEGACY TEXT");
      for (const call of h.native.calls) {
        for (const key of [
          "prompt",
          "initialItems",
          "realtimeStartInstructions",
          "realtimeEndInstructions",
          "baseInstructions",
          "developerInstructions",
        ])
          expect(call.params).not.toHaveProperty(key);
      }
    } finally {
      for (const name of Object.values(LEGACY_PROMPT_FILES))
        chmodSync(join(h.directory, name), 0o600);
      await h.cleanup();
    }
  });

  test("broken legacy links warn, while a deliberately referenced legacy filename loads once", async () => {
    const h = runtimeHarness({ "prompt-files": { voice: "chosen.md" } });
    const warnings: string[] = [];
    writeFileSync(join(h.directory, "VOICE.md"), "chosen");
    symlinkSync(join(h.directory, "VOICE.md"), join(h.directory, "chosen.md"));
    symlinkSync(join(h.directory, "missing"), join(h.directory, "ORCHESTRATOR.md"));
    try {
      expect(await readPrompts(h.config, (line) => warnings.push(line))).toEqual({
        voicePrompt: "chosen",
      });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("ORCHESTRATOR.md");
      expect(readFileSync(join(h.directory, "VOICE.md"), "utf8")).toBe("chosen");
    } finally {
      await h.cleanup();
    }
  });

  for (const kind of ["missing", "unreadable", "directory", "broken-link"]) {
    // Root and Windows do not enforce these POSIX read bits in the same way.
    test.skipIf(
      kind === "unreadable" && (process.platform === "win32" || process.getuid?.() === 0),
    )(
      `${kind} references fail before native startup, even if raw text overrides them`,
      async () => {
        const h = runtimeHarness({
          "prompt-files": { voice: "selected" },
          voice: { extra: { prompt: "raw wins, but references must still be valid" } },
        });
        const path = join(h.directory, "selected");
        if (kind === "unreadable") {
          writeFileSync(path, "private");
          chmodSync(path, 0o000);
        }
        if (kind === "directory") mkdirSync(path);
        if (kind === "broken-link") symlinkSync(join(h.directory, "missing"), path);
        try {
          await expect(h.runtime.start()).rejects.toThrow("prompt-files.voice: cannot read");
          expect(h.native.options).toBeUndefined();
          expect(h.native.calls).toEqual([]);
          expect(h.ready).toEqual([]);
        } finally {
          if (kind === "unreadable") chmodSync(path, 0o600);
          await h.cleanup();
        }
      },
    );
  }

  for (const mode of ["fresh", "continue", "resume"] as const) {
    for (const raw of [false, true]) {
      test(`${mode}: every role is explicit and launch-cached; raw override=${raw}`, async () => {
        const refs: PromptFilesValues = {};
        for (const key of Object.keys(PROMPT_FIELDS) as (keyof PromptFilesValues)[])
          refs[key] = `${key}.txt`;
        const h = runtimeHarness(
          {
            "prompt-files": refs,
            voice: {
              version: "v3",
              ...(raw
                ? {
                    extra: {
                      prompt: null,
                      initialItems: [],
                      realtimeStartInstructions: "",
                      realtimeEndInstructions: null,
                    },
                  }
                : {}),
            },
            ...(raw
              ? {
                  orchestrator: {
                    extra: { baseInstructions: null, developerInstructions: "raw instructions" },
                  },
                }
              : {}),
          },
          mode === "resume" ? { resume: "existing" } : mode === "fresh" ? { fresh: true } : {},
        );
        h.native.main("existing", h.directory);
        const warnings: string[] = [];
        h.events.onStatus = (line) => warnings.push(line);
        for (const [key, path] of Object.entries(h.config.promptFiles!))
          writeFileSync(path, key === "voice" ? "" : key);
        try {
          await h.runtime.start();
          h.runtime.offer("first");
          for (const path of Object.values(h.config.promptFiles!))
            writeFileSync(path!, "Changed after launch");
          h.runtime.offer("redial");
          await h.runtime.fresh();
          h.runtime.offer("fresh");
          expect(h.runtime.currentReady!.prompts).toEqual(promptPaths(h.config));
          expect(
            warnings.some((line) => line.includes("replaces Codex's entire base prompt")),
          ).toBe(!raw);
          const threads = h.native.calls.filter((call) =>
            ["thread/start", "thread/resume"].includes(call.method),
          );
          expect(threads).toHaveLength(2);
          for (const call of threads) {
            expect(call.params["baseInstructions"]).toBe(raw ? null : "orchestrator-base");
            expect(call.params["developerInstructions"]).toBe(
              raw ? "raw instructions" : "orchestrator",
            );
            expect(call.params).not.toHaveProperty("promptFiles");
            expect(call.params).not.toHaveProperty("config");
          }
          const starts = h.native.calls.filter((call) => call.method === "thread/realtime/start");
          expect(starts).toHaveLength(3);
          for (const call of starts) {
            expect(call.params["prompt"]).toBe(raw ? null : "");
            expect(call.params["realtimeStartInstructions"]).toBe(
              raw ? "" : "orchestrator-session-start",
            );
            expect(call.params["realtimeEndInstructions"]).toBe(
              raw ? null : "orchestrator-session-end",
            );
            expect(call.params["initialItems"]).toEqual(
              raw
                ? []
                : [
                    { role: "developer", text: "voice-seed-developer" },
                    { role: "user", text: "voice-seed-user" },
                    { role: "assistant", text: "voice-seed-assistant" },
                  ],
            );
            expect(call.params).not.toHaveProperty("includeStartupContext");
            expect(call.params).not.toHaveProperty("flushTranscriptTailOnSessionEnd");
          }
        } finally {
          await h.cleanup();
        }
      });
    }
  }
});
