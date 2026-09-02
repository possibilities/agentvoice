import { describe, expect, test } from "bun:test";
import { renderScreen } from "../src/tui/app.ts";
import { barString, FRAME_SAMPLES, formatClock, levelFromDb, rmsDbS16 } from "../src/tui/dsp.ts";
import { sendCapturedFrame } from "../src/tui/duplex-audio.ts";

describe("dsp", () => {
  test("measures silence and full scale", () => {
    expect(rmsDbS16(Buffer.alloc(0))).toBe(-Infinity);
    expect(rmsDbS16(Buffer.alloc(8))).toBe(-Infinity);
    const loud = Buffer.alloc(8);
    for (let offset = 0; offset < 8; offset += 2) loud.writeInt16LE(32767, offset);
    expect(rmsDbS16(loud)).toBeCloseTo(0, 2);
  });

  test("maps dB onto a bounded level and a bar", () => {
    expect(levelFromDb(-Infinity)).toBe(0);
    expect(levelFromDb(-60)).toBe(0);
    expect(levelFromDb(0)).toBe(1);
    expect(levelFromDb(-30)).toBeCloseTo(0.5, 5);
    expect(barString(0.5, 4)).toBe("██  ");
    expect(barString(1, 3)).toBe("███");
    expect(barString(0, 3)).toBe("   ");
  });

  test("formats a clock", () => {
    expect(formatClock(-5)).toBe("00:00");
    expect(formatClock(65_000)).toBe("01:05");
    expect(formatClock(3_725_000)).toBe("1:02:05");
  });
});

describe("muted capture", () => {
  test("still sends a frame so the uplink cadence survives", () => {
    const sent: Buffer[] = [];
    const encoder = { encode: (frame: Buffer) => frame };
    const captured = Buffer.alloc(FRAME_SAMPLES * 2, 7);
    sendCapturedFrame(encoder, captured, true, (frame) => sent.push(frame));
    sendCapturedFrame(encoder, captured, false, (frame) => sent.push(frame));
    expect(sent).toHaveLength(2);
    expect(sent[0]!.every((byte) => byte === 0)).toBe(true);
    expect(sent[1]!.equals(captured)).toBe(true);
  });
});

describe("screen", () => {
  test("renders every fixed row within the viewport", () => {
    const styled = renderScreen(
      {
        title: "codpiece",
        phase: "live",
        liveForMs: 61_000,
        backend: { name: "fx-acp · gpt-5.6-terra", state: "working", detail: "turn 2" },
        mic: { muted: true, effectiveMuted: false, db: -20 },
        speaker: { muted: false, effectiveMuted: false, db: -35 },
        feed: ["voice connected", "you · hello there"],
      },
      80,
      12,
    );
    const text = styled.chunks.map((chunk) => chunk.text).join("");
    const lines = text.split("\n");
    expect(lines).toHaveLength(12);
    expect(lines[0]).toContain("LIVE 01:01");
    expect(lines[2]).toContain("TALKING");
    expect(lines[3]).toContain("LIVE");
    expect(lines[4]).toContain("working");
    expect(lines.some((line) => line.includes("you · hello there"))).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
  });
});
