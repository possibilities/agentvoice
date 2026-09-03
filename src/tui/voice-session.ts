/**
 * The voice sidecar's control plane for one frontend: launch the Codpiece
 * voice sidecar, open its thread, and start or stop realtime sessions against
 * it. Delegations and transcripts arrive as notifications; the caller routes
 * them to the delegation bridge and the screen.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { AppServerClient, type AppServerExecutionProfile } from "../app-server.ts";
import type { EventJournal } from "../events.ts";

const CLIENT_VERSION = "0.1.0";

/** The sidecar's stdio launch: the realtime feature on, JSON-RPC over stdin/stdout. */
export function sidecarCommand(binaryPath: string): string[] {
  return [binaryPath, "-c", "features.realtime_conversation=true", "--listen", "stdio://"];
}
const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 15_000;

export interface SidecarDescription {
  binaryPath: string;
  schemaVersion: number;
  sourceRevision: string | null;
  binarySha256: string;
  requiresFxCredentialAuthority: boolean;
}

/** Reads the sidecar's adjacent metadata and confirms the binary is the one it describes. */
export function describeSidecar(binaryPath: string): SidecarDescription {
  const path = resolve(binaryPath);
  if (!existsSync(path)) throw new Error(`voice sidecar not found at ${path}`);
  const metadataPath = join(dirname(path), "metadata.json");
  if (!existsSync(metadataPath)) {
    throw new Error(`voice sidecar metadata not found at ${metadataPath}`);
  }
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  const schemaVersion = metadata["schemaVersion"];
  if (typeof schemaVersion !== "number") throw new Error("sidecar metadata has no schemaVersion");
  const binarySha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (typeof metadata["binarySha256"] === "string" && metadata["binarySha256"] !== binarySha256) {
    throw new Error(
      `voice sidecar binary does not match its metadata (sha256 ${binarySha256} vs ${metadata["binarySha256"]})`,
    );
  }
  return {
    binaryPath: path,
    schemaVersion,
    sourceRevision:
      typeof metadata["sourceRevision"] === "string" ? metadata["sourceRevision"] : null,
    binarySha256,
    requiresFxCredentialAuthority: schemaVersion >= 3,
  };
}

export interface VoiceSessionOptions {
  sidecarPath: string;
  workspace: string;
  voice: string;
  orchestratorModel: string;
  reasoningEffort: string;
  includeStartupContext: boolean;
  journal: EventJournal;
  credentialAuthority?: Duplex;
  /** Tests substitute a fake sidecar; the product always runs the isolated native profile. */
  command?: readonly string[];
  executionProfile?: AppServerExecutionProfile;
  onNotification?(method: string, params: Record<string, unknown>): void;
  onClosed?(reason: string): void;
  onError?(message: string): void;
  onStderr?(text: string): void;
}

export class VoiceSession {
  private realtimeSessionId: string | null = null;
  private closed = false;

  private constructor(
    readonly appServer: AppServerClient,
    readonly threadId: string,
    readonly voices: unknown,
    private readonly appServerCwd: string,
    private readonly options: VoiceSessionOptions,
  ) {}

  static async start(options: VoiceSessionOptions): Promise<VoiceSession> {
    const appServerCwd = mkdtempSync(join(tmpdir(), "codpiece-sidecar-"));
    let session: VoiceSession | null = null;
    const appServer = await AppServerClient.start({
      command: options.command ?? sidecarCommand(resolve(options.sidecarPath)),
      executionProfile: options.executionProfile ?? "native-voice-sidecar",
      ...(options.credentialAuthority ? { credentialAuthority: options.credentialAuthority } : {}),
      cwd: appServerCwd,
      clientVersion: CLIENT_VERSION,
      onNotification(method, params) {
        options.journal.record("app-server", `appserver.${method}`, sanitize(params));
        options.onNotification?.(method, params);
        session?.observe(method, params);
      },
      onStderr(text) {
        options.onStderr?.(text);
      },
    });
    try {
      const voices = await appServer.request("thread/realtime/listVoices", {});
      // A synthetic voice thread: an identity for the realtime session, with
      // no coding runtime behind it. The sidecar reads only these fields, so
      // sending an approval policy or sandbox would imply an isolation it does
      // not apply — its isolation comes from the launch profile instead.
      const thread = await appServer.request<Record<string, unknown>>("thread/start", {
        cwd: resolve(options.workspace),
        model: options.orchestratorModel,
        ephemeral: true,
      });
      const threadId = extractThreadId(thread);
      options.journal.record("app-server", "voice.thread.started", { threadId });
      session = new VoiceSession(appServer, threadId, voices, appServerCwd, options);
      return session;
    } catch (error) {
      await appServer.close().catch(() => {});
      rmSync(appServerCwd, { recursive: true, force: true });
      throw error;
    }
  }

