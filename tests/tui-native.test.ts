import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  duplexAudioAvailabilityError,
  duplexLibraryPath,
  NativeDuplexDevice,
} from "../src/tui/duplex-device.ts";

// Enumeration never opens a device, so this can run anywhere the library is
// built without prompting for microphone access.
describe.skipIf(!existsSync(duplexLibraryPath()))("native duplex audio", () => {
  test("loads with the expected ABI and enumerates devices without starting", () => {
    expect(duplexAudioAvailabilityError()).toBeNull();
    const device = new NativeDuplexDevice();
    try {
      expect(device.miniaudioVersion).toMatch(/^\d+\.\d+/);
      expect(Array.isArray(device.captureDevices())).toBe(true);
      expect(Array.isArray(device.playbackDevices())).toBe(true);
      expect(device.stats().started).toBe(false);
    } finally {
      device.close();
    }
  });

  test("rejects malformed frame buffers before touching native memory", () => {
    const device = new NativeDuplexDevice();
    try {
      expect(() => device.readCapture(Buffer.alloc(3))).toThrow("whole s16 mono frames");
      expect(() => device.writePlayback(Buffer.alloc(6))).toThrow("interleaved s16 stereo");
    } finally {
      device.close();
    }
  });
});
