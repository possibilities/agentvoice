#!/usr/bin/env bun
import { createCliRenderer, RGBA } from "@opentui/core";
import { WaveformGallery } from "./waveforms/app.ts";
import { FxTheme } from "./waveforms/theme.ts";

const usage = `Waveform gallery — twelve synthetic studies in OpenTUI.

  bun run waveforms

Arrows or h/j/k/l select a study; Enter expands it; Esc returns.
Space pauses. [ / ] change speed; - / + amplitude; , / . frequency.
0 resets parameters and time. Ctrl+K or ? opens commands. Q quits.
Click a waveform to expand it; every control also accepts clicks.
Wheel over a parameter to adjust it, or elsewhere to change studies.

FX_THEME=dark|light overrides terminal theme detection.
This gallery generates signals locally; it does not open audio or Codex.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length) {
    if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
      process.stdout.write(usage);
      return;
    }
    throw new Error("Unknown argument. Run bun run waveforms --help for usage.");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "The waveform gallery needs an interactive terminal. Run bun run waveforms in a terminal.",
    );
  const theme = new FxTheme();
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
  renderer.once("destroy", () => theme.dispose());
  try {
    // Initialization resolves the fixed ramp before the first content frame.
    await theme.start((sequence) => terminalWrite(sequence));
    if (renderer.isDestroyed) return;
    const gallery = new WaveformGallery(renderer, { theme: theme.mode });
    theme.onChange = (mode) => gallery.setTheme(mode);
    await gallery.done;
  } finally {
    theme.dispose();
    renderer.destroy();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
