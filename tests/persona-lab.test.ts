import { expect, test } from "bun:test";
import { MouseEvent, TextRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { parseArgs } from "../scripts/persona-lab.ts";
import { PersonaLab } from "../scripts/personas/app.ts";
import { AudioAnalyzer } from "../scripts/personas/audio.ts";
import { Persona } from "../scripts/personas/persona.ts";
import {
  type CaptureDevice,
  decodeWav,
  demoSpeech,
  MicrophoneSource,
  SpeechReplay,
} from "../scripts/personas/source.ts";
import { SpokenReplay } from "../scripts/personas/spoken.ts";
import {
  PersonaMotion,
  personaStates,
  renderPersona,
  variants,
} from "../scripts/personas/visual.ts";

const tone = (frequency: number, seconds = 0.5, rate = 24000, amplitude = 0.3) =>
  Float32Array.from(
    { length: Math.round(seconds * rate) },
    (_, i) => amplitude * Math.sin((i * 2 * Math.PI * frequency) / rate),
  );
const fingerprint = (pixels: Uint8Array) => Buffer.from(pixels).toString("base64");
const hasPlot = (text: string) => [...text].some((c) => c >= "\u2801" && c <= "\u28ff");

test("PCM analysis tracks frequency and is independent of chunk boundaries", () => {
  const pcm = tone(220);
  const whole = new AudioAnalyzer(24000);
  const chunked = new AudioAnalyzer(24000);
  whole.push(pcm);
  for (let i = 0; i < pcm.length; i += 137) chunked.push(pcm.subarray(i, i + 137));
  expect({ ...chunked.frame, stream: 0 }).toEqual({ ...whole.frame, stream: 0 });
  expect(whole.frame.rms).toBeCloseTo(0.21, 2);
  const high = new AudioAnalyzer(24000);
  high.push(tone(3200));
  expect(high.frame.centroid).toBeGreaterThan(whole.frame.centroid + 0.3);
  expect(high.frame.bands).not.toEqual(whole.frame.bands);
  whole.push(new Float32Array(24000));
  expect(whole.frame.level).toBeLessThan(0.001);
  expect(whole.frame.bands.every((n) => n < 0.001)).toBe(true);
});

test("analysis bounds bad samples, rejects malformed PCM, and removes sustained DC", () => {
  const analyzer = new AudioAnalyzer(48000);
  analyzer.push(Float32Array.from({ length: 4800 }, () => Number.NaN));
  expect(analyzer.frame.rms).toBe(0);
  analyzer.push(new Float32Array(48000).fill(4));
  expect(analyzer.frame.rms).toBeLessThan(0.0001);
  expect(analyzer.frame.bands.every(Number.isFinite)).toBe(true);
  expect(() => analyzer.pushS16(Buffer.alloc(3))).toThrow("whole");
  expect(() => analyzer.push(new Float32Array(96001))).toThrow("two seconds");
  expect(() => new AudioAnalyzer(0)).toThrow("sample rate");
});

test("all eight visuals react to speech, stay distinct, and fit compact cells", () => {
  const analyzer = new AudioAnalyzer(24000);
  analyzer.push(tone(310));
  for (const [width, height] of [
    [12, 4],
    [24, 1],
    [40, 12],
  ]) {
    const forms = new Set<string>();
    for (const variant of variants) {
      const quiet = new PersonaMotion();
      const voice = new PersonaMotion();
      quiet.state = voice.state = "listening";
      voice.audio = { input: analyzer.frame };
      quiet.settle();
      voice.settle();
      const plain = renderPersona(quiet, variant.id, width!, height!);
      const reactive = renderPersona(voice, variant.id, width!, height!);
      expect(reactive.pixels).not.toEqual(plain.pixels);
      expect(reactive.pixels.some((pixel) => pixel > 0)).toBe(true);
      forms.add(fingerprint(reactive.pixels));
      for (const state of personaStates) {
        voice.state = state;
        voice.settle();
        for (const [w, h] of [
          [1, 1],
          [7, 3],
          [12, 4],
          [24, 1],
        ]) {
          const raster = renderPersona(voice, variant.id, w!, h!);
          expect(raster.pixels.length).toBe(w! * h! * 8);
          expect(raster.pixels.every((pixel) => pixel <= 5)).toBe(true);
        }
      }
    }
    expect(forms.size).toBe(8);
  }
});

test("states own channel selection; missing frames decay and history stays bounded", () => {
  const analyzer = new AudioAnalyzer(24000);
  analyzer.push(tone(200));
  const motion = new PersonaMotion();
  motion.audio = { input: analyzer.frame };
  motion.state = "speaking";
  motion.settle();
  expect(motion.level).toBe(0);
  motion.state = "listening";
  motion.settle();
  expect(motion.level).toBeGreaterThan(0.5);
  for (let i = 0; i < 100; i++) motion.advance(0.02);
  expect(motion.level).toBeLessThan(0.001);
  expect(motion.bands.every((n) => n < 0.001)).toBe(true);
  for (let i = 0; i < 200; i++) {
    motion.audio = {
      input: { ...analyzer.frame, onset: 1, revision: i + 1, onsetRevision: i + 1 },
    };
    motion.advance(0.02);
  }
  expect(motion.history.length).toBeLessThanOrEqual(48);
  expect(motion.rings.length).toBeLessThanOrEqual(12);
  motion.state = "thinking";
  motion.settle();
  expect(motion.level).toBe(0);
});

test("state transitions keep phase continuous after a long session", () => {
  const motion = new PersonaMotion();
  motion.time = 600;
  motion.phase = 150;
  motion.state = "thinking";
  motion.advance(0.01);
  expect(motion.phase - 150).toBeGreaterThan(0);
  expect(motion.phase - 150).toBeLessThan(0.018);
  motion.state = "asleep";
  motion.settle();
  const phase = motion.phase;
  motion.advance(0.1);
  expect(motion.phase).toBe(phase);
});

test("voice motion ignores raw carrier phase while retaining speech loudness and timbre", () => {
  const analyzer = new AudioAnalyzer(24000);
  const frame = analyzer.push(tone(310));
  const first = new PersonaMotion();
  const shifted = new PersonaMotion();
  first.state = shifted.state = "listening";
  first.audio = { input: frame };
  shifted.audio = { input: { ...frame, waveform: frame.waveform.map((sample) => -sample) } };
  first.settle();
  shifted.settle();
  for (const variant of variants)
    expect(renderPersona(first, variant.id, 36, 10).pixels).toEqual(
      renderPersona(shifted, variant.id, 36, 10).pixels,
    );
  const high = new AudioAnalyzer(24000);
  shifted.audio = { input: high.push(tone(3200)) };
  shifted.settle();
  expect(shifted.wave).not.toEqual(first.wave);
  expect(shifted.centroid).toBeGreaterThan(first.centroid);
});

test("speech envelope responds promptly, bridges short gaps, and settles into quiet", () => {
  const analyzer = new AudioAnalyzer(24000);
  const frame = analyzer.push(tone(310, 0.04));
  const motion = new PersonaMotion();
  motion.state = "speaking";
  for (let i = 0; i < 6; i++) {
    motion.audio = { output: { ...frame, revision: i + 1 } };
    motion.advance(0.02);
  }
  expect(motion.level).toBeGreaterThan(frame.level * 0.75);
  const level = motion.level;
  const quiet = { ...frame, level: 0, rms: 0, bands: new Float32Array(16), onset: 0 };
  for (let i = 0; i < 2; i++) {
    motion.audio = { output: { ...quiet, revision: i + 7 } };
    motion.advance(0.02);
  }
  expect(motion.level).toBeGreaterThan(level * 0.8);
  for (let i = 0; i < 100; i++) motion.advance(0.02);
  expect(motion.level).toBeLessThan(0.001);
  motion.resetAudio();
  expect(motion.pulse).toBe(0);
  expect(motion.rings.length).toBe(0);
});

test("frequent acoustic attacks cannot create a strobing burst of rings", () => {
  const analyzer = new AudioAnalyzer(24000);
  const frame = analyzer.push(tone(310, 0.02));
  const motion = new PersonaMotion();
  motion.state = "listening";
  for (let i = 0; i < 50; i++) {
    motion.audio = { input: { ...frame, onset: 1, revision: i + 1, onsetRevision: i + 1 } };
    motion.advance(0.02);
  }
  expect(motion.rings.length).toBeGreaterThan(1);
  expect(motion.rings.length).toBeLessThanOrEqual(5);
});

test("switching persona states never revives stale channel frames or consumes attacks twice", () => {
  const analyzer = new AudioAnalyzer(24000);
  const frame = analyzer.push(tone(400, 0.02));
  const motion = new PersonaMotion();
  motion.state = "speaking";
  motion.audio = { output: frame };
  motion.settle();
  expect(motion.rings.length).toBe(1);
  for (let i = 0; i < 100; i++) motion.advance(0.02);
  expect(motion.level).toBeLessThan(0.001);
  motion.state = "thinking";
  motion.audio = {};
  motion.advance(0.02);
  motion.state = "speaking";
  motion.audio = { output: { ...frame } };
  motion.settle();
  expect(motion.level).toBeLessThan(0.001);
  expect(motion.rings.length).toBe(0);
});

test("syllable attacks survive multiple PCM hops and are consumed once", () => {
  const analyzer = new AudioAnalyzer(24000);
  const motion = new PersonaMotion();
  motion.state = "listening";
  const pcm = tone(400, 0.04);
  motion.audio = { input: analyzer.push(pcm) };
  expect(analyzer.frame.onsetRevision).toBeGreaterThan(0);
  motion.advance(1 / 30);
  expect(motion.rings.length).toBe(1);
  motion.audio = { input: analyzer.push(pcm) };
  motion.advance(1 / 30);
  expect(motion.rings.length).toBe(1);
  analyzer.push(new Float32Array(24000));
  const joinedLate = new PersonaMotion();
  joinedLate.state = "listening";
  joinedLate.audio = { input: analyzer.frame };
  joinedLate.settle();
  expect(joinedLate.rings.length).toBe(0);
});

test("a minimum-length WAV loop publishes completed audio across every wrap", () => {
  const source = new SpeechReplay(
    { samples: tone(400, 0.02, 8000), sampleRate: 8000 },
    "short loop",
  );
  source.setRunning(true);
  for (let i = 0; i < 100; i++) {
    source.advance(1 / 30);
    expect(source.frame.level).toBeGreaterThan(0.4);
    expect(source.position).toBeLessThan(source.duration);
  }
  source.close();
});

function wav(samples: number[], channels = 1, floating = false): Buffer {
  const bits = floating ? 32 : 16;
  const buffer = Buffer.alloc(44 + (samples.length * bits) / 8);
  buffer.write("RIFF");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(floating ? 3 : 1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE((8000 * channels * bits) / 8, 28);
  buffer.writeUInt16LE((channels * bits) / 8, 32);
  buffer.writeUInt16LE(bits, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(buffer.length - 44, 40);
  samples.forEach((value, i) => {
    if (floating) buffer.writeFloatLE(value, 44 + i * 4);
    else buffer.writeInt16LE(value, 44 + i * 2);
  });
  return buffer;
}

test("WAV supports PCM and float stereo; malformed and oversized input is rejected", () => {
  const pcm = decodeWav(wav(new Array(320).fill(16384)));
  expect(pcm.samples[0]).toBe(0.5);
  const stereo = Array.from({ length: 320 }, (_, i) => (i % 2 ? 0.25 : 0.75));
  expect(decodeWav(wav(stereo, 2, true)).samples[0]).toBe(0.5);
  expect(() => decodeWav(wav(stereo).subarray(0, 80))).toThrow("Truncated");
  const invalid = wav(stereo);
  invalid.writeUInt32LE(100000, 40);
  expect(() => decodeWav(invalid)).toThrow("Truncated");
  expect(() => decodeWav(wav([1]))).toThrow("duration");
  expect(() => decodeWav(wav(new Array(160).fill(Number.NaN), 1, true))).toThrow("non-finite");
  const compressed = wav(stereo);
  compressed.writeUInt16LE(6, 20);
  expect(() => decodeWav(compressed)).toThrow("PCM16");
});

test("actual speech fixtures cover five demo states and replay obeys pause, seek and close", async () => {
  const source = await demoSpeech();
  source.setRunning(true);
  const states = new Set<string>();
  let peaks = 0;
  for (let i = 0; i < Math.ceil(source.duration * 50); i++) {
    source.advance(0.02);
    states.add(source.cue!.state);
    if (source.frame.level > 0.4) peaks++;
  }
  expect(states.size).toBe(5);
  expect(peaks).toBeGreaterThan(60);
  source.seek(2);
  expect(source.frame.level).toBeGreaterThan(0);
  source.setRunning(false);
  source.advance(0.1);
  expect(source.position).toBe(2);
  source.seek(0);
  expect(source.frame.level).toBe(0);
  source.close();
  source.setRunning(true);
  source.advance(0.1);
  expect(source.position).toBe(0);
});

test("spoken replay follows elapsed playback across stalls, pause, seek, and late exits", async () => {
  let clock = 0;
  let cleanups = 0;
  const players: Array<{
    offset: number;
    stops: number;
    completion: ReturnType<typeof Promise.withResolvers<void>>;
  }> = [];
  const replay = new SpeechReplay({ samples: tone(400, 3), sampleRate: 24000 }, "test");
  const source = new SpokenReplay(
    replay,
    (_clip, offset) => {
      const item = { offset, stops: 0, completion: Promise.withResolvers<void>() };
      players.push(item);
      return {
        done: item.completion.promise,
        stop() {
          item.stops++;
          item.completion.resolve();
        },
      };
    },
    () => clock,
    async () => {
      cleanups++;
    },
  );
  source.setRunning(true);
  clock = 0.1;
  source.advance();
  expect(source.position).toBeCloseTo(0.1, 4);
  clock = 1.4;
  source.advance();
  expect(source.position).toBeCloseTo(1.4, 4);
  source.setRunning(false);
  expect(players[0]!.stops).toBe(1);
  clock = 20;
  source.setRunning(true);
  await Promise.resolve();
  source.advance();
  expect(players.length).toBe(2);
  expect(players[1]!.offset).toBeCloseTo(1.4, 4);
  source.seek(2);
  expect(players[1]!.stops).toBe(1);
  expect(players[2]!.offset).toBe(2);
  clock = 21.1;
  players[2]!.completion.resolve();
  await Promise.resolve();
  source.advance();
  expect(players[3]!.offset).toBe(0);
  await source.dispose();
  expect(players[3]!.stops).toBe(1);
  expect(cleanups).toBe(1);
  source.setRunning(true);
  expect(players.length).toBe(4);
});

test("spoken playback failures surface without starting another player", async () => {
  const completion = Promise.withResolvers<void>();
  let plays = 0;
  const source = new SpokenReplay(
    new SpeechReplay({ samples: tone(400), sampleRate: 24000 }, "test"),
    () => {
      plays++;
      return { done: completion.promise, stop() {} };
    },
  );
  source.setRunning(true);
  completion.reject(new Error("output device unavailable"));
  await Promise.resolve();
  expect(() => source.advance()).toThrow("output device unavailable");
  await source.dispose();
  expect(plays).toBe(1);
});

class FakeCapture implements CaptureDevice {
  starts = 0;
  stops = 0;
  closes = 0;
  pending = false;
  failStart = false;
  start(): void {
    this.starts++;
    if (this.failStart) throw new Error("capture refused");
  }
  stop(): void {
    this.stops++;
  }
  close(): void {
    this.closes++;
  }
  readCapture(target: Buffer): number {
    if (!this.pending) return 0;
    this.pending = false;
    for (let i = 0; i < target.length / 2; i++)
      target.writeInt16LE(Math.round(Math.sin(i * 0.1) * 15000), i * 2);
    return target.length / 2;
  }
}

test("microphone adapter discards stale capture, pauses, closes once, and cleans failed start", () => {
  const device = new FakeCapture();
  const source = new MicrophoneSource(device);
  device.pending = true;
  source.setRunning(true);
  expect(device.pending).toBe(false);
  device.pending = true;
  source.advance(0.02);
  expect(source.frame.level).toBeGreaterThan(0);
  source.setRunning(false);
  expect(device.stops).toBe(1);
  expect(source.frame.level).toBe(0);
  source.setRunning(true);
  expect(device.starts).toBe(2);
  source.close();
  source.close();
  source.setRunning(true);
  expect(device.closes).toBe(1);
  const failed = new FakeCapture();
  failed.failStart = true;
  const failedSource = new MicrophoneSource(failed);
  expect(() => failedSource.setRunning(true)).toThrow("capture refused");
  expect(failed.closes).toBe(1);
});

async function clickText(setup: TestRendererSetup, text: string): Promise<void> {
  const lines = setup.captureCharFrame().split("\n");
  const y = lines.findIndex((line) => line.includes(text));
  expect(y).toBeGreaterThanOrEqual(0);
  await setup.mockMouse.click(lines[y]!.indexOf(text), y);
  await setup.renderOnce();
}

test("lab keeps every variation reachable across gallery, card, sizes and tiny panes", async () => {
  const setup = await createTestRenderer({ width: 132, height: 40, kittyKeyboard: true });
  const source = await demoSpeech();
  source.seek(2);
  const lab = new PersonaLab(setup.renderer, source, { animate: false });
  try {
    for (const [width, height] of [
      [132, 40],
      [80, 24],
      [40, 18],
      [32, 12],
      [12, 4],
      [24, 1],
      [7, 3],
    ]) {
      setup.resize(width!, height!);
      for (let i = 0; i < 8; i++) {
        await setup.renderOnce();
        expect(hasPlot(setup.captureCharFrame())).toBe(true);
        expect(
          setup
            .captureCharFrame()
            .split("\n")
            .every((row) => [...row].length <= width!),
        ).toBe(true);
        setup.mockInput.pressArrow("right");
      }
      expect(lab.selected).toBe(0);
      for (const key of ["return", "v", "escape"]) {
        setup.mockInput.pressKey(key);
        await setup.renderOnce();
        expect(hasPlot(setup.captureCharFrame())).toBe(true);
      }
    }
  } finally {
    lab.close();
  }
});

test("lab state controls, scrubbing and modal pointer ownership share one state", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
  const lab = new PersonaLab(setup.renderer, await demoSpeech(), { animate: false });
  const staleClick = () =>
    lab.processMouseEvent(
      new MouseEvent(lab, {
        type: "down",
        button: 0,
        x: 9,
        y: 4,
        modifiers: { shift: false, alt: false, ctrl: false },
      }),
    );
  try {
    await setup.renderOnce();
    await clickText(setup, "[listening]");
    expect(lab.automatic).toBe(false);
    expect(lab.motion.state).toBe("listening");
    setup.mockInput.pressKey("]");
    await setup.renderOnce();
    expect(lab.motion.level).toBeGreaterThan(0);
    setup.mockInput.pressKey("r");
    await setup.renderOnce();
    expect(lab.motion.level).toBe(0);
    setup.mockInput.pressKey("k", { ctrl: true });
    staleClick();
    expect(lab.commandsOpen).toBe(true);
    await setup.renderOnce();
    await setup.mockInput.typeText("rose");
    setup.mockInput.pressEnter();
    await setup.renderOnce();
    expect(variants[lab.selected]!.id).toBe("rose");
    expect(lab.view).toBe("card");
    await clickText(setup, "[Sizes]");
    expect(setup.captureCharFrame()).toContain("12 × 4");
    expect(setup.captureCharFrame()).toContain("24 × 1");
    setup.mockInput.pressKey("3");
    expect(lab.motion.state).toBe("thinking");
    setup.mockInput.pressKey("a");
    expect(lab.automatic).toBe(true);
  } finally {
    lab.close();
  }
});

test("lab initialized unfocused starts no speech until focus returns", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  let starts = 0;
  let stops = 0;
  const source = new SpokenReplay(await demoSpeech(), () => {
    starts++;
    const completion = Promise.withResolvers<void>();
    return {
      done: completion.promise,
      stop() {
        stops++;
        completion.resolve();
      },
    };
  });
  const lab = new PersonaLab(setup.renderer, source, { initiallyFocused: false });
  try {
    await setup.renderOnce();
    expect(starts).toBe(0);
    expect(lab.live).toBe(false);
    setup.renderer.emit("focus");
    setup.renderer.emit("focus");
    expect(starts).toBe(1);
    expect(lab.live).toBe(true);
    setup.renderer.emit("blur");
    expect(stops).toBe(1);
    expect(lab.live).toBe(false);
  } finally {
    lab.close();
    await source.dispose();
  }
});

test("lab releases capture on blur, commands, pause, source failure and destruction", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
  const device = new FakeCapture();
  const before = setup.renderer.keyInput.listenerCount("keypress");
  const lab = new PersonaLab(setup.renderer, new MicrophoneSource(device));
  try {
    expect(device.starts).toBe(1);
    setup.renderer.emit("blur");
    expect(device.stops).toBe(1);
    setup.renderer.emit("focus");
    expect(device.starts).toBe(2);
    setup.mockInput.pressKey("?");
    expect(device.stops).toBe(2);
    setup.mockInput.pressEscape();
    expect(device.starts).toBe(3);
    setup.mockInput.pressKey(" ");
    expect(device.stops).toBe(3);
    device.failStart = true;
    setup.mockInput.pressKey(" ");
    expect(lab.error).toContain("capture refused");
    expect(lab.live).toBe(false);
    expect(device.closes).toBe(1);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Source stopped");
  } finally {
    lab.close();
  }
  expect(setup.renderer.keyInput.listenerCount("keypress")).toBe(before);
  expect(device.closes).toBe(1);
  await lab.done;
});

