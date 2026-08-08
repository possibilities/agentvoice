#!/usr/bin/env bun
/** Open the real duplex device briefly and report its negotiated format/counters. */

import { FRAME_SAMPLES } from "../src/client/dsp.ts";
import { NativeDuplexDevice } from "../src/client/duplex-device.ts";

interface ProbeOptions {
  deviceIndex?: number;
  outputDeviceIndex?: number;
  durationMs: number;
}

function parseIndex(value: string | undefined, flag: string): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  if (
    value === undefined ||
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(parsed) ||
    parsed > 0x7fffffff
  ) {
    throw new Error(`${flag} requires a non-negative 32-bit integer`);
  }
  return parsed;
}

function parseOptions(argv: string[]): ProbeOptions {
  let deviceIndex: number | undefined;
  let outputDeviceIndex: number | undefined;
  let durationMs = 2_000;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--device") deviceIndex = parseIndex(value, flag);
    else if (flag === "--output-device") outputDeviceIndex = parseIndex(value, flag);
    else if (flag === "--duration-ms") durationMs = parseIndex(value, flag);
    else throw new Error(`unknown audio probe option ${JSON.stringify(flag)}`);
    index++;
  }
  if (durationMs === 0) throw new Error("--duration-ms must be greater than zero");
  return { deviceIndex, outputDeviceIndex, durationMs };
}

const options = parseOptions(process.argv.slice(2));
const device = new NativeDuplexDevice();
console.log(`miniaudio ${device.miniaudioVersion}`);
console.log("capture devices", device.captureDevices());
console.log("playback devices", device.playbackDevices());

const captureFrame = Buffer.allocUnsafe(FRAME_SAMPLES * 2);
let captureFramesRead = 0;
let timer: ReturnType<typeof setInterval> | null = null;
try {
  device.start(options.deviceIndex, options.outputDeviceIndex);
  console.log("negotiated", device.negotiatedFormat());
  timer = setInterval(() => {
    while (device.readCapture(captureFrame) === FRAME_SAMPLES) {
      captureFramesRead += FRAME_SAMPLES;
    }
  }, 5);
  await Bun.sleep(options.durationMs);
  console.log("probe", { captureFramesRead, stats: device.stats() });
  device.stop();
} finally {
  if (timer) clearInterval(timer);
  device.close();
}
