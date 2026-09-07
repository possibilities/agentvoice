import { RGBA } from "@opentui/core";

export type ThemeMode = "dark" | "light";

// Fixed indexed roles from ~/code/fxnk/style/STYLE.md and style/tokens.json.
export function palette(mode: ThemeMode) {
  const steps = mode === "dark" ? [240, 245, 250, 252, 255] : [250, 247, 241, 238, 235];
  return {
    background: RGBA.defaultBackground(),
    primary: RGBA.fromIndex(steps[4]!),
    secondary: RGBA.fromIndex(steps[2]!),
    dim: RGBA.fromIndex(steps[1]!),
    divider: RGBA.fromIndex(steps[0]!),
    surface: RGBA.fromIndex(mode === "dark" ? 236 : 254),
    focus: RGBA.fromIndex(4),
    ink: [RGBA.defaultBackground(), ...steps.map((step) => RGBA.fromIndex(step))],
  };
}

export function backgroundMode(sequence: string): ThemeMode | undefined {
  if (!sequence.startsWith("\x1b]11;rgb:")) return;
  const end = sequence.endsWith("\x07") ? -1 : sequence.endsWith("\x1b\\") ? -2 : 0;
  if (!end) return;
  const match = /^([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})$/i.exec(sequence.slice(9, end));
  if (!match) return;
  const rgb = match.slice(1, 4).map((part) => {
    const c = Number.parseInt(part!, 16) / (16 ** part!.length - 1);
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722 > 0.5 ? "light" : "dark";
}

/** Own only the mode query. Toolkit palette samples never select fxnk colors. */
export class FxTheme {
  mode: ThemeMode;
  private explicit: boolean;
  private phase: "idle" | "initial" | "fence" | "sample" = "idle";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private resolveInitial: (() => void) | undefined;
  private write: (sequence: string) => void = () => {};
  private pendingFences = 0;
  private disposed = false;
  onChange: (mode: ThemeMode) => void = () => {};

  constructor(env: Record<string, string | undefined> = process.env) {
    const explicit = env["FX_THEME"]?.toLowerCase();
    this.explicit = explicit === "dark" || explicit === "light";
    const background = Number(env["COLORFGBG"]?.split(";").at(-1));
    this.mode = this.explicit
      ? (explicit as ThemeMode)
      : Number.isFinite(background) && background >= 7 && background <= 15
        ? "light"
        : "dark";
  }

  async start(write: (sequence: string) => void): Promise<void> {
    if (this.disposed) return;
    this.write = write;
    write("\x1b[?2031h");
    if (this.explicit) return;
    this.phase = "initial";
    await new Promise<void>((resolve) => {
      this.resolveInitial = resolve;
      this.deadline();
      write("\x1b]11;?\x1b\\");
    });
  }

  private deadline(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.finish(), 200);
  }

  private finish(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.phase = "idle";
    this.resolveInitial?.();
    this.resolveInitial = undefined;
  }

  handle = (sequence: string): boolean => {
    if (this.disposed) return false;
    if (sequence === "\x1b[?997;1n" || sequence === "\x1b[?997;2n") {
      if (!this.explicit && this.phase !== "initial") {
        this.phase = "fence";
        this.pendingFences++;
        this.deadline();
        this.write("\x1b[c");
      }
      return true;
    }
    if (
      sequence.startsWith("\x1b") &&
      /^\[\?[\d;]*c$/.test(sequence.slice(1)) &&
      this.pendingFences > 0
    ) {
      this.pendingFences--;
      if (!this.pendingFences && this.phase === "fence") {
        this.phase = "sample";
        this.deadline();
        this.write("\x1b]11;?\x1b\\");
      }
      return false; // Native capability discovery also owns DA1 replies.
    }
    if (sequence.startsWith("\x1b]11;")) {
      const next = backgroundMode(sequence);
      if (next && (this.phase === "initial" || this.phase === "sample")) {
        const changed = next !== this.mode;
        this.mode = next;
        this.finish();
        if (changed) this.onChange(next);
      }
      return true; // Timed-out or explicit-mode replies must never become input.
    }
    return false;
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.finish();
    this.write("\x1b[?2031l");
  }
}
