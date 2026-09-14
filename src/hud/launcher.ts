import { existsSync } from "node:fs";
import { request } from "node:https";
import { resolve } from "node:path";
import { runForeground } from "../web-serve.ts";

export function hudProxyReady(): Promise<boolean> {
  return new Promise((done) => {
    const probe = request(
      {
        hostname: "127.0.0.1",
        port: 443,
        path: "/",
        method: "HEAD",
        rejectUnauthorized: false,
        timeout: 2000,
      },
      (response) => {
        response.resume();
        done(response.headers["x-portless"] === "1");
      },
    );
    probe.on("error", () => done(false));
    probe.on("timeout", () => {
      probe.destroy();
      done(false);
    });
    probe.end();
  });
}
type LaunchDependencies = {
  which: typeof Bun.which;
  exists: (path: string) => boolean;
  ready: () => Promise<boolean>;
  run: typeof runForeground;
};
export async function launchHud(
  env = process.env,
  dependencies: Partial<LaunchDependencies> = {},
): Promise<number> {
  const deps = {
    which: Bun.which,
    exists: existsSync,
    ready: hudProxyReady,
    run: runForeground,
    ...dependencies,
  };
  const hud = resolve(import.meta.dir, "../../hud");
  const portless = resolve(hud, "node_modules/.bin/portless");
  const node = deps.which("node", { PATH: env["PATH"] ?? "" });
  if (!node || !deps.exists(portless) || !deps.exists(resolve(hud, "dist/index.html")))
    throw new Error(
      "HUD dependencies or built assets are missing. Run npm --prefix hud ci and npm --prefix hud run build in the installed checkout.",
    );
  if (!(await deps.ready()))
    throw new Error(
      "The shared portless HTTPS proxy is unavailable on loopback port 443. Complete portless service install or portless proxy start interactively, then retry agenthud serve.",
    );
  return deps.run(
    node,
    [
      portless,
      "--name",
      "agenthud",
      "--",
      process.execPath,
      resolve(import.meta.dir, "main.ts"),
      "serve",
      "--direct",
    ],
    hud,
    {
      ...env,
      PORTLESS: "1",
      PORTLESS_PORT: "443",
      PORTLESS_HTTPS: "1",
      PORTLESS_TLD: "localhost",
      PORTLESS_LAN: "0",
      PORTLESS_WILDCARD: "0",
      PORTLESS_TAILSCALE: "0",
      PORTLESS_FUNNEL: "0",
      PORTLESS_NGROK: "0",
      PORTLESS_SYNC_HOSTS: "0",
    },
  );
}
