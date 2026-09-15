/** One host-selected reader target. Browser requests never select a workspace or origin. */
export function webOrigin(name = "agentvoice"): string {
  if (!/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(name) && !/^[a-z]$/.test(name))
    throw new Error("--name must be a lowercase DNS label (1–63 letters, digits or hyphens)");
  return `https://${name}.localhost`;
}

export function configuredWebOrigin(env: Record<string, string | undefined>): string {
  return webOrigin(env["AGENTVOICE_WEB_NAME"] ?? "agentvoice");
}
