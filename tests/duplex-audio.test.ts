import { describe, expect, test } from "bun:test";
import { FRAME_SAMPLES } from "../src/console/dsp.ts";
import { sendCapturedFrame } from "../src/console/duplex-audio.ts";

function recordingEncoder(encoded: Buffer) {
  const inputs: Array<{ frame: Buffer; frameSize: number }> = [];
  return {
    encoder: {
      encode(frame: Buffer, frameSize: number): Buffer {
        inputs.push({ frame: Buffer.from(frame), frameSize });
        return encoded;
      },
    },
    inputs,
  };
}

describe("microphone frame sending", () => {
  test("encodes captured PCM while unmuted", () => {
    const captured = Buffer.alloc(FRAME_SAMPLES * 2, 0x5a);
    const encoded = Buffer.from([1, 2, 3]);
    const { encoder, inputs } = recordingEncoder(encoded);
    const sent: Buffer[] = [];

    sendCapturedFrame(encoder, captured, false, (frame) => sent.push(frame));

    expect(inputs).toEqual([{ frame: captured, frameSize: FRAME_SAMPLES }]);
    expect(sent).toEqual([encoded]);
  });

  test("encodes and sends a silent PCM frame while muted", () => {
    const captured = Buffer.alloc(FRAME_SAMPLES * 2, 0x5a);
    const encoded = Buffer.from([4, 5, 6]);
    const { encoder, inputs } = recordingEncoder(encoded);
    const sent: Buffer[] = [];

    sendCapturedFrame(encoder, captured, true, (frame) => sent.push(frame));

    expect(inputs).toEqual([{ frame: Buffer.alloc(FRAME_SAMPLES * 2), frameSize: FRAME_SAMPLES }]);
    expect(sent).toEqual([encoded]);
  });
});
