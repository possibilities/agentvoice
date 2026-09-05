import { validateFullAccessParams } from "./full-access.ts";

/** Check argv shape without interpreting or echoing potentially secret values. */
export function codexConfigEntryIssue(entry: string): string | undefined {
  const equals = entry.indexOf("=");
  if (equals < 0 || !entry.slice(0, equals).trim())
    return "expected key=value with a non-empty key";
  if (entry.includes("\0")) return "NUL characters cannot be passed in native argv";
  if (entry.trimStart().startsWith("-")) return "expected a config key, not a command-line flag";
  return undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Interpret only product-invariant keys for validation. Original strings, not
 * this tree, go to Codex. Mirrors utils/cli/config_override.rs (TOML then raw
 * string fallback) and config/overrides.rs (ordered dotted-path replacement).
 * Native Codex remains authoritative and effective permissions are checked
 * again on thread responses; this is not a general native config validator.
 */
export function validateCodexConfig(entries: readonly string[] = []): void {
  const guarded = new Set([
    "sandbox_mode",
    "approval_policy",
    "default_permissions",
    "profiles",
    "features",
    "cwd",
  ]);
  const tree: Record<string, unknown> = Object.create(null);
  for (const [index, entry] of entries.entries()) {
    const issue = codexConfigEntryIssue(entry);
    if (issue) throw new Error(`codex-config[${index}]: ${issue}`);
    const equals = entry.indexOf("=");
    const key = entry.slice(0, equals).trim();
    const parts = key.split(".");
    if (!guarded.has(parts[0]!)) continue;
    const raw = entry.slice(equals + 1).trim();
    let value: unknown;
    try {
      value = (Bun.TOML.parse(`_x_ = ${raw}`) as Record<string, unknown>)["_x_"];
    } catch {
      value = raw.replace(/^["']+|["']+$/g, "");
    }
    let target = tree;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(target, part) || !record(target[part])) {
        Object.defineProperty(target, part, {
          value: Object.create(null),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      target = target[part] as Record<string, unknown>;
    }
    Object.defineProperty(target, parts.at(-1)!, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  validateFullAccessParams({ config: tree }, "codex-config");
  if (Object.hasOwn(tree, "cwd"))
    throw new Error("codex-config.cwd cannot select the workspace; use --workspace");
  const checkFeatures = (config: Record<string, unknown>, path: string) => {
    const features = config["features"];
    if (features === undefined) return;
    if (
      !record(features) ||
      (Object.hasOwn(features, "realtime_conversation") &&
        features["realtime_conversation"] !== true)
    )
      throw new Error(`${path}.features.realtime_conversation must remain enabled for AgentVoice`);
  };
  checkFeatures(tree, "codex-config");
  if (record(tree["profiles"])) {
    for (const [name, profile] of Object.entries(tree["profiles"]))
      if (record(profile)) checkFeatures(profile, `codex-config.profiles.${name}`);
  }
}
