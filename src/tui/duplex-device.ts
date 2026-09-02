/**
 * Bun FFI boundary for the frontend-owned miniaudio duplex device. One
 * native callback moves raw PCM through a capture ring and a playback ring;
 * everything above this file is TypeScript.
 */

import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ABI_VERSION = 1;
export const DUPLEX_SAMPLE_RATE = 48_000;
export const DUPLEX_PLAYBACK_CHANNELS = 2;
const DEFAULT_CAPTURE_CAPACITY_FRAMES = DUPLEX_SAMPLE_RATE;
/** Delayed RTP bursts need refill headroom above the playout cushion. */
const DEFAULT_PLAYBACK_CAPACITY_FRAMES = DUPLEX_SAMPLE_RATE;
/** The archive's live trace reached a 451.6 ms delivery pause with clean decoded PCM. */
export const DUPLEX_PLAYBACK_START_FRAMES = DUPLEX_SAMPLE_RATE / 2;

const handleU32 = { args: [FFIType.ptr], returns: FFIType.u32 } as const;
const handleU64 = { args: [FFIType.ptr], returns: FFIType.u64 } as const;
const handleString = { args: [FFIType.ptr], returns: FFIType.cstring } as const;
const deviceName = { args: [FFIType.ptr, FFIType.u32], returns: FFIType.cstring } as const;
const deviceFlag = { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 } as const;

const abiSymbols = {
  avn_duplex_abi_version: { args: [], returns: FFIType.u32 },
} as const;

const nativeSymbols = {
  avn_duplex_abi_version: { args: [], returns: FFIType.u32 },
  avn_duplex_miniaudio_version: { args: [], returns: FFIType.cstring },
  avn_duplex_result_description: { args: [FFIType.i32], returns: FFIType.cstring },
  avn_duplex_create: { args: [FFIType.u32, FFIType.u32, FFIType.u32], returns: FFIType.ptr },
  avn_duplex_destroy: { args: [FFIType.ptr], returns: FFIType.void },
  avn_duplex_capture_device_count: handleU32,
  avn_duplex_playback_device_count: handleU32,
  avn_duplex_capture_device_name: deviceName,
  avn_duplex_playback_device_name: deviceName,
  avn_duplex_capture_device_is_default: deviceFlag,
  avn_duplex_playback_device_is_default: deviceFlag,
  avn_duplex_start: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  avn_duplex_stop: { args: [FFIType.ptr], returns: FFIType.i32 },
  avn_duplex_is_started: handleU32,
  avn_duplex_device_state: handleU32,
  avn_duplex_read_capture: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
  avn_duplex_write_playback: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
    returns: FFIType.u32,
  },
  avn_duplex_clear_playback: { args: [FFIType.ptr], returns: FFIType.void },
  avn_duplex_backend_name: handleString,
  avn_duplex_active_capture_device_name: handleString,
  avn_duplex_active_playback_device_name: handleString,
  avn_duplex_capture_internal_format: handleString,
  avn_duplex_playback_internal_format: handleString,
  avn_duplex_capture_internal_sample_rate: handleU32,
  avn_duplex_playback_internal_sample_rate: handleU32,
  avn_duplex_capture_internal_channels: handleU32,
  avn_duplex_playback_internal_channels: handleU32,
  avn_duplex_capture_period_frames: handleU32,
  avn_duplex_playback_period_frames: handleU32,
  avn_duplex_capture_buffered_frames: handleU32,
  avn_duplex_playback_buffered_frames: handleU32,
  avn_duplex_callback_count: handleU64,
  avn_duplex_capture_dropped_frames: handleU64,
  avn_duplex_playback_dropped_frames: handleU64,
  avn_duplex_playback_starvation_count: handleU64,
} as const;

function platformLibraryName(): string {
  if (process.platform === "darwin") return "libcodpiece_audio.dylib";
  if (process.platform === "win32") return "libcodpiece_audio.dll";
  return "libcodpiece_audio.so";
}

export function duplexLibraryPath(): string {
  return join(
    import.meta.dir,
    "..",
    "..",
    "build",
    "native",
    `${process.platform}-${process.arch}`,
    platformLibraryName(),
  );
}

