#!/usr/bin/env bun
import { basename } from "node:path";
import { createCliRenderer, type KeyEvent, RGBA, TextRenderable } from "@opentui/core";
import { type LabOptions, PersonaLab } from "./personas/app.ts";
import {
  type AudioSource,
  demoSpeech,
  loadWav,
  MicrophoneSource,
  SpeechReplay,
} from "./personas/source.ts";
import { type SpokenReplay, spokenDemo } from "./personas/spoken.ts";
import { personaStates, variants } from "./personas/visual.ts";
import { FxTheme, palette } from "./waveforms/theme.ts";

const usage = `Persona lab — eight audio-reactive OpenTUI voice visuals.

  bun run personas
  bun run personas --variant rose --view sizes
  bun run personas --say
  bun run personas --wav speech.wav --state speaking
  bun run personas --mic

--variant waterfall|phosphor|braid|fm|rose|radial|standing|lissajous
--state idle|listening|thinking|speaking|asleep  (manual preview)
--view gallery|card|sizes
--wav PATH  Mono/stereo PCM16 or float32 WAV, 8–96 kHz, 20 ms–120 s, ≤24 MiB.
--mic       Explicit live microphone input; requires bun run native:build.
--say       Generate speech with macOS say and play it aloud alongside the visuals.

Arrows / h/j/k/l select. Enter opens a voice card; V compares sizes.
1–5 choose a state; A restores the demo conversation cycle.
Space pauses; [ / ] seek by two seconds; R replays. Esc returns to gallery.
Ctrl+K or ? opens commands. Click controls or waveforms. Q or Ctrl+C quits.
Small panes automatically show a compact visual; click it to change variants.

Default demo and WAV replay are silent. --say plays the generated PCM with afplay.
--mic opens the native duplex device but never submits speaker audio.
Capture and spoken playback stop while paused, unfocused, in commands, and on exit.
This standalone lab starts no voice call or Codex process.
FX_THEME=dark|light overrides terminal theme detection.
`;

export function parseArgs(
  args: string[],
): LabOptions & { wav?: string; mic: boolean; say: boolean; help: boolean } {
  const result: LabOptions & { wav?: string; mic: boolean; say: boolean; help: boolean } = {
    mic: false,
    say: false,
    help: false,
  };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (seen.has(arg)) throw new Error(`Duplicate argument: ${arg}`);
    seen.add(arg);
    if (arg === "--mic") {
      result.mic = true;
      continue;
    }
    if (arg === "--say") {
      result.say = true;
      continue;
    }
    if (!["--wav", "--state", "--variant", "--view"].includes(arg))
      throw new Error(`Unknown argument: ${arg}. Use --help.`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    if (arg === "--wav") result.wav = value;
    else if (arg === "--state") {
      const state = personaStates.find((state) => state === value);
      if (!state) throw new Error(`Unknown persona state: ${value}`);
      result.state = state;
    } else if (arg === "--variant") {
      const variant = variants.find((variant) => variant.id === value);
      if (!variant) throw new Error(`Unknown persona variant: ${value}`);
      result.variant = variant.id;
    } else {
      if (value !== "gallery" && value !== "card" && value !== "sizes")
        throw new Error(`Unknown view: ${value}`);
      result.view = value;
    }
  }
  if (result.wav && result.mic) throw new Error("Choose --wav or --mic, not both");
  if (result.say && (result.wav || result.mic))
    throw new Error("Choose --say, --wav, or --mic as one audio source");
  return result;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "The Persona lab needs an interactive terminal. Run bun run personas in a terminal.",
    );
  let source: AudioSource | undefined =
    options.mic || options.say
      ? undefined
      : options.wav
        ? new SpeechReplay(await loadWav(options.wav), `${basename(options.wav)} · silent replay`)
        : await demoSpeech();
  const theme = new FxTheme();
  const abort = new AbortController();
  let spoken: SpokenReplay | undefined;
  const terminalWrite = process.stdout.write.bind(process.stdout);
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    backgroundColor: RGBA.defaultBackground(),
    targetFps: 30,
    maxFps: 30,
    useMouse: true,
    exitOnCtrlC: true,
    consoleMode: "disabled",
    openConsoleOnError: false,
    prependInputHandlers: [theme.handle],
  });
  let initiallyFocused = true;
  const onBlur = () => {
    initiallyFocused = false;
  };
  const onFocus = () => {
    initiallyFocused = true;
  };
  const onQuit = (key: KeyEvent) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) renderer.destroy();
  };
  const stopPreparing = () => {
    renderer.off("blur", onBlur);
    renderer.off("focus", onFocus);
    renderer.keyInput.off("keypress", onQuit);
  };
  renderer.on("blur", onBlur);
  renderer.on("focus", onFocus);
  renderer.keyInput.on("keypress", onQuit);
  renderer.once("destroy", () => {
    abort.abort();
    theme.dispose();
  });
  try {
    await theme.start((sequence) => terminalWrite(sequence));
    if (renderer.isDestroyed) return;
    if (options.say) {
      const preparing = new TextRenderable(renderer, {
        content: "Preparing speech with say…  [q] Quit",
        fg: palette(theme.mode).secondary,
        position: "absolute",
        left: 2,
        top: 1,
      });
      renderer.root.add(preparing);
      spoken = await spokenDemo(abort.signal);
      preparing.destroy();
      source = spoken;
    }
    if (options.mic) {
      const { NativeDuplexDevice } = await import("../src/console/duplex-device.ts");
      if (renderer.isDestroyed) return;
      source = new MicrophoneSource(new NativeDuplexDevice());
    }
    if (!source || renderer.isDestroyed) return;
    const lab = new PersonaLab(renderer, source, {
      ...options,
      theme: theme.mode,
      initiallyFocused,
    });
    stopPreparing();
    theme.onChange = (mode) => lab.setTheme(mode);
    await lab.done;
  } catch (error) {
    if (!abort.signal.aborted) throw error;
  } finally {
    stopPreparing();
    try {
      source?.close();
      await spoken?.dispose();
    } finally {
      theme.dispose();
      renderer.destroy();
    }
  }
}

if (import.meta.main)
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
