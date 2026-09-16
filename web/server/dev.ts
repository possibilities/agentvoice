import { resolve } from "node:path";
import { createServer } from "vite";
import { configuredWebOrigin, configuredWebOrigins } from "../../src/web-target.ts";

const origin = configuredWebOrigin(process.env);
const allowedHosts = configuredWebOrigins(process.env).map((value) => new URL(value).hostname);
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535 || process.env.PORTLESS_URL !== origin) {
  throw new Error(
    "Start the development reader with agentvoice serve; portless must assign PORT and the configured AgentVoice origin.",
  );
}

// Portless normally adds a wildcard .localhost allowance. This reader serves
// private history and has exactly one named origin, including for static assets.
process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = allowedHosts.join(",");
const root = resolve(import.meta.dirname, "..");
const server = await createServer({
  root,
  configFile: resolve(root, "vite.config.ts"),
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    allowedHosts,
    cors: false,
    // With host/port omitted Vite follows the page origin, so both the local
    // :443 route and Portless's allocated tailnet port receive live updates.
    hmr: { protocol: "wss" },
  },
});
await server.listen();
console.log(`AgentVoice live transcripts: ${origin}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.prependListener(signal, () => {
    // Keep a handler installed while Vite removes its TERM listener during close.
    // Both shutdown paths agree on a clean exit.
    process.exitCode = 0;
    void server.close().then(() => process.exit(0));
  });
}
