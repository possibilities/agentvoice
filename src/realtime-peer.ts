import OpusScript from "opusscript";
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, RtpBuilder } from "werift";
import { AUDIO_SAMPLE_RATE, type DuplexRecorder } from "./audio.ts";
import type { EventJournal } from "./events.ts";

const OPUS = new RTCRtpCodecParameters({
  mimeType: "audio/opus",
  clockRate: AUDIO_SAMPLE_RATE,
  channels: 2,
});

export class RealtimePeer {
  private readonly journal: EventJournal;
  private readonly recorder: DuplexRecorder;
  private readonly pc = new RTCPeerConnection({ codecs: { audio: [OPUS] } });
  private readonly sendTrack = new MediaStreamTrack({ kind: "audio" });
  private readonly builder = new RtpBuilder({ between: 20, clockRate: AUDIO_SAMPLE_RATE });
  private readonly decoder = new OpusScript(AUDIO_SAMPLE_RATE, 2, OpusScript.Application.VOIP);
  private remoteSubscription: { unSubscribe(): void } | null = null;
  private connected = false;
  private closed = false;
  private lastOutputAudioEventAt = -Infinity;

  constructor(journal: EventJournal, recorder: DuplexRecorder) {
    this.journal = journal;
    this.recorder = recorder;
    this.pc.addTransceiver(this.sendTrack, { direction: "sendrecv" });
    const channel = this.pc.createDataChannel("oai-events");
    channel.onmessage = (message) => this.handleDataChannelMessage(message);

    this.pc.onTrack.subscribe((track) => {
      if (track.kind !== "audio") return;
      this.remoteSubscription?.unSubscribe();
      this.remoteSubscription = track.onReceiveRtp.subscribe((packet) => {
        if (this.closed || packet.payload.length === 0) return;
        try {
          const pcm = Buffer.from(this.decoder.decode(packet.payload));
          this.recorder.recordOutput(pcm, packet.header.timestamp);
        } catch (error) {
          this.journal.record("media", "output.audio.decode-error", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
      this.journal.record("media", "output.track.attached");
    });

    this.pc.connectionStateChange.subscribe((state) => {
      this.journal.record("media", `peer.${state}`);
      if (state === "connected") this.connected = true;
    });
  }

  async createOffer(): Promise<string> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    const sdp = this.pc.localDescription?.sdp;
    if (!sdp) throw new Error("WebRTC offer has no local description");
    return sdp;
  }

  async applyAnswer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: "answer", sdp });
  }

  async waitConnected(timeoutMs: number): Promise<void> {
    if (this.connected) return;
    const deadline = performance.now() + timeoutMs;
    while (!this.connected && performance.now() < deadline) await Bun.sleep(50);
    if (!this.connected) throw new Error(`WebRTC peer did not connect within ${timeoutMs}ms`);
  }

  sendOpus(payload: Buffer): void {
    if (!this.connected || this.closed) return;
    this.sendTrack.writeRtp(this.builder.create(payload));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.remoteSubscription?.unSubscribe();
    this.remoteSubscription = null;
    this.decoder.delete();
    // Werift can leave close() pending while ICE/DTLS shutdown drains. The
    // peer is already detached above; do not let artifact finalization hang on
    // transport teardown (the product implementation follows the same rule).
    void this.pc.close().catch(() => {});
  }

  private handleDataChannelMessage(message: unknown): void {
    const raw = dataChannelText(message);
    if (!raw) return;
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      this.journal.record("realtime", "realtime.non-json", { text: raw.slice(0, 200) });
      return;
    }
    if (!isRecord(event)) return;
    const type = typeof event["type"] === "string" ? event["type"] : "unknown";
    this.journal.record("realtime", "realtime.raw", sanitizeRealtimeEvent(event));

    switch (type) {
      case "session.started":
      case "session.updated": {
        const session = isRecord(event["session"]) ? event["session"] : {};
        this.journal.record("realtime", "voice.session.started", {
          rawType: type,
          model: typeof session["model"] === "string" ? session["model"] : null,
          voice: typeof session["voice"] === "string" ? session["voice"] : null,
        });
        break;
      }
      case "input_transcript.added":
        this.journal.record("realtime", "input.transcript.delta", transcriptItem(event));
        break;
      case "output_transcript.added":
        this.journal.record("realtime", "output.transcript.delta", transcriptItem(event));
        break;
      case "turn.done":
        this.recordTurnDone(event);
        break;
      case "delegation.created":
        this.journal.record("realtime", "delegation.created", delegation(event));
        break;
      case "output_audio.delta": {
        const now = performance.now();
        if (now - this.lastOutputAudioEventAt > 300) {
          this.journal.record("media", "output.audio.started");
        }
        this.lastOutputAudioEventAt = now;
        break;
      }
      case "error":
        this.journal.record("realtime", "voice.error", sanitizeRealtimeEvent(event));
        break;
    }
  }

  private recordTurnDone(event: Record<string, unknown>): void {
    const turn = isRecord(event["turn"]) ? event["turn"] : {};
    const role = typeof turn["role"] === "string" ? turn["role"] : "unknown";
    const text = typeof turn["transcript"] === "string" ? turn["transcript"] : "";
    if (role === "user") {
      this.journal.record("realtime", "input.transcript.done", { text });
    } else if (role === "assistant") {
      this.journal.record("realtime", "output.transcript.done", { text });
    } else {
      this.journal.record("realtime", "turn.done", { role, text });
    }
  }
}

function dataChannelText(message: unknown): string | null {
  const payload = isRecord(message) && "data" in message ? message["data"] : message;
  if (typeof payload === "string") return payload;
  if (payload instanceof ArrayBuffer) return new TextDecoder().decode(payload);
  if (ArrayBuffer.isView(payload)) {
    return new TextDecoder().decode(
      new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
    );
  }
  return null;
}

function transcriptItem(event: Record<string, unknown>): Record<string, unknown> {
  const item = isRecord(event["item"]) ? event["item"] : {};
  return {
    id: typeof item["id"] === "string" ? item["id"] : null,
    text: typeof item["text"] === "string" ? item["text"] : "",
  };
}

function delegation(event: Record<string, unknown>): Record<string, unknown> {
  const item = isRecord(event["item"]) ? event["item"] : {};
  const content = Array.isArray(item["content"]) ? item["content"] : [];
  const text = content
    .filter(isRecord)
    .filter((part) => part["type"] === "input_text")
    .map((part) => (typeof part["text"] === "string" ? part["text"] : ""))
    .join("");
  return {
    id: typeof item["id"] === "string" ? item["id"] : null,
    target: typeof item["target"] === "string" ? item["target"] : null,
    text,
  };
}

function sanitizeRealtimeEvent(event: Record<string, unknown>): Record<string, unknown> {
  if (typeof event["audio"] !== "string") return event;
  const { audio, ...rest } = event;
  return { ...rest, audioBytesBase64: audio.length };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
