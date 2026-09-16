import type { IncomingMessage, ServerResponse } from "node:http";
import { configuredWebOrigin } from "../../src/web-target.ts";
import type { LiveView } from "../src/types.ts";
import { type AgentCommand, agentCommandSchema } from "./agent-controls.ts";
import { AgentSendError } from "./agent-sender.ts";
import {
  DocumentAccessError,
  type DocumentReader,
  type DocumentRequest,
  documentRequestSchema,
} from "./document-reader.ts";
import {
  FilePicker,
  FilePickerAccessError,
  type FilePickerRequest,
  filePickerRequestSchema,
} from "./file-picker.ts";
import { isLocalRequest } from "./local-origin.ts";

function apiError(response: ServerResponse, status: number, error: string) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response
    .writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
    .end(JSON.stringify({ error }));
}

export function liveApi(
  reader: { read(): Promise<LiveView>; agentCommand?(command: AgentCommand): Promise<void> },
  env = process.env,
  nonce?: string,
  documents?: Pick<DocumentReader, "load">,
  files: Pick<FilePicker, "list"> = new FilePicker(),
) {
  return (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    if (!isLocalRequest(request, env)) {
      if (request.url === "/api/document" || request.url === "/api/files")
        apiError(response, 403, "Forbidden.");
      else response.writeHead(403).end("Forbidden");
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
      `default-src 'self'; script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:* ${configuredWebOrigin(env).replace("https:", "wss:")}; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'`,
    );
    if (!request.url?.startsWith("/api/")) {
      next();
      return;
    }
    if (request.url === "/api/files") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        apiError(response, 405, "Method not allowed.");
        return;
      }
      if (
        !request.headers.origin ||
        !/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "")
      ) {
        apiError(response, 403, "Forbidden.");
        return;
      }
      void (async () => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 16 * 1024) {
            apiError(response, 413, "File request is too large.");
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        let input: FilePickerRequest;
        try {
          input = filePickerRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          apiError(response, 400, "Invalid file request.");
          return;
        }
        try {
          const listing = await files.list(input);
          if (!response.destroyed)
            response
              .writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
              .end(JSON.stringify(listing));
        } catch (error) {
          if (!response.destroyed)
            apiError(
              response,
              error instanceof FilePickerAccessError ? error.status : 500,
              error instanceof FilePickerAccessError
                ? error.message
                : "Folder could not be listed.",
            );
        }
      })().catch(() => {
        if (!response.destroyed) apiError(response, 400, "Invalid file request.");
      });
      return;
    }
    if (request.url === "/api/document") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        apiError(response, 405, "Method not allowed.");
        return;
      }
      if (
        !request.headers.origin ||
        !/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "")
      ) {
        apiError(response, 403, "Forbidden.");
        return;
      }
      if (!documents) {
        apiError(response, 503, "Document viewer is unavailable.");
        return;
      }
      void (async () => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 16 * 1024) {
            apiError(response, 413, "Document request is too large.");
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        let input: DocumentRequest;
        try {
          input = documentRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          apiError(response, 400, "Invalid document request.");
          return;
        }
        try {
          const document = await documents.load(input);
          if (!response.destroyed)
            response
              .writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
              .end(JSON.stringify(document));
        } catch (error) {
          if (!response.destroyed)
            apiError(
              response,
              error instanceof DocumentAccessError ? error.status : 500,
              error instanceof DocumentAccessError
                ? error.message
                : "Document could not be opened.",
            );
        }
      })().catch(() => {
        if (!response.destroyed) apiError(response, 400, "Invalid document request.");
      });
      return;
    }
    if (request.url === "/api/agent") {
      if (request.method !== "POST") {
        response.writeHead(405, { Allow: "POST" }).end("Method not allowed");
        return;
      }
      if (
        !request.headers.origin ||
        !/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "")
      ) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      void (async () => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 512 * 1024) {
            response.writeHead(413).end("Message too large");
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        let command: AgentCommand;
        try {
          command = agentCommandSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          response.writeHead(400).end("Invalid Agent request");
          return;
        }
        if (!reader.agentCommand) {
          response.writeHead(503).end("Agent input unavailable");
          return;
        }
        try {
          await reader.agentCommand(command);
          if (!response.destroyed)
            response
              .writeHead(200, { "Content-Type": "application/json" })
              .end(JSON.stringify({ ok: true }));
        } catch (error) {
          if (!response.destroyed)
            response.writeHead(409, { "Content-Type": "application/json" }).end(
              JSON.stringify({
                error: error instanceof Error ? error.message : "Agent request failed.",
                delivery: error instanceof AgentSendError ? error.delivery : "rejected",
              }),
            );
        }
      })().catch(() => {
        if (!response.destroyed) response.writeHead(400).end("Invalid Agent request");
      });
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
