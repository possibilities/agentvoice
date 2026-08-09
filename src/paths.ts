/**
 * XDG path resolution, shared by the server and the client: both need the
 * state directory, and the client has no other reason to reach into server
 * configuration.
 */
import { isAbsolute, join } from "node:path";

export type Environ = Record<string, string | undefined>;

export function stateDirectory(env: Environ, home: string): string {
  const xdg = env["XDG_STATE_HOME"];
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state");
  return join(base, "agentvoice");
}

/** The connection token: written by the server at boot, read by the client. */
export function tokenPath(env: Environ, home: string): string {
  return join(stateDirectory(env, home), "token");
}

export function defaultConfigPath(env: Environ, home: string): string {
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".config");
  return join(base, "agentvoice", "server.yaml");
}

export function expandTilde(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}
