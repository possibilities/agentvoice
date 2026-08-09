import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildSchema } from "../scripts/generate-schema.ts";
import {
  ACCOUNTS_KEYS,
  APPROVAL_POLICIES,
  APPROVALS_REVIEWERS,
  DEFAULT_REALTIME_VERSION,
  DEFAULT_SWITCH_THRESHOLD,
  HANDOFF_MODES,
  HISTORY_MODES,
  ORCHESTRATOR_KEYS,
  PERSONALITIES,
  REALTIME_VERSIONS,
  SANDBOX_MODES,
  SERVER_KEYS,
  VOICE_KEYS,
} from "../src/server/config.ts";

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
  test("keeps draft-07 and the verbatim title and prompt-file contract text", () => {
    const schema = buildSchema();
    expect(schema["$schema"]).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema["title"]).toBe("agentvoice server configuration");
    expect(schema["description"]).toBe(
      "Configuration for `agentvoice server`, read once at boot from ~/.config/agentvoice/server.json ($XDG_CONFIG_HOME honored; --config relocates it). Precedence: CLI flag > this file > default. An option left unset is NOT sent to codex at all, so your ~/.codex/config.toml applies — which is why copying server.json.example verbatim is a no-op. Prompt files (VOICE.md, VOICE_SEED_DEVELOPER/USER/ASSISTANT.md, ORCHESTRATOR.md, ORCHESTRATOR_BASE.md, ORCHESTRATOR_SESSION_START/END.md) are discovered by convention in this file's own directory and are never named here; absent leaves codex's built-in prompt, present-but-empty strips it. See README.md for the prompt-file contract.",
    );
  });

  test("strict at root, accounts, orchestrator, voice; open in the passthrough subtrees", () => {
    const schema = buildSchema();
    expect(schema["additionalProperties"]).toBe(false);
    const properties = topProperties();
    for (const section of ["accounts", "orchestrator", "voice"]) {
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
    expect(Object.keys(sectionProperties("accounts")).sort()).toEqual([...ACCOUNTS_KEYS].sort());
    expect(Object.keys(sectionProperties("orchestrator")).sort()).toEqual(
      [...ORCHESTRATOR_KEYS].sort(),
    );
    expect(Object.keys(sectionProperties("voice")).sort()).toEqual([...VOICE_KEYS].sort());
    expect(spec(topProperties(), "$schema")["type"]).toBe("string");
  });

  test("enums, bounds, and defaults mirror config.ts", () => {
    const properties = topProperties();
    const port = spec(properties, "port");
    expect(port["type"]).toEqual(["integer", "string"]);
    expect(port["minimum"]).toBe(1);
    expect(port["maximum"]).toBe(65535);
    expect(port["default"]).toBe(7890);

    const accounts = sectionProperties("accounts");
    expect(spec(accounts, "balance")["default"]).toBe(false);
    expect(spec(accounts, "switch-threshold")["minimum"]).toBe(50);
    expect(spec(accounts, "switch-threshold")["maximum"]).toBe(100);
    expect(spec(accounts, "switch-threshold")["default"]).toBe(DEFAULT_SWITCH_THRESHOLD);

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
    expect(spec(voice, "version")["default"]).toBe(DEFAULT_REALTIME_VERSION);
    expect(spec(voice, "codex-response-handoff-mode")["enum"]).toEqual([...HANDOFF_MODES]);
  });

  test("every key carries documentation", () => {
    const sections = [
      topProperties(),
      sectionProperties("accounts"),
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
