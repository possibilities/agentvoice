import { createReadStream, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { createHudApi, type HudApiOptions, isHudLocalRequest } from "./api.ts";

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
};
export async function serveHud(options: HudApiOptions & { port?: number; dist?: string } = {}) {
  const root = realpathSync(options.dist ?? resolve(import.meta.dir, "../../hud/dist"));
  if (!statSync(resolve(root, "index.html")).isFile())
    throw new Error("Build hud/dist before serving the HUD");
  const api = createHudApi(options);
  const server = createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    if (!isHudLocalRequest(request)) {
      response.writeHead(403).end("forbidden");
      return;
    }
    if (await api.handle(request, response)) return;
    if (!["GET", "HEAD"].includes(request.method ?? "")) {
      response.setHeader("Allow", "GET, HEAD");
      response.writeHead(405).end("method not allowed");
      return;
    }
    try {
      const raw = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
      if (
        !raw.startsWith("/") ||
        raw.includes("\0") ||
        raw.split("/").some((part) => part === "..")
      )
        throw new Error("invalid path");
      const file = realpathSync(resolve(root, raw === "/" ? "index.html" : `.${raw}`));
      if (!file.startsWith(`${root}${sep}`) || !statSync(file).isFile())
        throw new Error("outside root");
      response.setHeader("Content-Type", contentTypes[extname(file)] ?? "application/octet-stream");
      response.setHeader(
        "Cache-Control",
        extname(file) === ".html" ? "no-cache" : "public, max-age=3600",
      );
      response.writeHead(200);
      if (request.method === "HEAD") response.end();
      else
        createReadStream(file)
          .on("error", () => response.destroy())
          .pipe(response);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  server.on("close", () => api.close());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 4174, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    api.close();
    throw error;
  }
  return server;
}
