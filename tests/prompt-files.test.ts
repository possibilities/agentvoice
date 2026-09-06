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
  type ConfigValues,
  LEGACY_PROMPT_FILES,
  PROMPT_FILES,
  type PromptName,
  parseJsonConfig,
  readPrompts,
  resolveConfig,
  STARTUP_CONTEXT_KEY,
} from "../src/core/config.ts";
import { loadLaunchConfig, parseArgs } from "../src/main.ts";
import { runtimeHarness } from "./fixtures/runtime-harness.ts";

const OVERRIDES: readonly PromptName[] = [
  "voicePrompt",
  "orchestratorBaseInstructions",
  "orchestratorSessionStart",
  "orchestratorSessionEnd",
];
const APPENDS: readonly PromptName[] = [
  "voiceAppend",
  "orchestratorDeveloperInstructions",
  "orchestratorSessionStart",
  "orchestratorSessionEnd",
];
const NATIVE_PROMPT_FIELDS = [
  "prompt",
  "realtimeStartInstructions",
  "realtimeEndInstructions",
  "baseInstructions",
  "developerInstructions",
];

function write(
  directory: string,
  names: readonly PromptName[],
  text: (name: PromptName) => string = (name) => name,
): void {
  for (const name of names) writeFileSync(join(directory, PROMPT_FILES[name]), text(name));
}

