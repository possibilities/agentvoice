/**
 * The audio pipeline: OpenTUI microphone capture → Opus → transport uplink,
 * and transport downlink → Opus decode → a sox `play` child process (OpenTUI
 * streams cannot ingest raw PCM yet, so playback goes out of process).
 * Decoding continues while the speaker is muted so the agent meter stays live.
 */
import { Audio, type AudioCaptureStream } from "@opentui/core";
import type { Subprocess } from "bun";
import OpusScript from "opusscript";
import type { MediaStreamTrack } from "werift";
import { FRAME_SAMPLES, floatToS16, rmsDbFloat, rmsDbS16, SAMPLE_RATE } from "./dsp.ts";
import { observeSinkResult } from "./playback.ts";

/** Consecutive all-zero 20 ms chunks (~1 s) before warning about mic silence. */
const SILENCE_WARN_CHUNKS = 50;
const MAX_PLAYBACK_RESTARTS = 3;
/** A player alive this long proves health and resets the restart budget. */
const PLAYER_HEALTHY_MS = 30_000;
const PLAYBACK_CHANNELS = 2;
const PCM_BYTES_PER_SECOND = SAMPLE_RATE * PLAYBACK_CHANNELS * 2;
const DOWNLINK_LOG_INTERVAL_MS = 1_000;
const SLOW_SINK_OPERATION_MS = 100;

type Player = Subprocess<"pipe", "ignore", "pipe">;

interface DownlinkWindow {
  startedAt: number;
  lastPacketAt: number;
  firstTimestamp: number;
  lastTimestamp: number;
  lastSequenceNumber: number;
  packets: number;
  sequenceBreaks: number;
  opusBytes: number;
  pcmBytes: number;
  playerFrames: number;
  asyncSinkOperations: number;
  maxPendingSinkOperations: number;
}

export interface VoiceAudioOptions {
  deviceIndex?: number;
  sendFrame(frame: Buffer): void;
  onMicLevel(db: number): void;
  onAgentLevel(db: number): void;
  onWarning(line: string): void;
  debug?(line: string): void;
}

export interface CaptureDeviceInfo {
  index: number;
  name: string;
  isDefault: boolean;
}

/** Argv for a raw-PCM playback child, or null when sox is not installed. */
export function resolvePlaybackCommand(debug = false): string[] | null {
  // -q suppresses the progress meter while -V3 retains negotiated device
  // details. The latter is useful only when stderr is going to the debug log.
  const diagnostics = debug ? ["-V3", "-q"] : ["-q"];
  const play = Bun.which("play");
  if (play) {
    return [
      play,
      ...diagnostics,
      "-t",
      "raw",
      "-r",
      String(SAMPLE_RATE),
      "-e",
      "signed",
      "-b",
      "16",
      "-c",
      "2",
      "-",
    ];
  }
  const sox = Bun.which("sox");
  if (sox) {
    return [
      sox,
      ...diagnostics,
      "-t",
      "raw",
      "-r",
      String(SAMPLE_RATE),
      "-e",
      "signed",
      "-b",
      "16",
      "-c",
      "2",
      "-",
      "-d",
    ];
  }
  return null;
}

export class VoiceAudio {
  private readonly options: VoiceAudioOptions;
  private engine: Audio | null = null;
  private capture: AudioCaptureStream | null = null;
  private encoder: OpusScript | null = null;
  private decoder: OpusScript | null = null;
  private player: Player | null = null;
  private playerRestarts = 0;
  private pendingSinkOperations = 0;
  private downlinkWindow: DownlinkWindow | null = null;
  private seenRemoteAudio = false;
  private remoteSubscription: { unSubscribe(): void } | null = null;
  private remoteGeneration = 0;
  private silentChunks = 0;
  private warnedSilence = false;
  private warnedDecode = false;
  private stopped = false;

  micMuted = false;
  speakerMuted = false;

