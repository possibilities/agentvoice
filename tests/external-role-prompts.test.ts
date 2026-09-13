import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPrompts, resolveConfig, STARTUP_CONTEXT_KEY } from "../src/core/config.ts";
import { realtimeParams, threadParams } from "../src/core/params.ts";
import { readRoleAssets } from "../src/core/role.ts";
import { captureFiles, createRole, materializeRole, readRole } from "../src/roles/store.ts";
import { runtimeHarness } from "./fixtures/runtime-harness.ts";

function fixtureRole(root: string): string {
  const directory = join(root, "role");
  mkdirSync(directory);
  for (const [name, text] of Object.entries({
    "APPEND_SYSTEM_PROMPT.md": "Fixture working doctrine",
    "VOICE_ORCHESTRATOR_MULTI_AGENT_MODE.md": "Fixture native mode",
    "VOICE_AGENT_APPEND_SYSTEM_PROMPT.md": "Fixture speech suffix",
  }))
    writeFileSync(join(directory, name), text);
  return directory;
}

for (const name of ["external"]) {
  test(`${name} role delivers its working, native-mode, and speech instructions to separate slots`, async () => {
    const h = runtimeHarness();
    const directory = fixtureRole(h.directory);
    try {
      const config = resolveConfig(
        { role: directory },
        {
          orchestrator: {
            model: "chosen-model",
            effort: "high",
            "service-tier": "priority",
            config: { "features.multi_agent_v2": { unrelated: "retained" } },
          },
        },
        {},
        h.directory,
        { configDir: h.directory, launchCwd: h.directory },
      );
      const loaded = await readPrompts(config);
      const append = readFileSync(join(directory, "APPEND_SYSTEM_PROMPT.md"), "utf8");
      const mode = readFileSync(join(directory, "VOICE_ORCHESTRATOR_MULTI_AGENT_MODE.md"), "utf8");
      // Native MultiAgentModeState truncates custom modes to 400 estimated tokens
      // at four UTF-8 bytes each; request mapping alone cannot catch that loss.
      expect(Buffer.byteLength(mode, "utf8")).toBeLessThanOrEqual(1_600);
      const speech = readFileSync(join(directory, "VOICE_AGENT_APPEND_SYSTEM_PROMPT.md"), "utf8");
      expect(await readRoleAssets(directory)).toEqual({ dir: directory });
      expect(loaded.prompts).toEqual({
        orchestratorDeveloperInstructions: append,
        orchestratorMultiAgentMode: mode,
        voiceAppend: speech,
      });
      for (const kind of ["start", "resume"] as const) {
        const thread = threadParams(config, loaded.prompts, kind);
        expect(thread["developerInstructions"]).toBe(append);
        expect(thread["model"]).toBe("chosen-model");
        expect(thread["serviceTier"]).toBe("priority");
        expect(thread["config"]).toEqual({
          model_reasoning_effort: "high",
          "features.multi_agent_v2": {
            unrelated: "retained",
            enabled: true,
            multi_agent_mode_hint_text: mode,
          },
          [STARTUP_CONTEXT_KEY]: speech,
        });
        expect(thread).not.toHaveProperty("baseInstructions");
        expect(thread).not.toHaveProperty("dynamicTools");
      }
      const realtime = realtimeParams(config, loaded.prompts, "thread", "voice", "fake-sdp");
      expect(realtime["includeStartupContext"]).toBe(true);
      expect(realtime).not.toHaveProperty("prompt");
      expect(realtime).not.toHaveProperty("initialItems");
      expect(realtime).not.toHaveProperty("realtimeStartInstructions");
      expect(realtime).not.toHaveProperty("realtimeEndInstructions");
    } finally {
      await h.cleanup();
    }
  });
}

test("external role snapshot captures independent prompt bytes", async () => {
  const h = runtimeHarness();
  const directory = fixtureRole(h.directory);
  let projection: ReturnType<typeof materializeRole> | undefined;
  try {
    const original = await readPrompts({ ...h.config, role: directory });
    const database = join(h.directory, "workspace-role", "role.sqlite");
    createRole(database, { settings: {}, hasRole: true, files: captureFiles(directory, true) });
    projection = materializeRole(join(h.directory, "cache"), readRole(database));
    const projectedSpeech = join(projection.directory, "VOICE_AGENT_APPEND_SYSTEM_PROMPT.md");
    expect(lstatSync(projectedSpeech).isSymbolicLink()).toBe(false);
    expect((await readPrompts({ ...h.config, role: projection.directory })).prompts).toEqual(
      original.prompts,
    );
  } finally {
    projection?.remove();
    await h.cleanup();
  }
});
