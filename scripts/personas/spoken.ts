import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AudioFrame } from "./audio.ts";
import {
  type AudioSource,
  type Cue,
  composeDemo,
  loadWav,
  type SpeechClip,
  type SpeechReplay,
} from "./source.ts";

export interface Playback {
  stop(): void;
  done: Promise<void>;
}

/** Visual time follows playback elapsed time, including after a slow render. */
export class SpokenReplay implements AudioSource {
  readonly kind = "replay";
  readonly label = "say · spoken demo";
  private running = false;
  private closed = false;
  private player: Playback | undefined;
  private pending = new Set<Promise<void>>();
  private startedAt = 0;
  private startedPosition = 0;
  private ended = false;
  private failure: unknown;

  constructor(
    private replay: SpeechReplay,
    private play: (clip: SpeechClip, offset: number) => Playback,
    private now: () => number = () => performance.now() / 1000,
    private cleanup: () => Promise<void> = async () => {},
  ) {}

  get frame(): AudioFrame {
    return this.replay.frame;
  }
  get position(): number {
    return this.replay.position;
  }
  get duration(): number {
    return this.replay.duration;
  }
  get cue(): Cue | undefined {
    return this.replay.cue;
  }

  private startPlayer(): void {
    this.startedPosition = this.position;
    const player = this.play(this.replay.clip, this.position);
    this.player = player;
    this.startedAt = this.now();
    this.ended = false;
    const completion = player.done.then(
      () => {
        if (this.player === player) this.ended = true;
      },
      (error: unknown) => {
        if (this.player === player) this.failure = error;
      },
    );
    this.pending.add(completion);
    void completion.then(() => this.pending.delete(completion));
  }

  private stopPlayer(): void {
    const player = this.player;
    this.player = undefined;
    player?.stop();
  }

  private syncPosition(): void {
    const position = Math.min(
      this.duration - 1 / this.replay.clip.sampleRate,
      this.startedPosition + Math.max(0, this.now() - this.startedAt),
    );
    const difference = position - this.position;
    if (difference > 0.2) this.replay.seek(position);
    else if (difference > 0) {
      // SpeechReplay caps each advance; two bounded steps cover a delayed frame.
      this.replay.advance(Math.min(0.1, difference));
      if (difference > 0.1) this.replay.advance(difference - 0.1);
    }
  }

  setRunning(running: boolean): void {
    if (this.closed || running === this.running) return;
    if (this.failure) throw this.failure;
    if (running) {
      this.replay.setRunning(true);
      try {
        this.startPlayer();
      } catch (error) {
        this.replay.setRunning(false);
        throw error;
      }
    } else {
      this.syncPosition();
      this.stopPlayer();
      this.replay.setRunning(false);
    }
    this.running = running;
  }

  advance(): void {
    if (!this.running || this.closed) return;
    if (this.failure) throw this.failure;
    if (this.ended) {
      this.stopPlayer();
      this.replay.seek(0);
      this.startPlayer();
    }
    this.syncPosition();
  }

  seek(seconds: number): void {
    if (this.closed || !Number.isFinite(seconds)) return;
    this.stopPlayer();
    this.replay.seek(seconds);
    if (this.running) this.startPlayer();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.running = false;
    this.stopPlayer();
    this.replay.close();
  }

  async dispose(): Promise<void> {
    this.close();
    await Promise.allSettled([...this.pending]);
    await this.cleanup();
  }
}

function encodeWav(clip: SpeechClip, offset: number): Buffer {
  const samples = clip.samples.subarray(Math.floor(offset * clip.sampleRate));
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(clip.sampleRate, 24);
  bytes.writeUInt32LE(clip.sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++)
    bytes.writeInt16LE(
      Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32768))),
      44 + i * 2,
    );
  return bytes;
}

async function synthesize(
  text: string,
  rate: number,
  path: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const child = Bun.spawn(
    [
      "/usr/bin/say",
      "-r",
      String(rate),
      "--file-format=WAVE",
      "--data-format=LEI16@24000",
      "-o",
      path,
      text,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const stop = () => child.kill("SIGKILL");
  signal.addEventListener("abort", stop, { once: true });
  try {
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    signal.throwIfAborted();
    if (code !== 0) throw new Error(`say failed: ${error.trim() || `exit ${code}`}`);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

export async function spokenDemo(signal: AbortSignal): Promise<SpokenReplay> {
  if (process.platform !== "darwin")
    throw new Error("--say uses macOS say and afplay; use the bundled demo on other platforms");
  const directory = await mkdtemp(join(tmpdir(), "agentvoice-persona-say-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const you = join(directory, "you.wav");
    const agent = join(directory, "agent.wav");
    await synthesize("Help me find a little more space in my day.", 170, you, signal);
    await synthesize(
      "Let's start with one thing. What can wait until tomorrow?",
      165,
      agent,
      signal,
    );
    const replay = composeDemo(await loadWav(you), await loadWav(agent));
    signal.throwIfAborted();
    let revision = 0;
    return new SpokenReplay(
      replay,
      (clip, offset) => {
        const path = join(directory, `play-${++revision}.wav`);
        writeFileSync(path, encodeWav(clip, offset), { mode: 0o600 });
        const child = Bun.spawn(["/usr/bin/afplay", path], { stdout: "ignore", stderr: "pipe" });
        let stopped = false;
        return {
          stop() {
            stopped = true;
            child.kill("SIGKILL");
          },
          done: Promise.all([child.exited, new Response(child.stderr).text()])
            .then(([code, error]) => {
              if (!stopped && code !== 0)
                throw new Error(`Speech playback failed: ${error.trim() || `exit ${code}`}`);
            })
            .finally(() => rm(path, { force: true })),
        };
      },
      undefined,
      cleanup,
    );
  } catch (error) {
    await cleanup();
    throw error;
  }
}