  get realtimeActive(): boolean {
    return this.realtimeSessionId !== null;
  }

  /** Starts a realtime session with the frontend's offer and returns the answer SDP. */
  async startRealtime(offerSdp: string): Promise<string> {
    if (this.closed) throw new Error("voice session is closed");
    if (this.realtimeSessionId) throw new Error("a realtime session is already running");
    const realtimeSessionId = crypto.randomUUID();
    this.realtimeSessionId = realtimeSessionId;
    const started = this.appServer.waitForNotification(
      "thread/realtime/started",
      (params) => params["realtimeSessionId"] === realtimeSessionId,
      START_TIMEOUT_MS,
    );
    const answer = this.appServer.waitForNotification(
      "thread/realtime/sdp",
      (params) => typeof params["sdp"] === "string",
      START_TIMEOUT_MS,
    );
    const failed = this.appServer
      .waitForNotification("thread/realtime/error", () => true, START_TIMEOUT_MS)
      .then((params) => {
        throw new Error(`thread/realtime/error: ${notificationMessage(params)}`);
      });
    try {
      const request = this.appServer.request(
        "thread/realtime/start",
        {
          threadId: this.threadId,
          realtimeSessionId,
          version: "v3",
          voice: this.options.voice,
          outputModality: "audio",
          includeStartupContext: this.options.includeStartupContext,
          clientManagedHandoffs: true,
          delegationAckFiller: false,
          transport: { type: "webrtc", sdp: offerSdp },
        },
        START_TIMEOUT_MS,
      );
      const [, , answerParams] = await Promise.race([
        Promise.all([request, started, answer]),
        failed,
      ]);
      const sdp = answerParams["sdp"];
      if (typeof sdp !== "string") throw new Error("sidecar SDP notification had no SDP");
      this.options.journal.record("harness", "session.connected", {
        threadId: this.threadId,
        realtimeSessionId,
      });
      return sdp;
    } catch (error) {
      this.realtimeSessionId = null;
      throw error;
    } finally {
      void failed.catch(() => {});
      void started.catch(() => {});
      void answer.catch(() => {});
    }
  }

  async stopRealtime(): Promise<void> {
    if (!this.realtimeSessionId || this.closed) return;
    this.realtimeSessionId = null;
    const closed = this.appServer.waitForNotification(
      "thread/realtime/closed",
      () => true,
      STOP_TIMEOUT_MS,
    );
    void closed.catch(() => {});
    try {
      await this.appServer.request(
        "thread/realtime/stop",
        { threadId: this.threadId },
        STOP_TIMEOUT_MS,
      );
      await closed;
    } catch (error) {
      this.options.journal.record("harness", "session.stop-error", { message: message(error) });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.stopRealtime();
    this.closed = true;
    await this.appServer
      .request("thread/delete", { threadId: this.threadId }, 10_000)
      .catch(() => {});
    await this.appServer.close().catch(() => {});
    rmSync(this.appServerCwd, { recursive: true, force: true });
    this.options.journal.record("harness", "session.closed");
  }

  private observe(method: string, params: Record<string, unknown>): void {
    if (method === "thread/realtime/closed") {
      const reason = typeof params["reason"] === "string" ? params["reason"] : "closed";
      // A close we requested clears the id first; an upstream close reaches here with it set.
      if (this.realtimeSessionId) {
        this.realtimeSessionId = null;
        this.options.onClosed?.(reason);
      }
    } else if (method === "thread/realtime/error") {
      this.options.onError?.(notificationMessage(params));
    }
  }
}

function extractThreadId(thread: Record<string, unknown>): string {
  const nested = isRecord(thread["thread"]) ? thread["thread"] : thread;
  const id = nested["id"] ?? nested["threadId"];
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("thread/start returned no thread id");
  }
  return id;
}

function notificationMessage(params: Record<string, unknown>): string {
  const error = isRecord(params["error"]) ? params["error"] : params;
  return typeof error["message"] === "string" ? error["message"] : JSON.stringify(params);
}

function sanitize(params: Record<string, unknown>): Record<string, unknown> {
  if (typeof params["sdp"] === "string")
    return { ...params, sdp: `<${params["sdp"].length} bytes>` };
  return params;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
