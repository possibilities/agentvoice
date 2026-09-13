import type { IncomingMessage, ServerResponse } from "node:http";
import type { LiveView } from "../src/types.ts";
import { isLocalRequest } from "./local-origin.ts";

export function liveApi(reader: { read(): Promise<LiveView> }, env = process.env, nonce?: string) {
  return (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    if (!isLocalRequest(request, env)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Permissions-Policy", "microphone=(), camera=(), geolocation=()");
    // Remote Markdown media and embeds must not leak private conversation content or local paths.
    response.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:* wss://agentvoice.localhost; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'`,
    );
    if (!request.url?.startsWith("/api/")) {
      next();
      return;
    }
    if (request.url !== "/api/live") {
      response.writeHead(404).end("Not found");
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end("Method not allowed");
      return;
    }
    void reader
      .read()
      .then((view) => {
        if (!response.destroyed)
          response
            .writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
            .end(JSON.stringify(view));
      })
      .catch(() => {
        if (!response.destroyed) response.writeHead(503).end("AgentVoice is unavailable");
      });
  };
}