test("embeddable Persona stays within its cells and removes its renderer listeners", async () => {
  const setup = await createTestRenderer({ width: 40, height: 8 });
  const listeners = setup.renderer.listenerCount("blur");
  const persona = new Persona(setup.renderer, {
    width: 12,
    height: 4,
    position: "absolute",
    left: 1,
    top: 1,
    state: "thinking",
    paused: true,
  });
  setup.renderer.root.add(persona);
  setup.renderer.root.add(
    new TextRenderable(setup.renderer, {
      content: "neighbor",
      position: "absolute",
      left: 20,
      top: 2,
    }),
  );
  try {
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("neighbor");
    expect(hasPlot(setup.captureCharFrame())).toBe(true);
    const frame = setup.captureCharFrame();
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toBe(frame);
    persona.state = "asleep";
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toBe(frame);
    persona.paused = false;
    setup.renderer.emit("blur");
    expect(persona.live).toBe(false);
    setup.renderer.emit("focus");
    expect(persona.live).toBe(true);
    persona.destroy();
    expect(setup.renderer.listenerCount("blur")).toBe(listeners);
  } finally {
    setup.renderer.destroy();
  }
});

test("CLI validates its explicit source choice without loading a native device", () => {
  expect(parseArgs(["--variant", "rose", "--view", "sizes", "--state", "asleep"]).state).toBe(
    "asleep",
  );
  expect(parseArgs(["--help"]).mic).toBe(false);
  expect(() => parseArgs(["--mic", "--wav", "x.wav"])).toThrow("not both");
  expect(() => parseArgs(["--state", "busy"])).toThrow("Unknown persona state");
  expect(() => parseArgs(["--wav"])).toThrow("Missing");
  expect(() => parseArgs(["--mic", "--mic"])).toThrow("Duplicate");
  expect(parseArgs(["--say"]).say).toBe(true);
  expect(() => parseArgs(["--say", "--mic"])).toThrow("one audio source");
  expect(() => parseArgs(["--say", "--wav", "x.wav"])).toThrow("one audio source");
});