  constructor(options: VoiceAudioOptions) {
    this.options = options;
  }

  captureDevices(): CaptureDeviceInfo[] {
    return this.engine?.listCaptureDevices() ?? [];
  }

  async start(): Promise<void> {
    const argv = resolvePlaybackCommand(this.options.debug !== undefined);
    if (!argv) {
      throw new Error(
        'sox is required for speaker playback — run "bun run setup" or "brew install sox"',
      );
    }
    this.encoder = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
    this.decoder = new OpusScript(SAMPLE_RATE, PLAYBACK_CHANNELS, OpusScript.Application.VOIP);
    this.spawnPlayer(argv);

    this.engine = Audio.create({ sampleRate: SAMPLE_RATE, playbackChannels: PLAYBACK_CHANNELS });
    this.debugDevices("before capture");
    if (this.options.deviceIndex !== undefined) {
      const devices = this.captureDevices();
      const device = devices.find((d) => d.index === this.options.deviceIndex);
      if (!device) {
        const names = devices.map((d) => `${d.index}: ${d.name}`).join(", ") || "none found";
        throw new Error(`no capture device with index ${this.options.deviceIndex} (${names})`);
      }
      this.engine.selectCaptureDevice(device.index);
      this.options.debug?.(`capture device: ${device.name}`);
    }
    this.capture = await this.engine.openCapture({
      channels: 1,
      chunkFrames: FRAME_SAMPLES,
      capacityFrames: SAMPLE_RATE, // 1 s of slack
    });
    this.options.debug?.(
      `capture opened sample_rate=${this.capture.sampleRate} channels=${this.capture.channels} chunk_frames=${this.capture.chunkFrames}`,
    );
    this.debugDevices("after capture");
    void this.consumeCapture(this.capture);
  }

  attachRemote(track: MediaStreamTrack): void {
    this.detachRemote();
    const generation = ++this.remoteGeneration;
    this.warnedDecode = false;
    this.seenRemoteAudio = false;
    const subscription = track.onReceiveRtp.subscribe((packet) => {
      if (this.stopped || generation !== this.remoteGeneration) return;
      this.handleDownlink(packet.payload, packet.header.sequenceNumber, packet.header.timestamp);
    });
    this.remoteSubscription = subscription;
    this.options.debug?.("remote audio track attached");
  }

  detachRemote(): void {
    this.logDownlinkWindow("track detached");
    this.remoteGeneration++;
    this.remoteSubscription?.unSubscribe();
    this.remoteSubscription = null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.detachRemote();
    const capture = this.capture;
    this.capture = null;
    if (capture) {
      try {
        capture.stop();
        await Promise.race([capture.closed, new Promise((resolve) => setTimeout(resolve, 1_000))]);
      } catch {
        // capture may already be gone
      }
    }
    this.engine?.dispose();
    this.engine = null;
    const player = this.player;
    this.player = null;
    if (player) {
      try {
        player.stdin.end();
      } catch {
        // stdin may already be closed
      }
      const exited = await Promise.race([
        player.exited,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
      ]);
      if (exited === null) player.kill("SIGKILL");
    }
    this.encoder?.delete();
    this.decoder?.delete();
    this.encoder = null;
    this.decoder = null;
  }

  // -------------------------------------------------------------------------

