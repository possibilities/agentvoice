/**
 * The spawn contract for the resident app-server — the one piece of vendor
 * process the architecture keeps: a launchd-supervised `codex app-server`
 * serving `--listen unix://` from the resident directory. Everything here is
 * shared between the installer (which renders the wrapper and plist), the
 * pick-home command (which the wrapper calls at every spawn), and the console
 * (which attaches to the socket and reads the account state file).
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

/** Three gates make the realtime surface work at all: this spawn flag,
 *  `experimentalApi: true` in initialize, and an explicit webrtc transport
 *  on thread/realtime/start. Verified against codex-cli 0.147.0. */
export const REALTIME_FEATURE = "realtime_conversation";

export const RESIDENT_LABEL = "com.agentvoice.resident";

export function residentArgv(codexBin: string, socketPath: string): string[] {
  return [codexBin, "app-server", "--enable", REALTIME_FEATURE, "--listen", `unix://${socketPath}`];
}

/** Written by `agentvoice resident pick-home` at every resident spawn. */
export interface ResidentState {
  /** Account email the resident runs as, or null for the canonical home. */
  account: string | null;
  /** CODEX_HOME the pick resolved to, or null for the canonical home. */
  codexHome: string | null;
  pickedAt: number;
}

/** Atomic write: a torn state file must never confuse the console. */
export function writeResidentState(path: string, state: ResidentState): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readResidentState(path: string): ResidentState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  return {
    account: typeof record["account"] === "string" ? record["account"] : null,
    codexHome: typeof record["codexHome"] === "string" ? record["codexHome"] : null,
    pickedAt: typeof record["pickedAt"] === "number" ? record["pickedAt"] : 0,
  };
}
