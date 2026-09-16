/** One host-selected reader target. Browser requests never select a workspace or origin. */
export function webOrigin(name = "agentvoice"): string {
  if (!/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(name) && !/^[a-z]$/.test(name))
    throw new Error("--name must be a lowercase DNS label (1–63 letters, digits or hyphens)");
  return `https://${name}.localhost`;
}

export function configuredWebOrigin(env: Record<string, string | undefined>): string {
  return webOrigin(env["AGENTVOICE_WEB_NAME"] ?? "agentvoice");
}

/** Portless creates this value after registering an authenticated tailnet-only
 * Tailscale Serve route. Treat only its exact HTTPS origin as a second reader
 * origin; arbitrary forwarded hosts remain forbidden. */
export function configuredTailnetOrigin(
  env: Record<string, string | undefined>,
): string | undefined {
  const value = env["PORTLESS_TAILSCALE_URL"];
  if (!value) return;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".ts.net") ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      return;
    return url.origin;
  } catch {
    return;
  }
}

export function configuredWebOrigins(env: Record<string, string | undefined>): string[] {
  const local = configuredWebOrigin(env);
  const tailnet = configuredTailnetOrigin(env);
  return tailnet ? [local, tailnet] : [local];
}
