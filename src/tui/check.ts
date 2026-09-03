#!/usr/bin/env bun
/**
 * Proves the whole stack except the audio device: the orchestrator backend,
 * the voice sidecar, its Codex authority, the WebRTC peer, the voice model,
 * and downlink speech. It never opens a microphone or speaker, so it cannot
 * raise a permission dialog — that is the one thing only a person can do.
 *
 *   bun run check -- --voice-sidecar PATH [--workspace DIR] [--seconds N]
 */

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import OpusScript from "opusscript";
import { EventJournal } from "../events.ts";
import { FxAcpAdapter } from "../fx-acp-adapter.ts";
import { FxHeadlessOrchestrator } from "../fx-orchestrator.ts";
import type { OrchestratorAdapter } from "../orchestrator-adapter.ts";
import { CODEX_REFERENCE } from "../reference.ts";
import { AUDIBLE_PEAK_DBFS, FRAME_SAMPLES, rmsDbS16, SAMPLE_RATE } from "./dsp.ts";
import { describeSidecar, VoiceSession } from "./voice-session.ts";
import { VoiceTransport } from "./voice-transport.ts";

const UPLINK_INTERVAL_MS = 20;
const DEFAULT_LISTEN_SECONDS = 25;

interface Result {
  label: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "voice-sidecar": { type: "string" },
      workspace: { type: "string" },
      backend: { type: "string" },
      seconds: { type: "string" },
      fx: { type: "string" },
    },
    strict: true,
  });
  const sidecarPath = values["voice-sidecar"];
  if (typeof sidecarPath !== "string") {
    console.error("usage: bun run check -- --voice-sidecar PATH [--workspace DIR] [--seconds N]");
    process.exit(64);
  }
  const workspace = resolve(typeof values.workspace === "string" ? values.workspace : ".");
  const listenMs =
    (typeof values.seconds === "string" ? Number(values.seconds) : DEFAULT_LISTEN_SECONDS) * 1_000;
  const backend = values.backend === "fx-work-control" ? "fx-work-control" : "fx-acp";

  const results: Result[] = [];
  const record = (label: string, ok: boolean, detail: string): void => {
    results.push({ label, ok, detail });
    console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  };

  const sidecar = describeSidecar(sidecarPath);
  record(
    "voice sidecar",
    true,
    `schema ${sidecar.schemaVersion}, revision ${sidecar.sourceRevision?.slice(0, 10) ?? "unknown"}, sha256 ${sidecar.binarySha256.slice(0, 12)}`,
  );

  const journal = new EventJournal();
  const adapter: OrchestratorAdapter =
    backend === "fx-acp"
      ? new FxAcpAdapter({
          workspace,
          model: CODEX_REFERENCE.orchestratorModel,
          reasoningEffort: CODEX_REFERENCE.reasoningEffort,
          ...(typeof values.fx === "string" ? { fxPath: values.fx } : {}),
        })
      : new FxHeadlessOrchestrator({
          workspace,
          model: CODEX_REFERENCE.orchestratorModel,
          reasoningEffort: CODEX_REFERENCE.reasoningEffort,
          ...(typeof values.fx === "string" ? { fxPath: values.fx } : {}),
          ...(sidecar.requiresFxCredentialAuthority
            ? { credentialBroker: { proofMode: "none" as const } }
            : {}),
        });

  let session: VoiceSession | null = null;
  let transport: VoiceTransport | null = null;
  let uplink: ReturnType<typeof setInterval> | null = null;
  let encoder: OpusScript | null = null;
  let decoder: OpusScript | null = null;

  try {
    const identity = await adapter.start();
    record(
      "orchestrator backend",
      true,
      `${identity.backend} ${identity.version}, ${identity.model}/${identity.reasoningEffort}, auth ${identity.auth ?? "unknown"}`,
    );

    session = await VoiceSession.start({
      sidecarPath: sidecar.binaryPath,
      workspace,
      voice: CODEX_REFERENCE.voice,
      orchestratorModel: CODEX_REFERENCE.orchestratorModel,
      reasoningEffort: CODEX_REFERENCE.reasoningEffort,
      includeStartupContext: CODEX_REFERENCE.includeStartupContext,
      journal,
      ...(sidecar.requiresFxCredentialAuthority && adapter instanceof FxHeadlessOrchestrator
        ? { credentialAuthority: adapter.acquireCredentialBrokerChannel() }
        : {}),
      onError: (message) => record("sidecar error", false, message),
    });
    record("sidecar thread", true, `thread ${session.threadId}`);

    let voiceModel: string | null = null;
    let voiceName: string | null = null;
    let downlinkPackets = 0;
    let downlinkPcmBytes = 0;
    let peakDb = -Infinity;
    let transcript = "";
    decoder = new OpusScript(SAMPLE_RATE, 2, OpusScript.Application.VOIP);

    const activeSession = session;
    transport = new VoiceTransport({
      signal: {
        start: (offer) => activeSession.startRealtime(offer),
        stop: () => activeSession.stopRealtime(),
      },
      onPhase: () => {},
      onRemoteTrack: (track) => {
        track.onReceiveRtp.subscribe((packet) => {
          if (packet.payload.length === 0 || !decoder) return;
          downlinkPackets += 1;
          try {
            const pcm = Buffer.from(decoder.decode(packet.payload));
            downlinkPcmBytes += pcm.length;
            const db = rmsDbS16(pcm);
            if (db > peakDb) peakDb = db;
          } catch {
            // A single undecodable packet is not the thing under test.
          }
        });
      },
      onOaiEvent: (event) => {
        const type = typeof event["type"] === "string" ? event["type"] : "";
        if (type === "session.started" || type === "session.created") {
          const voiceSession = event["session"];
          if (voiceSession && typeof voiceSession === "object") {
            const record = voiceSession as Record<string, unknown>;
            if (typeof record["model"] === "string") voiceModel = record["model"];
            if (typeof record["voice"] === "string") voiceName = record["voice"];
          }
        }
        if (type === "turn.done") {
          const turn = event["turn"];
          if (turn && typeof turn === "object") {
            const record = turn as Record<string, unknown>;
            if (record["role"] === "assistant" && typeof record["transcript"] === "string") {
              transcript = record["transcript"];
            }
          }
        }
      },
      onInfo: () => {},
      onError: (line) => record("transport", false, line),
    });

    // Silence keeps the uplink cadence the service expects without ever
    // touching a capture device.
    encoder = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
    const silence = Buffer.alloc(FRAME_SAMPLES * 2);
    const frame = Buffer.from(encoder.encode(silence, FRAME_SAMPLES));
    uplink = setInterval(() => transport?.sendOpusFrame(frame), UPLINK_INTERVAL_MS);

    await transport.connect();
    record("webrtc peer", true, "connected");

    // The private voice model is deliberately absent from the wire, so this
    // reports what the session announced and never fails on it.
    console.log(
      `      voice session: model ${voiceModel ?? "not reported (expected)"}${voiceName ? `, voice ${voiceName}` : ""}`,
    );

    // Wait for the downlink to carry RTP at all: the media path is up before
    // anyone has spoken, and the agent stays silent until it is addressed.
    const rtpDeadline = Date.now() + listenMs;
    while (Date.now() < rtpDeadline && downlinkPackets === 0) await Bun.sleep(100);
    record(
      "downlink media",
      downlinkPackets > 0,
      downlinkPackets > 0 ? `${downlinkPackets} RTP packets decoded` : "no RTP arrived",
    );

    // Speak through the handoff path the orchestrator uses. This is the whole
    // output chain — sidecar, voice agent, synthesis, WebRTC — without a
    // microphone, and it is the part a person cannot verify by reading logs.
    peakDb = -Infinity;
    downlinkPcmBytes = 0;
    await activeSession.appServer.request(
      "thread/realtime/appendSpeech",
      {
        threadId: activeSession.threadId,
        text:
          "Say exactly this sentence aloud now, and nothing else: " + "The voice path is working.",
      },
      30_000,
    );
    const speechDeadline = Date.now() + listenMs;
    while (Date.now() < speechDeadline && peakDb < AUDIBLE_PEAK_DBFS) await Bun.sleep(100);
    if (peakDb >= AUDIBLE_PEAK_DBFS) await Bun.sleep(3_000);
    const seconds = downlinkPcmBytes / (SAMPLE_RATE * 2 * 2);
    record(
      "agent speech",
      peakDb >= AUDIBLE_PEAK_DBFS,
      peakDb >= AUDIBLE_PEAK_DBFS
        ? `${seconds.toFixed(1)}s of audible audio, peak ${peakDb.toFixed(1)} dBFS`
        : `only silence (peak ${Number.isFinite(peakDb) ? `${peakDb.toFixed(1)} dBFS` : "-inf"})`,
    );
    if (transcript) console.log(`      agent said: ${JSON.stringify(transcript.slice(0, 160))}`);
  } finally {
    if (uplink) clearInterval(uplink);
    await transport?.stop().catch(() => {});
    encoder?.delete();
    decoder?.delete();
    await session?.close().catch(() => {});
    await adapter.stop().catch(() => {});
    journal.close();
  }

  const failed = results.filter((result) => !result.ok);
  console.log(
    failed.length === 0
      ? "\nall checks passed — the only untested part is your microphone and speaker"
      : `\n${failed.length} check(s) failed: ${failed.map((result) => result.label).join(", ")}`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
