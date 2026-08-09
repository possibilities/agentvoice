/**
 * Generates `server.schema.json` from the zod schema in
 * `src/server/config-schema.ts` — the same schema the loader validates with,
 * so the published file cannot drift from what the server accepts. The schema
 * is the config surface's documentation, and this generator refuses to emit an
 * undocumented key.
 *
 * Regenerate with `bun run generate:schema`. `tests/schema.test.ts` fails when
 * the checked-in file drifts from this source.
 */
import { join } from "node:path";
import { z } from "zod";
import { configFileSchema } from "../src/server/config-schema.ts";

const TITLE = "agentvoice server configuration";
const DESCRIPTION =
  "Configuration for `agentvoice server`, read once at boot from ~/.config/agentvoice/server.json ($XDG_CONFIG_HOME honored; --config relocates it). Precedence: CLI flag > this file > default. An option left unset is NOT sent to codex at all, so your ~/.codex/config.toml applies — which is why copying server.json.example verbatim is a no-op. Prompt files (VOICE.md, VOICE_SEED_DEVELOPER/USER/ASSISTANT.md, ORCHESTRATOR.md, ORCHESTRATOR_BASE.md, ORCHESTRATOR_SESSION_START/END.md) are discovered by convention in this file's own directory and are never named here; absent leaves codex's built-in prompt, present-but-empty strips it. See README.md for the prompt-file contract.";

type Schema = Record<string, unknown>;

function isObject(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function properties(node: unknown, name: string): Schema {
  if (!isObject(node)) throw new Error(`schema node "${name}" is not an object`);
  const props = node["properties"];
  if (!isObject(props)) throw new Error(`schema node "${name}" has no properties`);
  return props;
}

/**
 * zod emits the number-or-string port union as `anyOf`; the published schema
 * keeps the historical flat form, `type: ["integer", "string"]` with the
 * 1-65535 bounds alongside. The parse layer deliberately accepts any number
 * or string (bounds apply at resolution, after CLI precedence, where string
 * ports go through Number.parseInt), so the bounds are documentation of the
 * resolved contract — exactly what the hand-written schema published before.
 */
function flattenPort(top: Schema): void {
  const port = top["port"];
  if (!isObject(port) || !Array.isArray(port["anyOf"]) || port["anyOf"].length !== 2) {
    throw new Error("port is no longer the expected number-or-string union");
  }
  const [numeric, text] = port["anyOf"] as [unknown, unknown];
  if (
    !isObject(numeric) ||
    numeric["type"] !== "number" ||
    Object.keys(numeric).length !== 1 ||
    !isObject(text) ||
    text["type"] !== "string" ||
    Object.keys(text).length !== 1
  ) {
    throw new Error("port is no longer the expected number-or-string union");
  }
  const { anyOf: _branches, ...annotations } = port;
  top["port"] = { type: ["integer", "string"], minimum: 1, maximum: 65535, ...annotations };
}

/**
 * `orchestrator.config`, `orchestrator.extra`, and `voice.extra` forward
 * verbatim into the codex key space. zod emits their openness as
 * `additionalProperties: {}` plus an empty `properties`; the published schema
 * keeps the historical bare-object form — absent `additionalProperties` is the
 * same open semantics. Refuses to erase anything that is not vacuously open.
 */
function openPassthrough(sectionProps: Schema, section: string, key: string): void {
  const node = sectionProps[key];
  if (!isObject(node) || node["type"] !== "object") {
    throw new Error(`passthrough "${section}.${key}" is not an object schema`);
  }
  const additional = node["additionalProperties"];
  const open =
    additional === undefined ||
    additional === true ||
    (isObject(additional) && Object.keys(additional).length === 0);
  if (!open) throw new Error(`passthrough "${section}.${key}" is no longer open`);
  const named = node["properties"];
  if (named !== undefined && (!isObject(named) || Object.keys(named).length > 0)) {
    throw new Error(`passthrough "${section}.${key}" grew named properties`);
  }
  delete node["additionalProperties"];
  delete node["properties"];
}

/** JSON object keys are strings already; the emitted constraint says nothing. */
function dropVacuousPropertyNames(sectionProps: Schema, section: string, key: string): void {
  const node = sectionProps[key];
  if (!isObject(node)) throw new Error(`schema node "${section}.${key}" is not an object`);
  const names = node["propertyNames"];
  if (names === undefined) return;
  if (JSON.stringify(names) !== '{"type":"string"}') {
    throw new Error(`"${section}.${key}" propertyNames grew a real constraint; keep it`);
  }
  delete node["propertyNames"];
}

/** Cosmetic: keep the historical key order so regeneration is byte-stable. */
function hoistDescription(top: Schema, key: string): void {
  const node = top[key];
  if (!isObject(node)) throw new Error(`schema node "${key}" is not an object`);
  const { type, description, ...rest } = node;
  top[key] = { type, description, ...rest };
}

/** The schema is the config surface's documentation; every key must carry it. */
function assertDocumented(props: Schema, section: string): void {
  for (const [key, value] of Object.entries(props)) {
    const description = isObject(value) ? value["description"] : undefined;
    if (typeof description !== "string" || description.length === 0) {
      throw new Error(`schema property "${section}${key}" has no description`);
    }
  }
}

/**
 * The "input" io mode is deliberate: the schema describes what a human may
 * write on disk, where every field is omittable. The default "output" mode
 * would mark defaulted fields required, flagging `{}` as invalid even though
 * the loader accepts it.
 */
export function buildSchema(): Schema {
  const generated = z.toJSONSchema(configFileSchema, { target: "draft-7", io: "input" }) as Schema;
  const { $schema, ...rest } = generated;
  const schema: Schema = { $schema, title: TITLE, description: DESCRIPTION, ...rest };

  const top = properties(schema, "top level");
  flattenPort(top);
  for (const section of ["accounts", "orchestrator", "voice"]) hoistDescription(top, section);
  const orchestrator = properties(top["orchestrator"], "orchestrator");
  const voice = properties(top["voice"], "voice");
  openPassthrough(orchestrator, "orchestrator", "config");
  openPassthrough(orchestrator, "orchestrator", "extra");
  openPassthrough(voice, "voice", "extra");
  dropVacuousPropertyNames(voice, "voice", "codex-response-handoff-channel-prefixes");

  assertDocumented(top, "");
  assertDocumented(properties(top["accounts"], "accounts"), "accounts.");
  assertDocumented(orchestrator, "orchestrator.");
  assertDocumented(voice, "voice.");

  return schema;
}

if (import.meta.main) {
  const path = join(import.meta.dir, "..", "server.schema.json");
  await Bun.write(path, `${JSON.stringify(buildSchema(), null, 2)}\n`);
  console.log(`wrote ${path}`);
}
