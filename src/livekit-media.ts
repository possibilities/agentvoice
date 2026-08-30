import type { ReadableStreamDefaultReader as NodeReadableStreamDefaultReader } from "node:stream/web";
import { AudioFrame, type AudioSource, AudioStream, type RemoteTrack } from "@livekit/rtc-node";
import {
  AUDIO_FRAME_MS,
  AUDIO_FRAME_SAMPLES,
  AUDIO_SAMPLE_RATE,
  type DuplexRecorder,
  MONO_FRAME_BYTES,
} from "./audio.ts";
import type { EventJournal } from "./events.ts";

const OUTPUT_ACTIVITY_THRESHOLD = 256;
const OUTPUT_IDLE_MS = 300;

type AudioStreamReader = NodeReadableStreamDefaultReader<AudioFrame>;

interface ActivePlayback {
  id: string;
  pcm: Buffer;
  offset: number;
  resolve(): void;
  reject(error: Error): void;
}

/** Publishes a real-time 48 kHz microphone track and overlays scripted utterances on silence. */
export class LiveKitContinuousUplink {
  readonly fatal: Promise<never>;

  private active: ActivePlayback | null = null;
  private running: Promise<void> | null = null;
  private stopped = true;
  private rejectFatal: ((error: Error) => void) | null = null;

  constructor(
    private readonly options: {
      source: AudioSource;
      recorder: DuplexRecorder;
      journal: EventJournal;
    },
  ) {
    this.fatal = new Promise<never>((_resolve, reject) => {
      this.rejectFatal = reject;
    });
    void this.fatal.catch(() => {});
  }

  start(): void {
    if (!this.stopped) return;
    if (this.running) throw new Error("cannot restart a stopped LiveKit audio uplink");
    this.stopped = false;
    this.options.recorder.beginTimeline();
    this.running = this.run().catch((error) => {
      if (!this.stopped) this.rejectFatal?.(asError(error));
    });
  }

  play(id: string, pcm: Buffer): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("LiveKit audio uplink is not running"));
    if (this.active) {
      return Promise.reject(
        new Error(`cannot play ${id}; fixture utterance ${this.active.id} is still playing`),
      );
    }
    return new Promise((resolve, reject) => {
      this.active = { id, pcm, offset: 0, resolve, reject };
      this.options.journal.record("media", "input.audio.started", {
        id,
        durationMs: (pcm.length / 2 / AUDIO_SAMPLE_RATE) * 1_000,
      });
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.active) {
      this.active.reject(new Error("LiveKit audio uplink stopped"));
      this.active = null;
    }
    await this.running;
  }

  private async run(): Promise<void> {
    let nextFrameAt = performance.now();
    while (!this.stopped) {
      const frameBytes = Buffer.alloc(MONO_FRAME_BYTES);
      const active = this.active;
      if (active) {
        const remaining = active.pcm.length - active.offset;
        const bytes = Math.min(MONO_FRAME_BYTES, remaining);
        active.pcm.copy(frameBytes, 0, active.offset, active.offset + bytes);
        active.offset += bytes;
      }

      this.options.recorder.recordInput(frameBytes);
      const samples = new Int16Array(frameBytes.buffer, frameBytes.byteOffset, AUDIO_FRAME_SAMPLES);
      await this.options.source.captureFrame(
        new AudioFrame(samples, AUDIO_SAMPLE_RATE, 1, AUDIO_FRAME_SAMPLES),
      );

      if (active && active.offset >= active.pcm.length) {
        this.active = null;
        this.options.journal.record("media", "input.audio.finished", { id: active.id });
        active.resolve();
      }

      nextFrameAt += AUDIO_FRAME_MS;
      const now = performance.now();
      if (now - nextFrameAt > AUDIO_FRAME_MS * 3) {
        this.options.journal.record("media", "input.audio.clock-reset", {
          lagMs: now - nextFrameAt,
        });
        nextFrameAt = now;
      }
      const waitMs = Math.max(0, nextFrameAt - performance.now());
      if (waitMs > 0) await Bun.sleep(waitMs);
    }
  }
}

/** Captures subscribed agent audio, detects speech activity, and aligns it with evaluator input. */
export class LiveKitOutputMonitor {
  readonly fatal: Promise<never>;

  private readonly readers = new Set<AudioStreamReader>();
  private readonly tasks = new Set<Promise<void>>();
  private rejectFatal: ((error: Error) => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private stopped = false;

  constructor(
    private readonly options: {
      recorder: DuplexRecorder;
      journal: EventJournal;
    },
  ) {
    this.fatal = new Promise<never>((_resolve, reject) => {
      this.rejectFatal = reject;
    });
    void this.fatal.catch(() => {});
  }

  attach(track: RemoteTrack, data: Record<string, unknown> = {}): void {
    if (this.stopped) return;
    const stream = new AudioStream(track, {
      sampleRate: AUDIO_SAMPLE_RATE,
      numChannels: 1,
      frameSizeMs: AUDIO_FRAME_MS,
    });
    const reader = stream.getReader();
    this.readers.add(reader);
    this.options.journal.record("media", "media.agent-track.subscribed", data);
    const task = this.consume(reader)
      .catch((error) => {
        if (!this.stopped) this.rejectFatal?.(asError(error));
      })
      .finally(() => {
        this.readers.delete(reader);
        this.tasks.delete(task);
      });
    this.tasks.add(task);
  }

  isOutputActive(): boolean {
    return this.active;
  }

  async waitForOutputActive(timeoutMs: number): Promise<void> {
    if (this.active) return;
    const afterSeq = this.options.journal.snapshot().at(-1)?.seq ?? 0;
    await this.options.journal.waitForNext("output.audio.started", afterSeq, timeoutMs);
  }

  async waitForOutputIdle(timeoutMs: number): Promise<void> {
    if (!this.active) return;
    const afterSeq = this.options.journal.snapshot().at(-1)?.seq ?? 0;
    await this.options.journal.waitForNext("output.audio.stopped", afterSeq, timeoutMs);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const cancellations = [...this.readers].map((reader) => reader.cancel().catch(() => {}));
    await Promise.all(cancellations);
    await Promise.all([...this.tasks]);
    if (this.active) this.markIdle("monitor-stopped");
  }

  private async consume(reader: AudioStreamReader): Promise<void> {
    while (!this.stopped) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value.sampleRate !== AUDIO_SAMPLE_RATE || value.channels !== 1) {
        throw new Error(
          `LiveKit output frame was ${value.sampleRate} Hz/${value.channels} channels; ` +
            `expected ${AUDIO_SAMPLE_RATE} Hz mono`,
        );
      }
      const pcm = Buffer.from(value.data.buffer, value.data.byteOffset, value.data.byteLength);
      this.options.recorder.recordOutputMonoFrame(pcm);
      if (peakAmplitude(value.data) >= OUTPUT_ACTIVITY_THRESHOLD) this.markActive();
    }
  }

  private markActive(): void {
    if (!this.active) {
      this.active = true;
      this.options.journal.record("media", "output.audio.started");
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.markIdle("silence"), OUTPUT_IDLE_MS);
  }

  private markIdle(reason: string): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.active) return;
    this.active = false;
    this.options.journal.record("media", "output.audio.stopped", { reason });
  }
}

function peakAmplitude(samples: Int16Array): number {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
