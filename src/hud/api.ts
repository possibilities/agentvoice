import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { stateDirectory } from "../paths.ts";
import { discoverThreadMonitor, type ThreadMonitor } from "../threads/monitor.ts";
import { projectHud } from "./projection.ts";
import { WorkStore } from "./store.ts";

/** Forwarded headers authorize only this fixed portless app, never a caller-selected origin. */
export function isHudLocalRequest(request: IncomingMessage, env = process.env): boolean {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? ""))
    return false;
  const host = request.headers.host ?? "";
  let origin: string;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) origin = `http://${host}`;
  else if (
    env["PORTLESS_URL"] === "https://agenthud.localhost" &&
    (host === "agenthud.localhost" || host === "agenthud.localhost:443") &&
    request.headers["x-forwarded-proto"] === "https"
  )
    origin = "https://agenthud.localhost";
  else return false;
  return (
    (!request.headers.origin || request.headers.origin === origin) &&
    request.headers["sec-fetch-site"] !== "cross-site"
  );
}
export async function readHud(
  store: WorkStore,
  observe = () => discoverThreadMonitor(stateDirectory(process.env, homedir())),
) {
  const monitor = await observe().catch(
    (): ThreadMonitor => ({
      phase: "unavailable",
      inventory: "unavailable",
      threads: [],
      missingSettings: 0,
    }),
  );
  return projectHud(store.snapshot(), monitor);
}
export type HudApiOptions = { store?: WorkStore; observe?: () => Promise<ThreadMonitor> };
export function createHudApi(options: HudApiOptions = {}) {
  const store = options.store ?? new WorkStore();
  const observe =
    options.observe ?? (() => discoverThreadMonitor(stateDirectory(process.env, homedir())));
  let pending: Promise<ThreadMonitor> | undefined;
  let closed = false;
  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      if (request.url?.split("?")[0] !== "/api/hud") return false;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (!isHudLocalRequest(request)) {
        response.writeHead(403).end("forbidden");
        return true;
      }
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        response.writeHead(405).end("method not allowed");
        return true;
      }
      if (request.url !== "/api/hud") {
        response.writeHead(400).end("queries are not supported");
        return true;
      }
      try {
        pending ??= observe()
          .catch(
            (): ThreadMonitor => ({
              phase: "unavailable",
              inventory: "unavailable",
              threads: [],
              missingSettings: 0,
            }),
          )
          .finally(() => {
            pending = undefined;
          });
        const monitor = await pending;
        if (closed) {
          response.writeHead(503).end("HUD closed");
          return true;
        }
        const snapshot = projectHud(store.snapshot(), monitor);
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.writeHead(200).end(JSON.stringify(snapshot));
      } catch {
        response.writeHead(503).end("Work store unavailable");
      }
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      if (!options.store) store.close();
    },
  };
}
