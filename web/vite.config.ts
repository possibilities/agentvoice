import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { stateDirectory } from "../src/paths.ts";
import { liveApi } from "./server/api.ts";
import { DocumentReader } from "./server/document-reader.ts";
import { LiveReader } from "./server/live-reader.ts";

const nonce = randomBytes(18).toString("base64");

function localApi(): Plugin {
  return {
    name: "agentvoice-live-api",
    configureServer(server) {
      const reader = new LiveReader(stateDirectory(process.env, homedir()));
      server.middlewares.use(liveApi(reader, process.env, nonce, new DocumentReader(reader)));
      server.httpServer?.once("close", () => reader.close());
    },
    configurePreviewServer(server) {
      const reader = new LiveReader(stateDirectory(process.env, homedir()));
      server.middlewares.use(liveApi(reader, process.env, undefined, new DocumentReader(reader)));
      server.httpServer.once("close", () => reader.close());
    },
  };
}

export default defineConfig({
  html: { cspNonce: nonce },
  server: { host: "127.0.0.1", strictPort: true, cors: false },
  preview: { host: "127.0.0.1", strictPort: true, cors: false },
  optimizeDeps: { include: ["@pierre/diffs", "@pierre/diffs/react"] },
  plugins: [localApi(), react()],
});