  private spawnPlayer(argv: string[]): void {
    const spawnedAt = Date.now();
    const player = Bun.spawn(argv, { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    this.player = player;
    this.options.debug?.(`speaker player started pid=${player.pid} argv=${JSON.stringify(argv)}`);
    void this.consumePlayerStderr(player);
    void player.exited.then((exitCode) => {
      this.options.debug?.(
        `speaker player exited pid=${player.pid} code=${exitCode} signal=${player.signalCode ?? "none"} uptime_ms=${Date.now() - spawnedAt}`,
      );
      if (this.stopped || this.player !== player) return;
      this.player = null;
      if (Date.now() - spawnedAt > PLAYER_HEALTHY_MS) this.playerRestarts = 0;
      if (this.playerRestarts >= MAX_PLAYBACK_RESTARTS) {
        this.options.onWarning("speaker playback keeps failing — audio output disabled");
        return;
      }
      this.playerRestarts++;
      this.options.onWarning("speaker playback process exited; restarting");
      setTimeout(() => {
        if (!this.stopped) this.spawnPlayer(argv);
      }, 1_000);
    });
  }

  private async consumePlayerStderr(player: Player): Promise<void> {
    const reader = player.stderr.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        const lines = pending.split(/[\r\n]+/);
        pending = done ? "" : (lines.pop() ?? "");
        for (const line of lines) this.logPlayerStderrLine(player, line);
        if (done) break;
      }
      this.logPlayerStderrLine(player, pending);
    } catch (error) {
      this.options.debug?.(`speaker player stderr failed pid=${player.pid}: ${message(error)}`);
    }
  }

  private logPlayerStderrLine(player: Player, line: string): void {
    const trimmed = line.trim();
    if (trimmed) this.options.debug?.(`speaker player pid=${player.pid}: ${trimmed}`);
  }

  private debugDevices(stage: string): void {
    if (!this.options.debug || !this.engine) return;
    try {
      const capture = this.engine.listCaptureDevices() ?? [];
      const playback = this.engine.listPlaybackDevices() ?? [];
      this.options.debug(
        `audio devices ${stage} capture=${JSON.stringify(capture)} playback=${JSON.stringify(playback)}`,
      );
    } catch (error) {
      this.options.debug(`audio device inventory failed ${stage}: ${message(error)}`);
    }
  }

