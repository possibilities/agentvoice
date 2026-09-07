import {
  type CliRenderer,
  type OptimizedBuffer,
  Renderable,
  type RenderableOptions,
} from "@opentui/core";
import type { Raster } from "../waveforms/raster.ts";
import { palette, type ThemeMode } from "../waveforms/theme.ts";
import type { PersonaAudio } from "./audio.ts";
import { PersonaMotion, type PersonaState, type PersonaVariant, renderPersona } from "./visual.ts";

export type { AudioFrame, PersonaAudio } from "./audio.ts";
export { AudioAnalyzer } from "./audio.ts";
export type { PersonaState, PersonaVariant } from "./visual.ts";

export interface PersonaOptions extends RenderableOptions {
  state?: PersonaState;
  variant?: PersonaVariant;
  audio?: PersonaAudio;
  theme?: ThemeMode;
  paused?: boolean;
}

export function paintPersona(
  buffer: OptimizedBuffer,
  raster: Raster,
  x: number,
  y: number,
  colors: ReturnType<typeof palette>,
): void {
  for (let row = 0; row < raster.rows; row++)
    for (let column = 0; column < raster.columns; column++) {
      const cell = raster.cell(column, row);
      if (cell.char !== " ")
        buffer.setCell(x + column, y + row, cell.char, colors.ink[cell.ink]!, colors.background);
    }
}

/** Embeddable visual only: no keys, sources, device access, labels, or call ownership. */
export class Persona extends Renderable {
  readonly motion = new PersonaMotion();
  private colors: ReturnType<typeof palette>;
  private visual: PersonaVariant;
  private stopped: boolean;
  private blurred = false;

  constructor(
    private renderer: CliRenderer,
    options: PersonaOptions = {},
  ) {
    const {
      state = "idle",
      variant = "rose",
      audio = {},
      theme = "dark",
      paused = false,
      ...layout
    } = options;
    super(renderer, { width: 12, height: 4, ...layout });
    this.motion.state = state;
    this.motion.audio = audio;
    this.motion.settle();
    this.visual = variant;
    this.stopped = paused;
    this.colors = palette(theme);
    renderer.on("blur", this.onBlur);
    renderer.on("focus", this.onFocus);
    this.live = !paused;
  }

  get state(): PersonaState {
    return this.motion.state;
  }
  set state(value: PersonaState) {
    this.motion.state = value;
    if (this.stopped) this.motion.settle();
    this.requestRender();
  }
  get audio(): PersonaAudio {
    return this.motion.audio;
  }
  set audio(value: PersonaAudio) {
    this.motion.audio = value;
    if (this.stopped) this.motion.settle();
    this.requestRender();
  }
  get variant(): PersonaVariant {
    return this.visual;
  }
  set variant(value: PersonaVariant) {
    this.visual = value;
    this.requestRender();
  }
  get paused(): boolean {
    return this.stopped;
  }
  set paused(value: boolean) {
    this.stopped = value;
    this.live = !value && !this.blurred;
    this.requestRender();
  }
  setTheme(mode: ThemeMode): void {
    this.colors = palette(mode);
    this.requestRender();
  }

  private onBlur = (): void => {
    this.blurred = true;
    this.live = false;
  };
  private onFocus = (): void => {
    this.blurred = false;
    this.live = !this.stopped;
  };

  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    if (this.live) this.motion.advance(deltaTime / 1000);
    if (this.width < 1 || this.height < 1) return;
    buffer.fillRect(this.x, this.y, this.width, this.height, this.colors.background);
    const width = Math.min(240, this.width);
    const height = Math.min(100, this.height);
    paintPersona(
      buffer,
      renderPersona(this.motion, this.visual, width, height),
      this.x + Math.floor((this.width - width) / 2),
      this.y + Math.floor((this.height - height) / 2),
      this.colors,
    );
  }

  protected destroySelf(): void {
    this.live = false;
    this.renderer.off("blur", this.onBlur);
    this.renderer.off("focus", this.onFocus);
  }
}
