import { resolve } from "node:path";
import { preview } from "vite";
import { configuredWebOrigin, configuredWebOrigins } from "../../src/web-target.ts";

const origin = configuredWebOrigin(process.env);
const allowedHosts = configuredWebOrigins(process.env).map((value) => new URL(value).hostname);
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535 || process.env.PORTLESS_URL !== origin) {
  throw new Error(
    "Start the production reader with agentvoice serve --production; portless must assign PORT and the configured AgentVoice origin.",
  );
}

// Portless normally adds a wildcard .localhost allowance. This reader serves
// private history and has exactly one named origin, including for static assets.
process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = hostname;
const root = resolve(import.meta.dirname, "..");
const server = await preview({
  root,
  configFile: resolve(root, "vite.config.ts"),
  preview: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    allowedHosts,
    cors: false,
  },
});
console.log(`AgentVoice live transcripts: ${origin}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.httpServer.close(() => process.exit(0)));
}