function openNativeLibrary() {
  return dlopen(duplexLibraryPath(), nativeSymbols);
}

type NativeLibrary = ReturnType<typeof openNativeLibrary>;
let nativeLibrary: NativeLibrary | null = null;

function library(): NativeLibrary {
  if (nativeLibrary) return nativeLibrary;
  const path = duplexLibraryPath();
  if (!existsSync(path)) {
    throw new Error(`native duplex audio is not built — run "bun run native:build" (${path})`);
  }
  const probe = dlopen(path, abiSymbols);
  const actualAbi = probe.symbols.avn_duplex_abi_version();
  probe.close();
  if (actualAbi !== ABI_VERSION) {
    throw new Error(
      `native duplex audio ABI mismatch: client=${ABI_VERSION} library=${actualAbi}; run "bun run native:build"`,
    );
  }
  nativeLibrary = openNativeLibrary();
  return nativeLibrary;
}

export function duplexAudioAvailabilityError(): string | null {
  try {
    library();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export interface DuplexDeviceInfo {
  index: number;
  name: string;
  isDefault: boolean;
}

export interface DuplexNegotiatedFormat {
  backend: string;
  captureDevice: string;
  playbackDevice: string;
  capture: { format: string; sampleRate: number; channels: number; periodFrames: number };
  playback: { format: string; sampleRate: number; channels: number; periodFrames: number };
}

export interface DuplexStats {
  state: number;
  started: boolean;
  captureBufferedFrames: number;
  playbackBufferedFrames: number;
  callbacks: bigint;
  captureDroppedFrames: bigint;
  playbackDroppedFrames: bigint;
  playbackStarvations: bigint;
}

export interface NativeDuplexOptions {
  captureCapacityFrames?: number;
  playbackCapacityFrames?: number;
  playbackStartFrames?: number;
}

export class NativeDuplexDevice {
  private readonly native: NativeLibrary;
  private handle: Pointer | null;
  private running = false;

  constructor(options: NativeDuplexOptions = {}) {
    this.native = library();
    const captureCapacity = positiveFrames(
      options.captureCapacityFrames ?? DEFAULT_CAPTURE_CAPACITY_FRAMES,
      "captureCapacityFrames",
    );
    const playbackCapacity = positiveFrames(
      options.playbackCapacityFrames ?? DEFAULT_PLAYBACK_CAPACITY_FRAMES,
      "playbackCapacityFrames",
    );
    const playbackStart = positiveFrames(
      options.playbackStartFrames ?? DUPLEX_PLAYBACK_START_FRAMES,
      "playbackStartFrames",
    );
    if (playbackStart > playbackCapacity) {
      throw new RangeError("playbackStartFrames must not exceed playbackCapacityFrames");
    }
    const created = this.native.symbols.avn_duplex_create(
      captureCapacity,
      playbackCapacity,
      playbackStart,
    );
    if (created === null || created === 0 || created === 0n) {
      throw new Error("native duplex audio initialization failed");
    }
    this.handle = (typeof created === "bigint" ? Number(created) : created) as Pointer;
  }

  get miniaudioVersion(): string {
    return String(this.native.symbols.avn_duplex_miniaudio_version());
  }

  captureDevices(): DuplexDeviceInfo[] {
    const handle = this.requireHandle();
    const count = this.native.symbols.avn_duplex_capture_device_count(handle);
    return Array.from({ length: count }, (_, index) => ({
      index,
      name: String(this.native.symbols.avn_duplex_capture_device_name(handle, index)),
      isDefault: this.native.symbols.avn_duplex_capture_device_is_default(handle, index) !== 0,
    }));
  }

  playbackDevices(): DuplexDeviceInfo[] {
    const handle = this.requireHandle();
    const count = this.native.symbols.avn_duplex_playback_device_count(handle);
    return Array.from({ length: count }, (_, index) => ({
      index,
      name: String(this.native.symbols.avn_duplex_playback_device_name(handle, index)),
      isDefault: this.native.symbols.avn_duplex_playback_device_is_default(handle, index) !== 0,
    }));
  }

  start(captureDeviceIndex?: number, playbackDeviceIndex?: number): void {
    if (this.running) return;
    const result = this.native.symbols.avn_duplex_start(
      this.requireHandle(),
      nativeDeviceIndex(captureDeviceIndex, "captureDeviceIndex"),
      nativeDeviceIndex(playbackDeviceIndex, "playbackDeviceIndex"),
    );
    this.checkResult("start", result);
    this.running = true;
  }

  stop(): void {
    if (!this.handle || !this.running) return;
    const result = this.native.symbols.avn_duplex_stop(this.handle);
    this.running = false;
    this.checkResult("stop", result);
  }

  close(): void {
    const handle = this.handle;
    if (!handle) return;
    this.handle = null;
    this.running = false;
    this.native.symbols.avn_duplex_destroy(handle);
  }

  readCapture(target: Buffer): number {
    if (target.length === 0 || target.length % 2 !== 0) {
      throw new RangeError("capture target must contain whole s16 mono frames");
    }
    return this.native.symbols.avn_duplex_read_capture(
      this.requireHandle(),
      ptr(target),
      target.length / 2,
    );
  }

  writePlayback(source: Buffer): number {
    const bytesPerFrame = DUPLEX_PLAYBACK_CHANNELS * 2;
    if (source.length === 0 || source.length % bytesPerFrame !== 0) {
      throw new RangeError("playback source must contain whole interleaved s16 stereo frames");
    }
    return this.native.symbols.avn_duplex_write_playback(
      this.requireHandle(),
      ptr(source),
      source.length / bytesPerFrame,
    );
  }

  clearPlayback(): void {
    this.native.symbols.avn_duplex_clear_playback(this.requireHandle());
  }

  playbackBufferedFrames(): number {
    return this.native.symbols.avn_duplex_playback_buffered_frames(this.requireHandle());
  }

  negotiatedFormat(): DuplexNegotiatedFormat {
    const handle = this.requireHandle();
    const symbols = this.native.symbols;
    return {
      backend: String(symbols.avn_duplex_backend_name(handle)),
      captureDevice: String(symbols.avn_duplex_active_capture_device_name(handle)),
      playbackDevice: String(symbols.avn_duplex_active_playback_device_name(handle)),
      capture: {
        format: String(symbols.avn_duplex_capture_internal_format(handle)),
        sampleRate: symbols.avn_duplex_capture_internal_sample_rate(handle),
        channels: symbols.avn_duplex_capture_internal_channels(handle),
        periodFrames: symbols.avn_duplex_capture_period_frames(handle),
      },
      playback: {
        format: String(symbols.avn_duplex_playback_internal_format(handle)),
        sampleRate: symbols.avn_duplex_playback_internal_sample_rate(handle),
        channels: symbols.avn_duplex_playback_internal_channels(handle),
        periodFrames: symbols.avn_duplex_playback_period_frames(handle),
      },
    };
  }

  stats(): DuplexStats {
    const handle = this.requireHandle();
    const symbols = this.native.symbols;
    return {
      state: symbols.avn_duplex_device_state(handle),
      started: symbols.avn_duplex_is_started(handle) !== 0,
      captureBufferedFrames: symbols.avn_duplex_capture_buffered_frames(handle),
      playbackBufferedFrames: symbols.avn_duplex_playback_buffered_frames(handle),
      callbacks: symbols.avn_duplex_callback_count(handle),
      captureDroppedFrames: symbols.avn_duplex_capture_dropped_frames(handle),
      playbackDroppedFrames: symbols.avn_duplex_playback_dropped_frames(handle),
      playbackStarvations: symbols.avn_duplex_playback_starvation_count(handle),
    };
  }

  private requireHandle(): Pointer {
    if (!this.handle) throw new Error("native duplex audio device is closed");
    return this.handle;
  }

  private checkResult(action: string, result: number): void {
    if (result === 0) return;
    const description = String(this.native.symbols.avn_duplex_result_description(result));
    throw new Error(`native duplex audio ${action} failed: ${description} (${result})`);
  }
}

function positiveFrames(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) {
    throw new RangeError(`${name} must be a positive u32 frame count`);
  }
  return value;
}

function nativeDeviceIndex(value: number | undefined, name: string): number {
  if (value === undefined) return -1;
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) {
    throw new RangeError(`${name} must be a non-negative i32 device index`);
  }
  return value;
}
