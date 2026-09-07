import {
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
  type OptimizedBuffer,
  Renderable,
  RGBA,
  TextAttributes,
} from "@opentui/core";
import { palette, type ThemeMode } from "../waveforms/theme.ts";
import { paintPersona } from "./persona.ts";
import type { AudioSource } from "./source.ts";
import {
  PersonaMotion,
  type PersonaState,
  type PersonaVariant,
  personaStates,
  renderPersona,
  stateGlyph,
  variants,
} from "./visual.ts";

type View = "gallery" | "card" | "sizes";
interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
  action: string;
}
interface Command {
  label: string;
  key: string;
  action: string;
}
export interface LabOptions {
  theme?: ThemeMode;
  animate?: boolean;
  initiallyFocused?: boolean;
  state?: PersonaState;
  variant?: PersonaVariant;
  view?: View;
}
const clean = (text: string) => text.replace(/\p{Cc}/gu, " ");

export class PersonaLab extends Renderable {
  readonly motion = new PersonaMotion();
  readonly done: Promise<void>;
  selected = 0;
  view: View;
  automatic: boolean;
  paused = false;
  commandsOpen = false;
  error = "";
  private filter = "";
  private commandIndex = 0;
  private colors: ReturnType<typeof palette>;
  private regions: Region[] = [];
  private regionsCurrent = false;
  private closed = false;
  private blurred = false;
  private columns = 1;
  private resolveDone: () => void;

  constructor(
    private renderer: CliRenderer,
    readonly source: AudioSource,
    private options: LabOptions = {},
  ) {
    super(renderer, { id: "persona-lab", width: "100%", height: "100%" });
    this.colors = palette(options.theme ?? "dark");
    this.blurred = options.initiallyFocused === false;
    this.selected = Math.max(
      0,
      variants.findIndex((variant) => variant.id === options.variant),
    );
    this.view = options.view ?? "gallery";
    this.automatic = options.state === undefined && source.cue !== undefined;
    this.motion.state =
      options.state ??
      (source.kind === "microphone" ? "listening" : (source.cue?.state ?? "speaking"));
    const completion = Promise.withResolvers<void>();
    this.done = completion.promise;
    this.resolveDone = completion.resolve;
    this.onMouseDown = this.mouse;
    this.onMouseScroll = this.mouse;
    renderer.keyInput.on("keypress", this.key);
    renderer.on("blur", this.onBlur);
    renderer.on("focus", this.onFocus);
    renderer.on("resize", this.invalidate);
    renderer.once("destroy", this.cleanup);
    renderer.root.add(this);
    this.syncAudio();
    this.motion.settle();
    this.updateRunning();
  }

  setTheme(mode: ThemeMode): void {
    this.colors = palette(mode);
    this.invalidate();
  }
  private invalidate = (): void => {
    this.regionsCurrent = false;
    this.requestRender();
  };
  private onBlur = (): void => {
    this.blurred = true;
    this.updateRunning();
  };
  private onFocus = (): void => {
    this.blurred = false;
    this.updateRunning();
  };

