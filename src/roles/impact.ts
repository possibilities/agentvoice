import { isDeepStrictEqual } from "node:util";
import type { ConfigValues, OrchestratorValues, VoiceValues } from "../core/config-schema.ts";
import type { RoleBundle } from "./store.ts";

export type SettingImpact = "voice" | "runtime" | "server" | "client";
// Exhaustive over the public schema. Open native objects deliberately have one
// conservative classification until their individual native controls are verified.
export const SETTING_IMPACTS = {
  "allow-full-access": "runtime",
  debug: "runtime",
  "codex-config": "runtime",
  codex: "runtime",
  role: "runtime",
  orchestrator: "runtime",
  voice: "voice",
} as const satisfies Record<keyof ConfigValues, SettingImpact>;
export const ORCHESTRATOR_IMPACTS = {
  workspace: "server",
  model: "runtime",
  effort: "runtime",
  personality: "runtime",
  sandbox: "runtime",
  "approval-policy": "runtime",
  "approvals-reviewer": "runtime",
  permissions: "runtime",
  "model-provider": "runtime",
  "service-tier": "runtime",
  ephemeral: "runtime",
  "history-mode": "runtime",
  "runtime-workspace-roots": "runtime",
  config: "runtime",
  extra: "runtime",
} as const satisfies Record<keyof OrchestratorValues, SettingImpact>;
export const VOICE_IMPACTS = {
  name: "voice",
  model: "voice",
  version: "voice",
  "include-startup-context": "voice",
  "delegation-ack-filler": "voice",
  "codex-response-handoff-mode": "voice",
  "codex-responses-as-items": "voice",
  "codex-response-item-prefix": "voice",
  "codex-response-handoff-channel-prefixes": "voice",
  "flush-transcript-tail-on-session-end": "voice",
  "client-managed-handoffs": "voice",
  extra: "runtime",
} as const satisfies Record<keyof VoiceValues, SettingImpact>;

export function roleImpact(before: RoleBundle, after: RoleBundle) {
  const changes: Array<{ setting: string; impact: SettingImpact }> = [];
  function compare(a: object, b: object, map: Record<string, SettingImpact>, prefix = "") {
    const left = a as Record<string, unknown>,
      right = b as Record<string, unknown>;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!Object.hasOwn(map, key)) throw new Error(`Unclassified setting: ${prefix}${key}`);
      if (!isDeepStrictEqual(left[key], right[key]))
        changes.push({ setting: `${prefix}${key}`, impact: map[key]! });
    }
  }
  const { voice: bv, orchestrator: bo, ...bt } = before.settings;
  const { voice: av, orchestrator: ao, ...at } = after.settings;
  compare(bt, at, SETTING_IMPACTS);
  compare(bo ?? {}, ao ?? {}, ORCHESTRATOR_IMPACTS, "orchestrator.");
  compare(bv ?? {}, av ?? {}, VOICE_IMPACTS, "voice.");
  if (before.hasRole !== after.hasRole || !isDeepStrictEqual(before.files, after.files))
    changes.push({ setting: "assets", impact: "runtime" });
  // Only voice.name has a narrow application implementation in this slice.
  const automatic = changes.every((change) => change.setting === "voice.name");
  const boundary = changes.some((change) => change.impact === "server")
    ? "server"
    : !automatic
      ? "runtime"
      : changes.length
        ? "voice"
        : "none";
  return {
    changes,
    boundary,
    action:
      boundary === "server"
        ? "Close the call and restart the server"
        : boundary === "runtime"
          ? "Restart the runtime; attached compositions must be closed and reopened"
          : boundary === "voice"
            ? "Reconnect the voice session"
            : "No restart required",
  };
}
