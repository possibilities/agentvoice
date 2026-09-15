import type { IncomingMessage } from "node:http";
import { configuredWebOrigin } from "../../src/web-target.ts";

/** Forwarding headers authorize only the one fixed portless origin, never another local app. */
export function isLocalRequest(request: IncomingMessage, env = process.env): boolean {
  const peer = request.socket.remoteAddress;
  if (peer !== "127.0.0.1" && peer !== "::1" && peer !== "::ffff:127.0.0.1") return false;
  let configured: string;
  try {
    configured = configuredWebOrigin(env);
  } catch {
    return false;
  }
  const hostname = new URL(configured).hostname;
  const host = request.headers.host ?? "";
  let origin: string;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) origin = `http://${host}`;
  else if (
    env["PORTLESS_URL"] === configured &&
    (host === hostname || host === `${hostname}:443`) &&
    request.headers["x-forwarded-proto"] === "https"
  )
    origin = configured;
  else return false;
  return (
    (!request.headers.origin || request.headers.origin === origin) &&
    request.headers["sec-fetch-site"] !== "cross-site"
  );
}
