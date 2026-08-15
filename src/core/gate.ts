/**
 * Handshake gate: pure checks every HTTP request passes before it reaches the
 * WebSocket. Loopback is not private — a web page can open a WebSocket to
 * 127.0.0.1 (the handshake is exempt from the same-origin policy), and other
 * local users share the interface — so the bind alone is not the boundary.
 *
 * Browsers attach an Origin header to every WebSocket handshake and
 * cross-origin fetch; no legitimate client of this server is a web page, so
 * any Origin is refused outright. Host pinning refuses DNS-rebinding names.
 * The connection token authenticates the WebSocket itself.
 */
import { timingSafeEqual } from "node:crypto";

export type GateVerdict = { ok: true } | { ok: false; status: number; reason: string };

export function gateRequest(origin: string | null, host: string | null, port: number): GateVerdict {
  if (origin !== null) {
    return { ok: false, status: 403, reason: "browser connections are not accepted" };
  }
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return { ok: false, status: 421, reason: "unrecognized host" };
  }
  return { ok: true };
}

export function tokenMatches(presented: string | null, expected: string): boolean {
  if (presented === null || presented.length === 0 || expected.length === 0) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
