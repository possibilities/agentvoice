import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildSchema } from "../scripts/generate-schema.ts";
import {
  APPROVAL_POLICIES,
  APPROVALS_REVIEWERS,
  HANDOFF_MODES,
  HISTORY_MODES,
  ORCHESTRATOR_KEYS,
  PERSONALITIES,
  PROMPT_FILE_KEYS,
  REALTIME_VERSIONS,
  SANDBOX_MODES,
  SERVER_KEYS,
  VOICE_KEYS,
} from "../src/core/config.ts";

describe("server.schema.json", () => {
  test("matches the generator (fix with `bun run generate:schema`)", async () => {
    const checkedIn = JSON.parse(
      await Bun.file(join(import.meta.dir, "..", "server.schema.json")).text(),
    );
    // buildSchema() itself throws when a config.ts key list and the schema
    // properties disagree, so this test also gates new config keys.
    expect(checkedIn).toEqual(buildSchema());
  });
});

// ---------------------------------------------------------------------------
// Characterization ahead of the zod port. The drift test above only pins
// generator == checked-in file; regenerating moves both together. These pin
// the invariants that must survive regeneration itself.
// ---------------------------------------------------------------------------

type Spec = Record<string, unknown>;

function topProperties(): Record<string, Spec> {
  return buildSchema()["properties"] as Record<string, Spec>;
}

function sectionProperties(section: string): Record<string, Spec> {
  const sectionSpec = topProperties()[section];
  if (sectionSpec === undefined) throw new Error(`schema has no "${section}" property`);
  return sectionSpec["properties"] as Record<string, Spec>;
}

function spec(properties: Record<string, Spec>, key: string): Spec {
  const value = properties[key];
  if (value === undefined) throw new Error(`schema has no "${key}" property`);
  return value;
}

describe("generated schema invariants", () => {
  test("retired account and worker controls are no longer advertised", () => {
    expect(topProperties()).not.toHaveProperty("accounts");
    const orchestrator = sectionProperties("orchestrator");
    expect(orchestrator).not.toHaveProperty("dispatch");
    expect(orchestrator).not.toHaveProperty("dispatch-reports");
  });
  test("keeps draft-07 and the verbatim title and prompt-file contract text", () => {
    const schema = buildSchema();
    expect(schema["$schema"]).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema["title"]).toBe("agentvoice configuration");
    expect(schema["description"]).toBe(
      "Configuration for agentvoice, read at boot from ~/.config/agentvoice/server.json ($XDG_CONFIG_HOME honored; --config relocates it). The foreground app reads it at launch. Precedence: CLI flag > this file > default. Unset settings stay omitted except documented application defaults: mandatory full access, WebRTC v3 compatibility, startup snapshot off, spoken-history replay and quiet-resume guidance. Native app-server defaults are not a claim of desktop-client parity. Copying server.json.example verbatim is a no-op. Prompt files load only through explicit prompt-files references; paths resolve relative to this file's directory. Unset sends no file override; explicit empty contents are sent empty. Conventional filenames only trigger migration warnings, never loading. See README.md for the prompt-file contract.",
    );
  });

  test("strict at root, prompt-files, orchestrator, voice; open in the passthrough subtrees", () => {
    const schema = buildSchema();
    expect(schema["additionalProperties"]).toBe(false);
    const properties = topProperties();
    for (const section of ["prompt-files", "orchestrator", "voice"]) {
      expect(spec(properties, section)["additionalProperties"]).toBe(false);
    }
    // config/extra forward to the codex key space: they must never close.
    const orchestrator = sectionProperties("orchestrator");
    for (const key of ["config", "extra"]) {
      expect(spec(orchestrator, key)["type"]).toBe("object");
      expect("additionalProperties" in spec(orchestrator, key)).toBe(false);
    }
    const voice = sectionProperties("voice");
    expect(spec(voice, "extra")["type"]).toBe("object");
    expect("additionalProperties" in spec(voice, "extra")).toBe(false);
    expect(spec(voice, "codex-response-handoff-channel-prefixes")["additionalProperties"]).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  test("documents exactly the config keys plus $schema", () => {
    expect(Object.keys(topProperties()).sort()).toEqual(["$schema", ...SERVER_KEYS].sort());
    expect(Object.keys(sectionProperties("orchestrator")).sort()).toEqual(
      [...ORCHESTRATOR_KEYS].sort(),
    );
    expect(Object.keys(sectionProperties("prompt-files")).sort()).toEqual(
      [...PROMPT_FILE_KEYS].sort(),
    );
    expect(Object.keys(sectionProperties("voice")).sort()).toEqual([...VOICE_KEYS].sort());
    expect(spec(topProperties(), "$schema")["type"]).toBe("string");
  });

  test("enums, bounds, and defaults mirror config.ts", () => {
    const orchestrator = sectionProperties("orchestrator");
    expect(spec(orchestrator, "personality")["enum"]).toEqual([...PERSONALITIES]);
    expect(spec(orchestrator, "sandbox")["enum"]).toEqual([...SANDBOX_MODES]);
    expect(spec(orchestrator, "sandbox")["default"]).toBe("danger-full-access");
    expect(spec(orchestrator, "approval-policy")["enum"]).toEqual([...APPROVAL_POLICIES]);
    expect(spec(orchestrator, "approval-policy")["default"]).toBe("never");
    expect(spec(orchestrator, "approvals-reviewer")["enum"]).toEqual([...APPROVALS_REVIEWERS]);
    expect(spec(orchestrator, "history-mode")["enum"]).toEqual([...HISTORY_MODES]);

    const voice = sectionProperties("voice");
    expect(spec(voice, "version")["enum"]).toEqual([...REALTIME_VERSIONS]);
    expect(spec(voice, "version")["default"]).toBe("v3");
    expect(spec(voice, "codex-response-handoff-mode")["enum"]).toEqual([...HANDOFF_MODES]);
  });

  test("voice context and frontend replay controls remain optional with distinct defaults", () => {
    const voice = sectionProperties("voice");
    for (const key of ["include-startup-context", "flush-transcript-tail-on-session-end"]) {
      expect(spec(voice, key)["type"]).toBe("boolean");
    }
    expect(spec(voice, "include-startup-context")["default"]).toBe(false);
    expect(spec(voice, "flush-transcript-tail-on-session-end")).not.toHaveProperty("default");
    expect(spec(voice, "replay-spoken-history")["default"]).toBe(true);
    expect(spec(voice, "replay-spoken-history")["description"]).toContain(
      "not a native passthrough",
    );
    expect(topProperties()["voice"]).not.toHaveProperty("required");
  });

  test("every key carries documentation", () => {
    const sections = [
      topProperties(),
      sectionProperties("prompt-files"),
      sectionProperties("orchestrator"),
      sectionProperties("voice"),
    ];
    for (const properties of sections) {
      for (const [key, value] of Object.entries(properties)) {
        const description = value["description"];
        if (typeof description !== "string" || description.length === 0) {
          throw new Error(`schema property "${key}" has no description`);
        }
      }
    }
  });
});