describe("convention prompt files", () => {
  test("the retired prompt-files section is an unknown option; resolution carries no references", () => {
    expect(() => parseJsonConfig('{"prompt-files":{"voice":"x.md"}}', "settings")).toThrow(
      'unknown option "prompt-files"',
    );
    expect(resolveConfig({}, {}, {}, "/test")).not.toHaveProperty("promptFiles");
  });

  test("files are discovered beside the selected config, not the workspace; empty and Unicode text survive", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentvoice-convention-prompts-"));
    try {
      mkdirSync(join(root, "settings"));
      writeFileSync(join(root, "settings/settings.json"), "{}");
      writeFileSync(join(root, "settings", PROMPT_FILES.voicePrompt), "");
      writeFileSync(
        join(root, "settings", PROMPT_FILES.orchestratorDeveloperInstructions),
        "Speak precisely 🎤\n",
      );
      // The launch directory is the workspace; files there must not load.
      writeFileSync(join(root, PROMPT_FILES.orchestratorSessionStart), "wrong directory");
      const config = await loadLaunchConfig(
        parseArgs(["--config", "settings/settings.json"]),
        root,
      );
      const loaded = await readPrompts(config);
      expect(loaded.prompts).toEqual({
        voicePrompt: "",
        orchestratorDeveloperInstructions: "Speak precisely 🎤\n",
      });
      expect(loaded.paths).toEqual([
        join(root, "settings", PROMPT_FILES.voicePrompt),
        join(root, "settings", PROMPT_FILES.orchestratorDeveloperInstructions),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("all legacy filenames are ignored across continue/redial/Fresh, including unreadable files", async () => {
    const h = runtimeHarness({}, { continue: true });
    const warnings: string[] = [];
    h.events.onStatus = (line) => warnings.push(line);
    h.native.main("existing", h.directory);
    for (const name of LEGACY_PROMPT_FILES) {
      writeFileSync(join(h.directory, name), "DO NOT LOAD THIS LEGACY TEXT");
      chmodSync(join(h.directory, name), 0o000);
    }
    try {
      await h.runtime.start();
      await h.runtime.offer("first");
      await h.runtime.offer("redial");
      await h.runtime.fresh();
      await h.runtime.offer("fresh");
      expect(h.runtime.currentReady!.prompts).toEqual([]);
      expect(
        warnings.filter((line) => line.startsWith("Ignoring legacy prompt file")),
      ).toHaveLength(LEGACY_PROMPT_FILES.length);
      expect(warnings.join()).not.toContain("DO NOT LOAD THIS LEGACY TEXT");
      for (const call of h.native.calls) {
        for (const key of [...NATIVE_PROMPT_FIELDS, "config"])
          expect(call.params).not.toHaveProperty(key);
        expect(JSON.stringify(call.params)).not.toContain("DO NOT LOAD THIS LEGACY TEXT");
      }
    } finally {
      for (const name of LEGACY_PROMPT_FILES) chmodSync(join(h.directory, name), 0o600);
      await h.cleanup();
    }
  });

  test("a symlinked convention name loads; legacy names still warn, broken or not", async () => {
    const h = runtimeHarness();
    const warnings: string[] = [];
    writeFileSync(join(h.directory, "VOICE.md"), "chosen");
    symlinkSync(join(h.directory, "VOICE.md"), join(h.directory, PROMPT_FILES.voicePrompt));
    symlinkSync(join(h.directory, "missing"), join(h.directory, "ORCHESTRATOR.md"));
    try {
      expect((await readPrompts(h.config, (line) => warnings.push(line))).prompts).toEqual({
        voicePrompt: "chosen",
      });
      expect(warnings).toHaveLength(2);
      expect(warnings.join("\n")).toContain("VOICE.md");
      expect(warnings.join("\n")).toContain("ORCHESTRATOR.md");
      expect(readFileSync(join(h.directory, "VOICE.md"), "utf8")).toBe("chosen");
    } finally {
      await h.cleanup();
    }
  });

  for (const kind of ["unreadable", "directory", "broken-link"]) {
    // Root and Windows do not enforce these POSIX read bits in the same way.
    test.skipIf(
      kind === "unreadable" && (process.platform === "win32" || process.getuid?.() === 0),
    )(
      `a ${kind} convention name fails before native startup, even if raw text overrides it`,
      async () => {
        const h = runtimeHarness({
          voice: { extra: { prompt: "raw wins, but a present file must still load" } },
        });
        const path = join(h.directory, PROMPT_FILES.voicePrompt);
        if (kind === "unreadable") {
          writeFileSync(path, "private");
          chmodSync(path, 0o000);
        }
        if (kind === "directory") mkdirSync(path);
        if (kind === "broken-link") symlinkSync(join(h.directory, "missing"), path);
        try {
          await expect(h.runtime.start()).rejects.toThrow(
            `${PROMPT_FILES.voicePrompt}: cannot read`,
          );
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

  test("an override and an append for the same agent cannot both be present", async () => {
    const pairs = [
      ["voicePrompt", "voiceAppend"],
      ["orchestratorBaseInstructions", "orchestratorDeveloperInstructions"],
    ] as const;
    for (const [override, append] of pairs) {
      const h = runtimeHarness();
      write(h.directory, [override, append]);
      try {
        await expect(h.runtime.start()).rejects.toThrow(
          `${PROMPT_FILES[override]} and ${PROMPT_FILES[append]} cannot both be present`,
        );
        expect(h.native.options).toBeUndefined();
        expect(h.native.calls).toEqual([]);
      } finally {
        await h.cleanup();
      }
    }
  });

  for (const mode of ["fresh", "continue", "resume"] as const) {
    for (const raw of [false, true]) {
      test(`${mode}: override files map to native fields and are launch-cached; raw override=${raw}`, async () => {
        const h = runtimeHarness(
          {
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
          mode === "resume"
            ? { resume: "existing" }
            : mode === "continue"
              ? { continue: true }
              : { fresh: true },
        );
        h.native.main("existing", h.directory);
        const warnings: string[] = [];
        h.events.onStatus = (line) => warnings.push(line);
        write(h.directory, OVERRIDES, (name) => (name === "voicePrompt" ? "" : name));
        try {
          await h.runtime.start();
          await h.runtime.offer("first");
          write(h.directory, OVERRIDES, () => "Changed after launch");
          await h.runtime.offer("redial");
          await h.runtime.fresh();
          await h.runtime.offer("fresh");
          expect(h.runtime.currentReady!.prompts).toEqual(
            OVERRIDES.map((name) => join(h.directory, PROMPT_FILES[name])),
          );
          expect(
            warnings.some((line) => line.includes("replaces Codex's entire base prompt")),
          ).toBe(!raw);
          const threads = h.native.calls.filter((call) =>
            ["thread/start", "thread/resume"].includes(call.method),
          );
          expect(threads).toHaveLength(2);
          for (const call of threads) {
            expect(call.params["baseInstructions"]).toBe(
              raw ? null : "orchestratorBaseInstructions",
            );
            if (raw) expect(call.params["developerInstructions"]).toBe("raw instructions");
            else expect(call.params).not.toHaveProperty("developerInstructions");
            expect(call.params).not.toHaveProperty("config");
          }
          const starts = h.native.calls.filter((call) => call.method === "thread/realtime/start");
          expect(starts).toHaveLength(3);
          for (const call of starts) {
            expect(call.params["prompt"]).toBe(raw ? null : "");
            expect(call.params["realtimeStartInstructions"]).toBe(
              raw ? "" : "orchestratorSessionStart",
            );
            expect(call.params["realtimeEndInstructions"]).toBe(
              raw ? null : "orchestratorSessionEnd",
            );
            if (raw) expect(call.params["initialItems"]).toEqual([]);
            expect(call.params["includeStartupContext"]).toBe(false);
            expect(call.params).not.toHaveProperty("flushTranscriptTailOnSessionEnd");
            expect(JSON.stringify(call.params)).not.toContain("Changed after launch");
          }
        } finally {
          await h.cleanup();
        }
      });
    }
  }

  test("append files ride developerInstructions and the startup-context slot on resume, Fresh and every call", async () => {
    const h = runtimeHarness({ orchestrator: { effort: "high" } }, { resume: "existing" });
    h.native.main("existing", h.directory);
    const warnings: string[] = [];
    h.events.onStatus = (line) => warnings.push(line);
    write(h.directory, APPENDS);
    try {
      await h.runtime.start();
      await h.runtime.offer("first");
      await h.runtime.fresh();
      await h.runtime.offer("fresh");
      expect(h.runtime.currentReady!.prompts).toEqual(
        APPENDS.map((name) => join(h.directory, PROMPT_FILES[name])),
      );
      expect(warnings.some((line) => line.includes("entire base prompt"))).toBe(false);
      const threads = h.native.calls.filter((call) =>
        ["thread/resume", "thread/start"].includes(call.method),
      );
      expect(threads.map((call) => call.method)).toEqual(["thread/resume", "thread/start"]);
      for (const call of threads) {
        expect(call.params["developerInstructions"]).toBe("orchestratorDeveloperInstructions");
        expect(call.params).not.toHaveProperty("baseInstructions");
        expect(call.params["config"]).toEqual({
          model_reasoning_effort: "high",
          [STARTUP_CONTEXT_KEY]: "voiceAppend",
        });
      }
      const starts = h.native.calls.filter((call) => call.method === "thread/realtime/start");
      expect(starts).toHaveLength(2);
      for (const call of starts) {
        expect(call.params).not.toHaveProperty("prompt");
        expect(call.params["includeStartupContext"]).toBe(true);
        expect(call.params["realtimeStartInstructions"]).toBe("orchestratorSessionStart");
        expect(call.params["realtimeEndInstructions"]).toBe("orchestratorSessionEnd");
      }
    } finally {
      await h.cleanup();
    }
  });

  const conflicts: ReadonlyArray<[string, ConfigValues]> = [
    ["voice.include-startup-context", { voice: { "include-startup-context": true } }],
    [
      `orchestrator.config.${STARTUP_CONTEXT_KEY}`,
      { orchestrator: { config: { [STARTUP_CONTEXT_KEY]: "mine" } } },
    ],
    [
      `${STARTUP_CONTEXT_KEY} codex-config entry`,
      { "codex-config": [`${STARTUP_CONTEXT_KEY}="mine"`] },
    ],
  ];
  for (const [setting, values] of conflicts) {
    test(`the append slot has one owner: ${setting} conflicts before native startup`, async () => {
      const h = runtimeHarness(values);
      write(h.directory, ["voiceAppend"]);
      try {
        await expect(h.runtime.start()).rejects.toThrow(
          `${PROMPT_FILES.voiceAppend} uses Codex's startup-context slot`,
        );
        expect(h.native.options).toBeUndefined();
        expect(h.native.calls).toEqual([]);
        expect(h.ready).toEqual([]);
      } finally {
        await h.cleanup();
      }
    });
  }
});