  private async consumeCapture(capture: AudioCaptureStream): Promise<void> {
    try {
      for await (const chunk of capture.readable) {
        if (this.stopped || this.capture !== capture) break;
        this.handleMicChunk(chunk);
      }
    } catch (error) {
      if (!this.stopped) {
        this.options.onWarning(
          `microphone capture failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private handleMicChunk(chunk: Float32Array): void {
    this.options.onMicLevel(rmsDbFloat(chunk));

    let allZero = true;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) {
      this.silentChunks++;
      if (this.silentChunks >= SILENCE_WARN_CHUNKS && !this.warnedSilence) {
        this.warnedSilence = true;
        this.options.onWarning(
          "microphone is delivering pure silence — check System Settings › Privacy & Security › Microphone for your terminal, then restart it",
        );
      }
    } else {
      this.silentChunks = 0;
      this.warnedSilence = false;
    }

    if (this.micMuted || !this.encoder) return;
    try {
      const frame = this.encoder.encode(floatToS16(chunk), FRAME_SAMPLES);
      this.options.sendFrame(Buffer.from(frame));
    } catch (error) {
      this.options.debug?.(
        `opus encode failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private handleDownlink(payload: Buffer, sequenceNumber: number, timestamp: number): void {
    if (!this.decoder || payload.length === 0) return;
    let pcm: Buffer;
    try {
      pcm = Buffer.from(this.decoder.decode(payload));
    } catch (error) {
      if (!this.warnedDecode) {
        this.warnedDecode = true;
        this.options.onWarning(
          `agent audio decode failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    this.options.onAgentLevel(rmsDbS16(pcm));
    this.recordDownlink(sequenceNumber, timestamp, payload.length, pcm.length);
    const player = this.speakerMuted ? null : this.player;
    if (player) {
      try {
        this.downlinkWindow && this.downlinkWindow.playerFrames++;
        const wrote = player.stdin.write(pcm);
        this.observeSinkOperation(player, "write", wrote);
        const flushed = player.stdin.flush();
        this.observeSinkOperation(player, "flush", flushed);
      } catch (error) {
        // The exit handler restarts the child; this frame is already lost.
        this.options.debug?.(`speaker player write threw pid=${player.pid}: ${message(error)}`);
      }
    }
    this.maybeLogDownlinkWindow();
  }

  private observeSinkOperation(player: Player, operation: string, result: unknown): void {
    const startedAt = Date.now();
    const pending = observeSinkResult(result, {
      resolved: () => {
        this.pendingSinkOperations--;
        const elapsed = Date.now() - startedAt;
        if (elapsed >= SLOW_SINK_OPERATION_MS) {
          this.options.debug?.(
            `speaker player ${operation} backpressure pid=${player.pid} duration_ms=${elapsed}`,
          );
        }
      },
      rejected: (error) => {
        this.pendingSinkOperations--;
        this.options.debug?.(
          `speaker player ${operation} rejected pid=${player.pid} duration_ms=${Date.now() - startedAt}: ${message(error)}`,
        );
      },
    });
    if (!pending) return;
    this.pendingSinkOperations++;
    const window = this.downlinkWindow;
    if (window) {
      window.asyncSinkOperations++;
      window.maxPendingSinkOperations = Math.max(
        window.maxPendingSinkOperations,
        this.pendingSinkOperations,
      );
    }
  }

  private recordDownlink(
    sequenceNumber: number,
    timestamp: number,
    opusBytes: number,
    pcmBytes: number,
  ): void {
    if (!this.options.debug) return;
    const now = Date.now();
    let window = this.downlinkWindow;
    if (!window) {
      window = {
        startedAt: now,
        lastPacketAt: now,
        firstTimestamp: timestamp,
        lastTimestamp: timestamp,
        lastSequenceNumber: sequenceNumber,
        packets: 0,
        sequenceBreaks: 0,
        opusBytes: 0,
        pcmBytes: 0,
        playerFrames: 0,
        asyncSinkOperations: 0,
        maxPendingSinkOperations: this.pendingSinkOperations,
      };
      this.downlinkWindow = window;
    } else if (((window.lastSequenceNumber + 1) & 0xffff) !== sequenceNumber) {
      window.sequenceBreaks++;
    }
    window.lastPacketAt = now;
    window.lastTimestamp = timestamp;
    window.lastSequenceNumber = sequenceNumber;
    window.packets++;
    window.opusBytes += opusBytes;
    window.pcmBytes += pcmBytes;
    if (!this.seenRemoteAudio) {
      this.seenRemoteAudio = true;
      this.options.debug(
        `agent audio first packet sequence=${sequenceNumber} rtp_timestamp=${timestamp} opus_bytes=${opusBytes} pcm_bytes=${pcmBytes} pcm_ms=${((pcmBytes / PCM_BYTES_PER_SECOND) * 1_000).toFixed(1)}`,
      );
    }
  }

  private maybeLogDownlinkWindow(): void {
    const window = this.downlinkWindow;
    if (window && window.lastPacketAt - window.startedAt >= DOWNLINK_LOG_INTERVAL_MS) {
      this.logDownlinkWindow("interval");
    }
  }

  private logDownlinkWindow(reason: string): void {
    const window = this.downlinkWindow;
    this.downlinkWindow = null;
    if (!window || !this.options.debug) return;
    const rtpMs = (((window.lastTimestamp - window.firstTimestamp) >>> 0) / SAMPLE_RATE) * 1_000;
    const pcmMs = (window.pcmBytes / PCM_BYTES_PER_SECOND) * 1_000;
    this.options.debug(
      `agent audio ${reason} wall_ms=${window.lastPacketAt - window.startedAt} rtp_ms=${rtpMs.toFixed(1)} pcm_ms=${pcmMs.toFixed(1)} packets=${window.packets} sequence_breaks=${window.sequenceBreaks} opus_bytes=${window.opusBytes} player_frames=${window.playerFrames} sink_async=${window.asyncSinkOperations} sink_pending=${this.pendingSinkOperations} sink_pending_peak=${window.maxPendingSinkOperations} muted=${this.speakerMuted}`,
    );
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
