/**
 * AgentStart capability-pack discovery for AgentVoice's standalone Codex
 * app-server. AgentVoice owns no skill copies: it registers the default
 * common pack's canonical skill root on every app-server attachment.
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Environ } from "./paths.ts";

export const CAPABILITIES_ROOT_ENV = "AGENTSTART_CAPABILITIES_ROOT";

export function capabilitiesRoot(env: Environ, home: string): string {
  const override = env[CAPABILITIES_ROOT_ENV];
  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw new Error(`${CAPABILITIES_ROOT_ENV} must be an absolute path: ${override}`);
    }
    return override;
  }
  return join(home, ".local", "share", "agentstart", "capabilities");
}

export function commonSkillsRoot(env: Environ = process.env, home: string = homedir()): string {
  const root = join(capabilitiesRoot(env, home), "packs", "common", "skills");
  try {
    if (statSync(root).isDirectory()) return root;
  } catch {
    // The actionable installation error below owns absent and unreadable roots.
  }
  throw new Error(
    `AgentStart's common capability pack is missing at ${root}; ` +
      `run ~/code/agentstart/scripts/install.sh --install`,
  );
}

export interface CapabilityAttachment {
  request(method: string, params: unknown): Promise<unknown>;
}

/** Register common before invoking the thread start/resume operation. */
export async function withCommonSkills<T>(
  attachment: CapabilityAttachment,
  openThread: () => Promise<T>,
  root = commonSkillsRoot(),
): Promise<T> {
  await attachment.request("skills/extraRoots/set", { extraRoots: [root] });
  return openThread();
}
