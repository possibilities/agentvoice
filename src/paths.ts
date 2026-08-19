/**
 * XDG path resolution for the Server, the console, and the resident bundle:
 * state files, the sockets, and the config location.
 */
import { isAbsolute, join } from "node:path";

export type Environ = Record<string, string | undefined>;

export function stateDirectory(env: Environ, home: string): string {
  const xdg = env["XDG_STATE_HOME"];
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state");
  return join(base, "agentvoice");
}

/**
 * The Server's control socket: owner-only local IPC through which Consoles
 * and Remote consoles attach. Binding it is the single-Server lock.
 */
export function controlSocketPath(env: Environ, home: string): string {
  return join(stateDirectory(env, home), "control.sock");
}

/** The Server bundle's private directory: its launchd log. */
export function serverDirectory(env: Environ, home: string): string {
  return join(stateDirectory(env, home), "server");
}

/** The Server identity's private P-256 key; never copied to a Remote console. */
export function serverIdentityKeyPath(env: Environ, home: string): string {
  return join(serverDirectory(env, home), "identity-key.pem");
}

/** The self-signed certificate a paired Remote console pins as its TLS root. */
export function serverIdentityCertificatePath(env: Environ, home: string): string {
  return join(serverDirectory(env, home), "identity-cert.pem");
}

/** Per-device public-key trust entries; each can be revoked independently. */
export function pairedDevicesFilePath(env: Environ, home: string): string {
  return join(serverDirectory(env, home), "paired-devices.json");
}

/** A Remote console's pinned Server identity and remembered route candidates. */
export function remoteProfileFilePath(env: Environ, home: string): string {
  return join(stateDirectory(env, home), "remote.json");
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

/**
 * The surface server's unix socket (herdr, the reference implementation),
 * resolved the way herdr itself resolves it: the env override verbatim, else
 * the XDG config home.
 */
export function surfaceSocketPath(env: Environ, home: string): string {
  const override = env["HERDR_SOCKET_PATH"];
  if (override) return override;
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".config");
  return join(base, "herdr", "herdr.sock");
}

export function expandTilde(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}