  private fail(error: unknown): void {
    this.error = clean(error instanceof Error ? error.message : String(error));
    this.live = false;
    this.motion.audio = {};
    try {
      this.source.close();
    } catch {
      /* Preserve the first device failure. */
    }
    this.invalidate();
  }
  private updateRunning(): void {
    const running =
      this.options.animate !== false &&
      !this.closed &&
      !this.blurred &&
      !this.paused &&
      !this.commandsOpen &&
      !this.error;
    this.live = running;
    try {
      this.source.setRunning(running);
    } catch (error) {
      this.fail(error);
    }
    this.invalidate();
  }
  close = (): void => {
    if (!this.closed) {
      this.cleanup();
      this.renderer.destroy();
    }
  };
  private cleanup = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.live = false;
    this.renderer.keyInput.off("keypress", this.key);
    this.renderer.off("blur", this.onBlur);
    this.renderer.off("focus", this.onFocus);
    this.renderer.off("resize", this.invalidate);
    this.renderer.off("destroy", this.cleanup);
    try {
      this.source.close();
    } catch (error) {
      this.error = clean(error instanceof Error ? error.message : String(error));
    } finally {
      this.resolveDone();
    }
  };

  private commands(): Command[] {
    return [
      { label: this.paused ? "Resume" : "Pause", key: "space", action: "pause" },
      { label: "Waveform gallery", key: "esc", action: "view:gallery" },
      { label: "Voice card", key: "enter", action: "view:card" },
      { label: "Compare sizes", key: "v", action: "view:sizes" },
      ...personaStates.map((state, i) => ({
        label: `State: ${state}`,
        key: `${i + 1}`,
        action: `state:${state}`,
      })),
      ...(this.source.cue ? [{ label: "Demo conversation cycle", key: "a", action: "auto" }] : []),
      ...(this.source.kind === "replay"
        ? [
            { label: "Replay from beginning", key: "r", action: "replay" },
            { label: "Seek back two seconds", key: "[", action: "seek:-2" },
            { label: "Seek forward two seconds", key: "]", action: "seek:2" },
          ]
        : []),
      { label: "Next variation", key: "right", action: "next:1" },
      { label: "Previous variation", key: "left", action: "next:-1" },
      ...variants.map((v, i) => ({ label: v.name, key: "", action: `variant:${i}` })),
      { label: "Quit", key: "q", action: "quit" },
    ];
  }
  private filtered(): Command[] {
    return this.commands().filter((command) =>
      command.label.toLowerCase().includes(this.filter.toLowerCase().trim()),
    );
  }

  private act(action: string): void {
    if (this.closed || action === "noop") return;
    if (action === "quit") {
      this.close();
      return;
    }
    if (action === "commands") {
      this.commandsOpen = !this.commandsOpen;
      this.filter = "";
      this.commandIndex = 0;
    } else {
      this.commandsOpen = false;
      if (action === "pause") this.paused = !this.paused;
      else if (action === "auto" && this.source.cue) this.automatic = true;
      else if (action === "replay") {
        this.seekSource(0);
        this.clearAudio();
      } else if (action.startsWith("seek:")) {
        this.seekSource(this.source.position + Number(action.slice(5)));
        this.clearAudio();
      } else if (action.startsWith("state:")) {
        this.automatic = false;
        this.motion.state = action.slice(6) as PersonaState;
      } else if (action.startsWith("view:")) this.view = action.slice(5) as View;
      else if (action.startsWith("variant:")) {
        this.selected = Number(action.slice(8));
        this.view = "card";
      } else if (action.startsWith("next:"))
        this.selected =
          (this.selected + Number(action.slice(5)) + variants.length) % variants.length;
    }
    this.syncAudio();
    if (this.paused || this.options.animate === false) this.motion.settle();
    this.updateRunning();
  }

  private clearAudio(): void {
    this.motion.resetAudio();
  }
  private seekSource(seconds: number): void {
    try {
      this.source.seek(seconds);
    } catch (error) {
      this.fail(error);
    }
  }
  private syncAudio(): void {
    if (this.automatic && this.source.cue) this.motion.state = this.source.cue.state;
    this.motion.audio = this.error
      ? {}
      : {
          input:
            this.source.kind === "microphone" || this.motion.state === "listening"
              ? this.source.frame
              : undefined,
          output:
            this.source.kind === "replay" && this.motion.state === "speaking"
              ? this.source.frame
              : undefined,
        };
  }

  private key = (key: KeyEvent): void => {
    if (this.closed || key.eventType === "release") return;
    if (key.ctrl && key.name === "c") {
      this.close();
      return;
    }
    if (key.ctrl && key.name === "k") {
      this.act("commands");
      return;
    }
    if (key.ctrl || key.meta || key.option || key.super) return;
    if (this.commandsOpen) {
      if (key.name === "escape") this.act("commands");
      else if (key.name === "backspace") {
        this.filter = this.filter.slice(0, -1);
        this.commandIndex = 0;
      } else if (key.name === "up" || key.name === "down") {
        const count = this.filtered().length;
        this.commandIndex = count
          ? (this.commandIndex + (key.name === "up" ? -1 : 1) + count) % count
          : 0;
      } else if (key.name === "return" || key.name === "enter") {
        const command = this.filtered()[this.commandIndex];
        if (command) this.act(command.action);
      } else if (key.sequence.length === 1 && key.sequence >= " " && this.filter.length < 64) {
        this.filter += key.sequence;
        this.commandIndex = 0;
      }
      this.invalidate();
      return;
    }
    const keys: Record<string, string> = {
      q: "quit",
      "?": "commands",
      space: "pause",
      " ": "pause",
      return: "view:card",
      enter: "view:card",
      escape: "view:gallery",
      v: this.view === "sizes" ? "view:card" : "view:sizes",
      a: "auto",
      r: "replay",
      "[": "seek:-2",
      "]": "seek:2",
      right: "next:1",
      l: "next:1",
      left: "next:-1",
      h: "next:-1",
      down: `next:${this.columns}`,
      j: `next:${this.columns}`,
      up: `next:${-this.columns}`,
      k: `next:${-this.columns}`,
    };
    const number = Number(key.name);
    if (number >= 1 && number <= 5) this.act(`state:${personaStates[number - 1]}`);
    else if (keys[key.name]) this.act(keys[key.name]!);
  };
  private mouse = (event: MouseEvent): void => {
    if (!this.regionsCurrent || this.closed) return;
    const region = this.regions.findLast(
      (region) =>
        event.x - this.x >= region.x &&
        event.x - this.x < region.x + region.width &&
        event.y - this.y >= region.y &&
        event.y - this.y < region.y + region.height,
    );
    if (event.type === "scroll") {
      if (event.scroll?.direction === "up" || event.scroll?.direction === "down") {
        const direction = event.scroll.direction === "up" ? -1 : 1;
        if (this.commandsOpen) {
          const count = this.filtered().length;
          this.commandIndex = count ? (this.commandIndex + direction + count) % count : 0;
          this.invalidate();
        } else this.act(`next:${direction}`);
      }
    } else if (event.button === 0 && region) this.act(region.action);
    event.stopPropagation();
  };

  private text(
    buffer: OptimizedBuffer,
    text: string,
    x: number,
    y: number,
    color = this.colors.primary,
    width = this.width - x,
    bold = false,
    background = this.colors.background,
  ): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    buffer.drawText(
      [...clean(text)].slice(0, Math.max(0, Math.min(width, this.width - x))).join(""),
      this.x + x,
      this.y + y,
      color,
      background,
      bold ? TextAttributes.BOLD : 0,
    );
  }
  private button(
    buffer: OptimizedBuffer,
    label: string,
    action: string,
    x: number,
    y: number,
    selected = false,
  ): void {
    const content = `[${label}]`;
    if (x + content.length > this.width || y < 0 || y >= this.height) return;
    this.text(
      buffer,
      content,
      x,
      y,
      selected ? this.colors.primary : this.colors.secondary,
      content.length,
      selected,
      selected ? this.colors.surface : this.colors.background,
    );
    this.regions.push({ x, y, width: content.length, height: 1, action });
  }
  private plot(
    buffer: OptimizedBuffer,
    variant: PersonaVariant,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    width = Math.min(240, this.width - x, width);
    height = Math.min(100, this.height - y, height);
    if (width < 1 || height < 1) return;
    paintPersona(
      buffer,
      renderPersona(this.motion, variant, width, height),
      this.x + x,
      this.y + y,
      this.colors,
    );
  }
  private toolbar(): Array<{ label: string; action: string; x: number; row: number }> {
    const items = [
      ["Prev", "next:-1"],
      ["Next", "next:1"],
      [
        this.view === "gallery" ? "Card" : "Gallery",
        this.view === "gallery" ? "view:card" : "view:gallery",
      ],
      ["Sizes", "view:sizes"],
      [this.paused ? "Resume" : "Pause", "pause"],
      ["Commands", "commands"],
      ["Quit", "quit"],
    ];
    let x = 2;
    let row = 0;
    return items.map(([label, action]) => {
      if (x + label!.length + 2 > this.width - 2) {
        x = 2;
        row++;
      }
      const item = { label: label!, action: action!, x, row };
      x += label!.length + 3;
      return item;
    });
  }

  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    if (this.live) {
      const dt = Math.max(0, Math.min(0.1, deltaTime / 1000));
      try {
        this.source.advance(dt);
      } catch (error) {
        this.fail(error);
      }
      this.syncAudio();
      this.motion.advance(dt);
    }
    this.regions = [];
    this.regionsCurrent = true;
    buffer.fillRect(this.x, this.y, this.width, this.height, this.colors.background);
    if (this.width < 1 || this.height < 1) return;
    const variant = variants[this.selected]!;
    const state = this.motion.state;
    if (this.width < 32 || this.height < 10) {
      if (this.height >= 4) {
        this.text(
          buffer,
          `${stateGlyph[state]} ${this.error ? "error" : state}`,
          0,
          0,
          this.colors.primary,
          this.width - 4,
        );
        this.button(buffer, "×", "quit", this.width - 3, 0);
        this.plot(buffer, variant.id, 0, 1, this.width, this.height - 1);
      } else {
        this.text(buffer, this.error ? "×" : stateGlyph[state], 0, 0);
        this.plot(buffer, variant.id, 2, 0, this.width - 2, this.height);
      }
      this.regions.push({
        x: 0,
        y: this.height >= 4 ? 1 : 0,
        width: this.width,
        height: this.height >= 4 ? this.height - 1 : this.height,
        action: "next:1",
      });
      if (this.commandsOpen) this.drawCommands(buffer);
      return;
    }
    const toolbar = this.toolbar();
    const bottom = this.height - 2 - toolbar.at(-1)!.row;
    const showStates = this.width >= 62 && this.height >= 17;
    const bodyY = showStates ? 7 : 4;
    const bodyHeight = Math.max(1, bottom - bodyY - 1);
    this.text(
      buffer,
      this.view === "gallery" ? "Persona lab" : variant.name,
      2,
      1,
      this.colors.primary,
      this.width - 20,
      true,
    );
    this.text(
      buffer,
      `${stateGlyph[state]} ${state}`,
      this.width - 15,
      1,
      this.colors.primary,
      13,
      true,
    );
    const sourceLabel = this.error
      ? `Source stopped · ${this.error}`
      : `${this.source.label} · ${this.source.position.toFixed(1)}${this.source.duration ? ` / ${this.source.duration.toFixed(1)}` : ""}s${this.paused ? " · paused" : ""}`;
    this.text(buffer, sourceLabel, 2, 2, this.colors.dim, this.width - 4);
    if (showStates) {
      let x = 2;
      for (const name of personaStates) {
        this.button(buffer, name, `state:${name}`, x, 4, !this.automatic && state === name);
        x += name.length + 3;
      }
      if (this.source.cue) this.button(buffer, "Auto", "auto", x, 4, this.automatic);
      if (this.source.kind === "replay") {
        this.button(buffer, "−2s", "seek:-2", 2, 5);
        this.button(buffer, "Replay", "replay", 8, 5);
        this.button(buffer, "+2s", "seek:2", 17, 5);
        this.text(
          buffer,
          this.automatic ? "demo conversation" : "manual state",
          24,
          5,
          this.colors.dim,
        );
      } else
        this.text(
          buffer,
          "Capture pauses on blur, pause, or commands",
          2,
          5,
          this.colors.dim,
          this.width - 4,
        );
    }
    if (this.view === "gallery") this.drawGallery(buffer, bodyY, bodyHeight);
    else if (this.view === "sizes") this.drawSizes(buffer, bodyY, bodyHeight);
    else this.drawCard(buffer, bodyY, bodyHeight);
    for (const item of toolbar)
      this.button(buffer, item.label, item.action, item.x, bottom + item.row);
    if (this.commandsOpen) this.drawCommands(buffer);
  }

  private drawGallery(buffer: OptimizedBuffer, y: number, height: number): void {
    this.columns = this.width >= 132 ? 4 : this.width >= 104 ? 3 : this.width >= 68 ? 2 : 1;
    const rows = Math.max(
      1,
      Math.min(Math.ceil(variants.length / this.columns), Math.floor(height / 7)),
    );
    const capacity = rows * this.columns;
    const first = Math.floor(this.selected / capacity) * capacity;
    const width = Math.floor((this.width - 4) / this.columns);
    const tileHeight = Math.floor(height / rows);
    for (let i = first; i < Math.min(variants.length, first + capacity); i++) {
      const x = 2 + ((i - first) % this.columns) * width;
      const top = y + Math.floor((i - first) / this.columns) * tileHeight;
      const selected = i === this.selected;
      this.text(
        buffer,
        `${selected ? "┃" : " "} ${variants[i]!.name}`,
        x,
        top,
        selected ? this.colors.primary : this.colors.secondary,
        width - 2,
        selected,
        selected ? this.colors.surface : this.colors.background,
      );
      this.plot(buffer, variants[i]!.id, x, top + 1, width - 2, Math.max(1, tileHeight - 2));
      this.regions.push({
        x,
        y: top,
        width: width - 2,
        height: tileHeight - 1,
        action: `variant:${i}`,
      });
    }
  }

  private drawCard(buffer: OptimizedBuffer, y: number, height: number): void {
    const variant = variants[this.selected]!;
    const sidebar = this.width >= 96 && height >= 13;
    const plotWidth = sidebar ? this.width - 38 : this.width - 4;
    const captionRows = !sidebar && height >= 9 ? 3 : 0;
    this.plot(buffer, variant.id, 2, y, plotWidth, height - captionRows);
    const x = sidebar ? this.width - 32 : 2;
    const top = sidebar ? y + 1 : y + height - captionRows;
    if (sidebar || captionRows) {
      const speaker = this.motion.state === "listening" ? "YOU" : "AGENT";
      this.text(
        buffer,
        `${speaker} · ${this.motion.state}`,
        x,
        top,
        this.colors.primary,
        sidebar ? 30 : this.width - 4,
        true,
      );
      const caption = this.automatic ? (this.source.cue?.text ?? "") : variant.detail;
      this.wrap(buffer, caption, x, top + 2, sidebar ? 29 : this.width - 4, sidebar ? 4 : 1);
    }
    if (sidebar) {
      this.text(buffer, "12 × 4", x, y + 8, this.colors.dim);
      this.plot(buffer, variant.id, x + 7, y + 8, 12, 4);
      if (height >= 16) {
        this.text(buffer, "24 × 1", x, y + 13, this.colors.dim);
        this.plot(buffer, variant.id, x, y + 14, 24, 1);
      }
    }
  }

  private drawSizes(buffer: OptimizedBuffer, y: number, height: number): void {
    const id = variants[this.selected]!.id;
    if (height < 7) {
      this.text(buffer, "24 × 1 · strip", 2, y, this.colors.dim);
      this.plot(buffer, id, 2, y + 2, Math.min(24, this.width - 4), 1);
      return;
    }
    this.text(buffer, "12 × 4 · widget", 2, y, this.colors.dim);
    this.plot(buffer, id, 8, y + 1, 12, 4);
    this.text(buffer, "24 × 1 · strip", 2, y + 6, this.colors.dim);
    if (height >= 8) this.plot(buffer, id, 2, y + 7, 24, 1);
    if (this.width >= 70) {
      const width = Math.min(240, this.width - 34);
      const rows = Math.min(100, height - 2);
      this.text(buffer, `${width} × ${rows} · pane`, 32, y, this.colors.dim);
      this.plot(buffer, id, 32, y + 2, width, rows);
    } else if (height >= 15) {
      this.text(buffer, `${this.width - 4} × ${height - 12} · pane`, 2, y + 10, this.colors.dim);
      this.plot(buffer, id, 2, y + 12, this.width - 4, height - 12);
    }
  }
  private wrap(
    buffer: OptimizedBuffer,
    text: string,
    x: number,
    y: number,
    width: number,
    rows: number,
  ): void {
    let line = "";
    let row = 0;
    for (const word of text.split(" ")) {
      if (line.length + word.length + 1 > width) {
        this.text(buffer, line, x, y + row++, this.colors.secondary, width);
        line = "";
        if (row >= rows) return;
      }
      line += `${line ? " " : ""}${word}`;
    }
    if (row < rows) this.text(buffer, line, x, y + row, this.colors.secondary, width);
  }

  private drawCommands(buffer: OptimizedBuffer): void {
    const commands = this.filtered();
    const width = Math.min(62, this.width);
    const height = Math.min(20, this.height);
    const x = Math.floor((this.width - width) / 2);
    const y = Math.floor((this.height - height) / 2);
    this.regions = [{ x: 0, y: 0, width: this.width, height: this.height, action: "commands" }];
    this.regions.push({ x, y, width, height, action: "noop" });
    buffer.fillRect(this.x, this.y, this.width, this.height, RGBA.fromHex("#00000033"));
    if (height < 3 || width < 4) {
      this.text(buffer, "Esc", x, y, this.colors.primary, width);
      return;
    }
    buffer.drawBox({
      x: this.x + x,
      y: this.y + y,
      width,
      height,
      border: true,
      borderStyle: "single",
      borderColor: this.colors.focus,
      backgroundColor: this.colors.background,
      shouldFill: true,
      title: width >= 14 ? " commands " : undefined,
      titleColor: this.colors.primary,
    });
    if (height < 5 || width < 16) {
      this.text(buffer, "Esc closes", x + 1, y + 1, this.colors.dim, width - 2);
      return;
    }
    this.text(
      buffer,
      `❯ ${this.filter || "type to filter"}`,
      x + 2,
      y + 1,
      this.filter ? this.colors.primary : this.colors.dim,
      width - 4,
    );
    const visible = height - 5;
    const first = Math.max(
      0,
      Math.min(this.commandIndex - Math.floor(visible / 2), commands.length - visible),
    );
    if (!commands.length)
      this.text(buffer, "No matching commands", x + 2, y + 3, this.colors.dim, width - 4);
    for (let row = 0; row < visible && first + row < commands.length; row++) {
      const index = first + row;
      const command = commands[index]!;
      this.text(
        buffer,
        index === this.commandIndex ? "▎" : " ",
        x + 2,
        y + 3 + row,
        this.colors.focus,
        1,
      );
      this.text(
        buffer,
        command.label,
        x + 4,
        y + 3 + row,
        this.colors.primary,
        width - 16,
        index === this.commandIndex,
      );
      this.text(buffer, command.key, x + width - 10, y + 3 + row, this.colors.dim, 8);
      this.regions.push({
        x: x + 1,
        y: y + 3 + row,
        width: width - 2,
        height: 1,
        action: command.action,
      });
    }
    this.text(
      buffer,
      `${commands.length ? this.commandIndex + 1 : 0}/${commands.length}`,
      x + 2,
      y + height - 2,
      this.colors.dim,
      width - 13,
    );
    this.button(buffer, "Close", "commands", x + width - 9, y + height - 2);
  }
}
