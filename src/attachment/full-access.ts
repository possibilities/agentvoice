/** Guarded TUI attachment supports confirmed full-access threads only. */
export const FULL_ACCESS = "danger-full-access";
export const FULL_ACCESS_PROFILE = ":danger-full-access";
export class FullAccessError extends Error {}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireValue(value: unknown, expected: string, path: string): void {
  if (value !== undefined && value !== expected)
    throw new Error(
      `${path} conflicts with the attachment's full-access-only mode; requires ${expected}`,
    );
}

/** Native config accepts dotted keys; check equivalent nested forms as well. */
function validateNativeConfig(value: unknown, path: string): void {
  if (value == null) return;
  const config = record(value);
  if (!config) throw new Error(`${path} must be a native config object`);
  for (const [key, entry] of Object.entries(config)) {
    const parts = key.split(".");
    const index = parts[0] === "profiles" ? 2 : 0;
    const expected = (
      {
        sandbox_mode: FULL_ACCESS,
        approval_policy: "never",
        default_permissions: FULL_ACCESS_PROFILE,
      } as Record<string, string>
    )[parts[index] ?? ""];
    if (expected !== undefined) {
      if (parts.length !== index + 1)
        throw new Error(
          `${path}.${key} conflicts with the attachment's full-access-only mode; requires ${expected}`,
        );
      requireValue(entry, expected, `${path}.${key}`);
    }
    // Only profiles can select another execution posture; other native tables
    // (MCP tools, hooks, etc.) retain their independent consent/settings policy.
    if (key === "profiles") {
      for (const [name, profile] of Object.entries(record(entry) ?? {}))
        validateNativeConfig(profile, `${path}.profiles.${name}`);
    } else if (key.startsWith("profiles.") && record(entry)) {
      validateNativeConfig(entry, `${path}.${key}`);
    }
  }
}

export function validateFullAccessParams(params: Record<string, unknown>, path = "thread"): void {
  requireValue(params["sandbox"], FULL_ACCESS, `${path}.sandbox`);
  requireValue(params["approvalPolicy"], "never", `${path}.approvalPolicy`);
  requireValue(params["permissions"], FULL_ACCESS_PROFILE, `${path}.permissions`);
  validateNativeConfig(params["config"], `${path}.config`);
}

/** Require effective server state, never infer permission success from our request. */
export function confirmFullAccess(result: unknown, settings = false): void {
  const response = record(result);
  const sandbox = record(response?.[settings ? "sandboxPolicy" : "sandbox"]);
  const profile = response?.["activePermissionProfile"];
  if (
    response?.["approvalPolicy"] !== "never" ||
    sandbox?.["type"] !== "dangerFullAccess" ||
    (profile != null && record(profile)?.["id"] !== FULL_ACCESS_PROFILE)
  ) {
    throw new FullAccessError(
      "Codex did not confirm danger-full-access / never. TUI attachment is unavailable with restricted or unknown permissions; check native configuration/managed requirements. No policy was bypassed.",
    );
  }
}
