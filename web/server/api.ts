import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CLIPBOARD_IMAGE_MIME_TYPES,
  MAX_CLIPBOARD_IMAGE_BYTES,
} from "../../src/attachment/image-contract.ts";
import {
  type ClipboardImageMimeType,
  LocalImageError,
  LocalImageStore,
} from "../../src/attachment/local-images.ts";
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function apiError(response: ServerResponse, status: number, error: string) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response
    .writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
    .end(JSON.stringify({ error }));
}

export function liveApi(
  reader: {
    read(): Promise<LiveView>;
    agentCommand?(command: AgentCommand): Promise<void>;
    localImageContext?(): Promise<
      | {
          viewId: string;
          workspace: string;
          threadId: string;
          current(): boolean;
        }
      | undefined
    >;
  },
  env = process.env,
  nonce?: string,
  documents?: Pick<DocumentReader, "load">,
  files: Pick<FilePicker, "list"> = new FilePicker(),
  images: Pick<LocalImageStore, "save" | "discard"> = new LocalImageStore(),
) {
  return (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    if (!isLocalRequest(request, env)) {
      if (
        request.url === "/api/document" ||
        request.url === "/api/files" ||
        request.url === "/api/clipboard-image"
      )
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
    if (request.url === "/api/clipboard-image") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        apiError(response, 405, "Method not allowed.");
        return;
      }
      const mimeType = request.headers["content-type"]?.toLowerCase();
      const viewId = request.headers["x-agentvoice-view-id"];
      const requestId = request.headers["x-agentvoice-image-id"];
      if (
        !request.headers.origin ||
        typeof mimeType !== "string" ||
        !CLIPBOARD_IMAGE_MIME_TYPES.includes(mimeType as ClipboardImageMimeType) ||
        typeof viewId !== "string" ||
        !UUID.test(viewId) ||
        typeof requestId !== "string" ||
        !UUID.test(requestId)
      ) {
        apiError(response, 403, "Forbidden.");
        return;
      }
      const declaredBytes = Number(request.headers["content-length"]);
      if (Number.isFinite(declaredBytes) && declaredBytes > MAX_CLIPBOARD_IMAGE_BYTES) {
        apiError(response, 413, "Image is larger than 10 MiB.");
        return;
      }
      if (!reader.localImageContext) {
        apiError(response, 503, "Image input is unavailable.");
        return;
      }
      void (async () => {
        const context = await reader.localImageContext?.();
        if (!context || context.viewId !== viewId || !context.current()) {
          apiError(response, 409, "The Agent view changed before saving.");
          return;
        }
        const chunks = (async function* () {
          for await (const chunk of request) yield Buffer.from(chunk);
        })();
        try {
          const saved = await images.save({
            identity: { workspace: context.workspace, threadId: context.threadId },
            requestId,
            mimeType: mimeType as ClipboardImageMimeType,
            chunks,
            current: context.current,
            cancelled: () => request.aborted,
          });
          if (!context.current()) {
            images.discard(saved);
            apiError(response, 409, "The Agent view changed while saving.");
            return;
          }
          if (!response.destroyed)
            response
              .writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
              .end(JSON.stringify({ path: saved.path }));
        } catch (error) {
          if (!response.destroyed)
            apiError(
              response,
              error instanceof LocalImageError ? error.status : 500,
              error instanceof LocalImageError ? error.message : "Image could not be saved.",
            );
        }
      })().catch(() => {
        if (!response.destroyed) apiError(response, 400, "Invalid image request.");
      });
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
