/**
 * XDG path resolution for the console and the resident bundle: state files,
 * the resident's socket, and the config location.
 */
import { isAbsolute, join } from "node:path";

export type Environ = Record<string, string | undefined>;

export function stateDirectory(env: Environ, home: string): string {
  const xdg = env["XDG_STATE_HOME"];
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state");
  return join(base, "agentvoice");
}

/** Owner-only local IPC through which a Remote console attaches to the console. */
export function consoleControlSocketPath(env: Environ, home: string): string {
  return join(stateDirectory(env, home), "console.sock");
}

/**
 * The resident bundle's private directory: the app-server socket, the wrapper
 * script, the pick log, and the active-account state file. Kept 0700 — codex
 * refuses to bind its socket under a shared-writable parent, and unix socket
 * paths must stay under the ~104-byte SUN_LEN cap.
 */
export function residentDirectory(env: Environ, home: string): string {
  return join(stateDirectory(env, home), "resident");
}

/** The resident app-server's `--listen unix://` socket. */
export function residentSocketPath(env: Environ, home: string): string {
  return join(residentDirectory(env, home), "app-server.sock");
}

/** Written by the wrapper at every resident spawn: the account pick. */
export function residentStateFilePath(env: Environ, home: string): string {
  return join(residentDirectory(env, home), "resident.json");
}

/** The persisted orchestrator threadId; resumed on attach, replaced by fresh. */
export function threadStateFilePath(env: Environ, home: string): string {
  return join(stateDirectory(env, home), "thread.json");
}

/** Persisted worker registry, reconciled against the resident on attach. */
export function workersStateFilePath(env: Environ, home: string): string {
  return join(stateDirectory(env, home), "workers.json");
}

export function defaultConfigPath(env: Environ, home: string): string {
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".config");
  return join(base, "agentvoice", "server.json");
}

export function expandTilde(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}
