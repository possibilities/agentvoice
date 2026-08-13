import type { ServerWebSocket } from "bun";
import {
  APP_SERVER_GATEWAY_PROTOCOL,
  CLOSE_BUSY,
  CLOSE_UNAUTHORIZED,
  PROTOCOL_VERSION,
} from "../protocol.ts";
import { APP_SERVER_GATEWAY_PATH, type AppServerGateway } from "./appserver-gateway.ts";
import { gateRequest, tokenMatches } from "./gate.ts";

export interface SocketData {
  authorized: boolean;
  channel: "voice" | "app-server";
  observeAgentVoice: boolean;
  observeVoice: boolean;
}

export type AgentVoiceSocket = ServerWebSocket<SocketData>;

const WEBSOCKET_BACKPRESSURE_LIMIT = 16 << 20;

export interface VoiceSocketHandlers {
  open(socket: AgentVoiceSocket): void;
  message(socket: AgentVoiceSocket, text: string): void;
  close(socket: AgentVoiceSocket): void;
}

export interface HttpServerOptions {
  port: number;
  token: string;
  version: string;
  appServerGateway: AppServerGateway;
  voice: VoiceSocketHandlers;
  debug?(line: string): void;
}

/**
 * The authenticated loopback transport shared by the singleton voice Client
 * and any number of App-server gateway clients. Channel admission lives here
 * so adding observers can never consume or bypass the voice-client slot.
 */
export function startHttpServer(
  options: HttpServerOptions,
): ReturnType<typeof Bun.serve<SocketData>> {
  let voiceClient: AgentVoiceSocket | null = null;
  return Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: options.port,
    fetch(request, server) {
      const url = new URL(request.url);
      const verdict = gateRequest(
        request.headers.get("origin"),
        request.headers.get("host"),
        server.port ?? options.port,
      );
      if (!verdict.ok) return new Response(verdict.reason, { status: verdict.status });
      if (url.pathname === "/ws" || url.pathname === APP_SERVER_GATEWAY_PATH) {
        // A bad token still upgrades, then closes with 4401: a plain HTTP 401
        // reaches the client as an anonymous handshake failure, the close code
        // as a diagnosable error.
        const authorized = tokenMatches(url.searchParams.get("token"), options.token);
        return server.upgrade(request, {
          data: {
            authorized,
            channel: url.pathname === "/ws" ? "voice" : "app-server",
            observeAgentVoice:
              url.pathname === APP_SERVER_GATEWAY_PATH &&
              url.searchParams.getAll("observe").includes("agentvoice"),
            observeVoice:
              url.pathname === APP_SERVER_GATEWAY_PATH &&
              url.searchParams.getAll("observe").includes("voice"),
          },
        })
          ? undefined
          : new Response("websocket upgrade required", { status: 426 });
      }
      if (url.pathname === "/") {
        return Response.json({
          name: "agentvoice",
          version: options.version,
          protocol: PROTOCOL_VERSION,
          appServerGateway: {
            path: APP_SERVER_GATEWAY_PATH,
            protocol: APP_SERVER_GATEWAY_PROTOCOL,
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      // Audio flows peer-to-peer, so the socket is legitimately silent for
      // minutes; a short idle timeout would sever healthy sessions.
      idleTimeout: 120,
      sendPings: true,
      maxPayloadLength: 16 << 20,
      backpressureLimit: WEBSOCKET_BACKPRESSURE_LIMIT,
      closeOnBackpressureLimit: true,
      open(ws) {
        // Auth before channel behavior: an unauthorized caller learns nothing
        // about either the voice-client slot or the App-server gateway.
        if (!ws.data.authorized) {
          ws.close(CLOSE_UNAUTHORIZED, "missing or wrong connection token");
          return;
        }
        if (ws.data.channel === "app-server") {
          options.appServerGateway.add(ws, {
            observeAgentVoice: ws.data.observeAgentVoice,
            observeVoice: ws.data.observeVoice,
          });
          options.debug?.("app-server client connected");
          return;
        }
        if (voiceClient) {
          ws.close(CLOSE_BUSY, "another client is connected");
          return;
        }
        voiceClient = ws;
        options.voice.open(ws);
      },
      message(ws, raw) {
        const text = typeof raw === "string" ? raw : raw.toString();
        if (ws.data.channel === "app-server") {
          options.appServerGateway.handle(ws, text);
          return;
        }
        if (ws === voiceClient) options.voice.message(ws, text);
      },
      close(ws) {
        if (ws.data.channel === "app-server") {
          options.appServerGateway.remove(ws);
          options.debug?.("app-server client disconnected");
          return;
        }
        if (ws !== voiceClient) return;
        voiceClient = null;
        options.voice.close(ws);
      },
    },
  });
}
