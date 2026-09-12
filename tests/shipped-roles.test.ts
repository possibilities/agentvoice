import { expect, test } from "bun:test";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readPrompts, resolveConfig, STARTUP_CONTEXT_KEY } from "../src/core/config.ts";
import { realtimeParams, threadParams } from "../src/core/params.ts";
import { readRoleAssets } from "../src/core/role.ts";
import { captureFiles, createRole, materializeRole, readRole } from "../src/roles/store.ts";
import { runtimeHarness } from "./fixtures/runtime-harness.ts";

for (const name of ["default", "worker"]) {
  test(`${name} role delivers its working, native-mode, and speech instructions to separate slots`, async () => {
    const directory = join(import.meta.dir, "..", "roles", name);
    const h = runtimeHarness();
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

test("worker role snapshot captures its shared speech link as independent prompt bytes", async () => {
  const directory = join(import.meta.dir, "..", "roles", "worker");
  const h = runtimeHarness();
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
