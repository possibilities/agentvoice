import type { ServerConfig } from "./config.ts";

const NATIVE_PERMISSION_OVERRIDES = {
  sandbox_mode: "danger-full-access",
  approval_policy: "never",
  default_permissions: ":danger-full-access",
} as const;

/** Last startup overrides win without rewriting operator-supplied argv. */
export function fullAccessStartupConfig(config: ServerConfig): string[] | undefined {
  if (!config.allowFullAccess) return config.codexConfig;
  return [
    ...(config.codexConfig ?? []),
    ...Object.entries(NATIVE_PERMISSION_OVERRIDES).map(([key, value]) => `${key}="${value}"`),
  ];
}

/**
 * Explicit opt-in wins only permission selectors, after raw thread merging.
 * Native 0.153.4 uses the typed sandbox to override configured/persisted profiles.
 * Also replace native config selectors: it validates configured approval_policy
 * before applying the typed approvalPolicy override (notably for untrusted).
 * Managed requirements still constrain or reject these ordinary native requests.
 */
export function applyFullAccessOptIn(params: Record<string, unknown>): void {
  params["sandbox"] = "danger-full-access";
  params["approvalPolicy"] = "never";
  delete params["permissions"];
  const raw = params["config"];
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    params["config"] = {
      ...Object.fromEntries(
        Object.entries(raw).filter(
          ([key]) => !Object.hasOwn(NATIVE_PERMISSION_OVERRIDES, key.split(".")[0]!),
        ),
      ),
      ...NATIVE_PERMISSION_OVERRIDES,
    };
  }
}
