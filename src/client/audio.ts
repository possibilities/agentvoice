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

/** Consecutive all-zero 20 ms chunks (~1 s) before warning about mic silence. */
const SILENCE_WARN_CHUNKS = 50;
const MAX_PLAYBACK_RESTARTS = 3;
/** A player alive this long proves health and resets the restart budget. */
const PLAYER_HEALTHY_MS = 30_000;
/**
 * Sustained backpressure this long means the player is no longer consuming at
 * realtime — the output device changed format underneath it (the Bluetooth
 * profile flip) or sox wedged. A fresh player opens the device as it now is.
 */
const PLAYER_STALL_MS = 1_000;
/** Pause between a player death and the next spawn attempt. */
const PLAYER_RESPAWN_COOLDOWN_MS = 1_000;

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

export interface PlaybackDeviceInfo {
  index: number;
  name: string;
  isDefault: boolean;
}

/**
 * Warning line when the chosen mic is the default speaker device, else null.
 * macOS drops a Bluetooth headset to telephony (HFP) while its mic is open —
 * output falls to mono 16 kHz and often goes silent under an already-playing
 * stream — so the shared device must be surfaced before capture starts.
 */
export function sharedDeviceWarning(
  deviceIndex: number | undefined,
  captureDevices: readonly CaptureDeviceInfo[],
  playbackDevices: readonly PlaybackDeviceInfo[],
): string | null {
  const capture =
    deviceIndex !== undefined
      ? captureDevices.find((d) => d.index === deviceIndex)
      : captureDevices.find((d) => d.isDefault);
  const playback = playbackDevices.find((d) => d.isDefault);
  if (!capture || !playback || capture.name !== playback.name) return null;
  const alternative = captureDevices.find((d) => d.name !== capture.name);
  const hint = alternative
    ? `; try another mic, e.g. --device ${alternative.index} (${alternative.name.trim()})`
    : "";
  return `mic and speakers are the same device (${capture.name.trim()}) — a Bluetooth headset drops to phone quality while its mic is open, and playback may briefly stall when the profile flips${hint}`;
}

/** Argv for a raw-PCM playback child, or null when sox is not installed. */
export function resolvePlaybackCommand(): string[] | null {
  const play = Bun.which("play");
  if (play) {
    return [
      play,
      "-q",
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
      "-q",
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
  private player: Subprocess<"pipe", "ignore", "ignore"> | null = null;
  private playerArgv: string[] | null = null;
  private playerRestarts = 0;
  private playerCooldownUntil = 0;
  /** Wall-clock start of the current backpressure episode, null when flowing. */
  private stallSince: number | null = null;
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
    const argv = resolvePlaybackCommand();
    if (!argv) {
      throw new Error(
        'sox is required for speaker playback — run "bun run setup" or "brew install sox"',
      );
    }
    this.encoder = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
    this.decoder = new OpusScript(SAMPLE_RATE, 2, OpusScript.Application.VOIP);
    // The player spawns lazily on first agent audio: opening the output device
    // before capture invites the Bluetooth profile flip to reconfigure the
    // device underneath an already-playing stream.
    this.playerArgv = argv;

    this.engine = Audio.create({ sampleRate: SAMPLE_RATE, playbackChannels: 2 });
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
    const warning = sharedDeviceWarning(
      this.options.deviceIndex,
      this.captureDevices(),
      this.engine.listPlaybackDevices() ?? [],
    );
    if (warning) this.options.onWarning(warning);
    this.capture = await this.engine.openCapture({
      channels: 1,
      chunkFrames: FRAME_SAMPLES,
      capacityFrames: SAMPLE_RATE, // 1 s of slack
    });
    void this.consumeCapture(this.capture);
  }

  attachRemote(track: MediaStreamTrack): void {
    this.detachRemote();
    const generation = ++this.remoteGeneration;
    this.warnedDecode = false;
    const subscription = track.onReceiveRtp.subscribe((packet) => {
      if (this.stopped || generation !== this.remoteGeneration) return;
      this.handleDownlink(packet.payload);
    });
    this.remoteSubscription = subscription;
    this.options.debug?.("remote audio track attached");
  }

  detachRemote(): void {
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

  /** Spawn the playback child if none is running and the budget allows it. */
  private maybeSpawnPlayer(): void {
    const argv = this.playerArgv;
    if (!argv || this.player || this.stopped) return;
    if (this.playerRestarts >= MAX_PLAYBACK_RESTARTS) return;
    if (Date.now() < this.playerCooldownUntil) return;
    const spawnedAt = Date.now();
    this.stallSince = null;
    const player = Bun.spawn(argv, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    this.player = player;
    void player.exited.then(() => {
      if (this.stopped || this.player !== player) return;
      this.player = null;
      this.stallSince = null;
      this.playerCooldownUntil = Date.now() + PLAYER_RESPAWN_COOLDOWN_MS;
      if (Date.now() - spawnedAt > PLAYER_HEALTHY_MS) this.playerRestarts = 0;
      this.playerRestarts++;
      // The next downlink chunk respawns it; no timer needed.
      this.options.onWarning(
        this.playerRestarts >= MAX_PLAYBACK_RESTARTS
          ? "speaker playback keeps failing — audio output disabled"
          : "speaker playback stalled or exited; restarting",
      );
    });
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

  private handleDownlink(payload: Buffer): void {
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
    if (this.speakerMuted) return;
    this.maybeSpawnPlayer();
    const player = this.player;
    if (!player) return;
    if (this.stallSince !== null) {
      // Late audio is worthless: drop chunks rather than queue them while the
      // pipe is blocked, and give up on a player that stays blocked.
      if (Date.now() - this.stallSince >= PLAYER_STALL_MS) player.kill("SIGKILL");
      return;
    }
    try {
      // Both calls return a Promise instead of a number near child death; an
      // unattached rejection (EPIPE) would crash the client.
      const wrote = player.stdin.write(pcm);
      if (wrote instanceof Promise) wrote.catch(() => {});
      const flushed = player.stdin.flush();
      if (flushed instanceof Promise) {
        this.stallSince = Date.now();
        flushed
          .then(() => {
            if (this.player === player) this.stallSince = null;
          })
          .catch(() => {});
      }
    } catch {
      // the exit handler restarts the child; drop this chunk
    }
  }
}
