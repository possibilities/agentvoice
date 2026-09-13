import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { request } from "node:https";
import { resolve } from "node:path";

type Environ = Record<string, string | undefined>;

/** Portless identifies its loopback proxy even on the no-route HEAD response.
 * This probe sends no history and does not depend on local CA trust. Serving
 * must never prompt for sudo or silently fall back to a different public URL. */
function proxyReady(): Promise<boolean> {
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

/** Keep the CLI alive for its owned process. Portless forwards signals, reaps
 * the reader process tree, and unregisters its route before it exits. */
export function runForeground(
  command: string,
  args: string[],
  cwd: string,
  env: Environ,
): Promise<number> {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
    let stopped: number | undefined;
    const interrupt = () => {
      stopped = 130;
      child.kill("SIGINT");
    };
    const terminate = () => {
      stopped = 143;
      child.kill("SIGTERM");
    };
    // Portless handles INT/TERM; map HUP to its graceful shutdown path.
    const hangup = () => {
      stopped = 129;
      child.kill("SIGTERM");
    };
    const cleanup = () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      process.off("SIGHUP", hangup);
    };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    process.on("SIGHUP", hangup);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      done(stopped ?? code ?? (signal === "SIGINT" ? 130 : 143));
    });
  });
}

export async function serveWeb(env: Environ, production = false): Promise<number> {
  const web = resolve(import.meta.dir, "../web");
  const portless = resolve(web, "node_modules/.bin/portless");
  const node = Bun.which("node", { PATH: env["PATH"] ?? "" });
  if (
    !node ||
    !existsSync(portless) ||
    !existsSync(resolve(web, "node_modules/vite/package.json")) ||
    (production && !existsSync(resolve(web, "dist/index.html")))
  ) {
    throw new Error(
      `The live UI needs Node.js 24+ and installed web dependencies${production ? ", plus a production build" : ""}. Run npm --prefix ${web} ci${production ? ` and npm --prefix ${web} run build` : ""}.`,
    );
  }
  if (!(await proxyReady())) {
    throw new Error(
      "The portless HTTPS proxy is not running on loopback port 443. Run portless service install or portless proxy start interactively, complete sudo/CA setup, then retry agentvoice serve.",
    );
  }
  return runForeground(
    node,
    [
      portless,
      "--name",
      "agentvoice",
      "--",
      process.execPath,
      resolve(web, production ? "server/preview.ts" : "server/dev.ts"),
    ],
    web,
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
      // A service cannot answer sudo prompts. DNS/CA setup belongs to the shared proxy.
      PORTLESS_SYNC_HOSTS: "0",
    },
  );
}
