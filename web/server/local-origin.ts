import type { IncomingMessage } from "node:http";
import { configuredWebOrigins } from "../../src/web-target.ts";

/** Forwarding headers authorize only the exact Portless origins, never another local app. */
export function isLocalRequest(request: IncomingMessage, env = process.env): boolean {
  const peer = request.socket.remoteAddress;
  if (peer !== "127.0.0.1" && peer !== "::1" && peer !== "::ffff:127.0.0.1") return false;
  let configured: string[];
  try {
    configured = configuredWebOrigins(env);
  } catch {
    return false;
  }
  const host = request.headers.host ?? "";
  let origin: string;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) origin = `http://${host}`;
  else {
    if (request.headers["x-forwarded-proto"] !== "https") return false;
    let requested: string;
    try {
      requested = new URL(`https://${host}`).origin;
    } catch {
      return false;
    }
    const match = configured.find((candidate) => candidate === requested);
    if (!match) return false;
    if (
      match.endsWith(".localhost")
        ? env["PORTLESS_URL"] !== match
        : env["PORTLESS_TAILSCALE_URL"] !== match
    )
      return false;
    origin = match;
  }
  return (
    (!request.headers.origin || request.headers.origin === origin) &&
    request.headers["sec-fetch-site"] !== "cross-site"
  );
}
