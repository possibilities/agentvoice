import {
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
  type OptimizedBuffer,
  Renderable,
  RGBA,
  TextAttributes,
} from "@opentui/core";
import { defaults, limits, type Parameters, renderStudy, studies } from "./studies.ts";
import { palette, type ThemeMode } from "./theme.ts";

const scrim = RGBA.fromHex("#00000033");

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

export interface GalleryState {
  selected: number;
  expanded: boolean;
  paused: boolean;
  time: number;
  parameters: Parameters;
  commandsOpen: boolean;
  filter: string;
  commandIndex: number;
}

export class WaveformGallery extends Renderable {
  readonly state: GalleryState = {
    selected: 0,
    expanded: false,
    paused: false,
    time: 0,
    parameters: defaults(),
    commandsOpen: false,
    filter: "",
    commandIndex: 0,
  };
  readonly done: Promise<void>;
  private resolveDone: () => void;
  private colors: ReturnType<typeof palette>;
  private regions: Region[] = [];
  private regionsCurrent = false;
  private columns = 3;
  private blurred = false;
  private closed = false;

  constructor(
    private renderer: CliRenderer,
    private options: { theme?: ThemeMode; animate?: boolean } = {},
  ) {
    super(renderer, { id: "waveform-gallery", width: "100%", height: "100%" });
    this.colors = palette(options.theme ?? "dark");
    const completion = Promise.withResolvers<void>();
    this.done = completion.promise;
    this.resolveDone = completion.resolve;
    this.onMouseDown = (event) => this.mouse(event);
    this.onMouseScroll = (event) => this.mouse(event);
    renderer.keyInput.on("keypress", this.key);
    renderer.on("blur", this.blurAnimation);
    renderer.on("focus", this.focusAnimation);
    renderer.on("resize", this.invalidate);
    renderer.once("destroy", this.cleanup);
    renderer.root.add(this);
    this.updateAnimation();
  }

  setTheme(mode: ThemeMode): void {
    this.colors = palette(mode);
    this.invalidate();
  }

  private invalidate = (): void => {
    this.regionsCurrent = false;
    this.requestRender();
  };

  private blurAnimation = () => {
    this.blurred = true;
    this.updateAnimation();
  };
  private focusAnimation = () => {
    this.blurred = false;
    this.updateAnimation();
  };

  private updateAnimation(): void {
    this.live =
      this.options.animate !== false &&
      !this.closed &&
      !this.blurred &&
      !this.state.paused &&
      !this.state.commandsOpen;
    this.invalidate();
  }

  close = (): void => {
    if (this.closed) return;
    this.cleanup();
    this.renderer.destroy();
  };

  private cleanup = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.live = false;
    this.renderer.keyInput.off("keypress", this.key);
    this.renderer.off("blur", this.blurAnimation);
    this.renderer.off("focus", this.focusAnimation);
    this.renderer.off("resize", this.invalidate);
    this.renderer.off("destroy", this.cleanup);
    this.resolveDone();
  };

  private commands(): Command[] {
    return [
      {
        label: this.state.paused ? "Play animation" : "Pause animation",
        key: "space",
        action: "pause",
      },
      {
        label: this.state.expanded ? "Return to gallery" : "Expand selected waveform",
        key: "enter",
        action: "view",
      },
      { label: "Next waveform", key: "right", action: "next" },
      { label: "Previous waveform", key: "left", action: "previous" },
      { label: "Increase speed", key: "]", action: "speed:+" },
      { label: "Decrease speed", key: "[", action: "speed:-" },
      { label: "Increase amplitude", key: "+", action: "amplitude:+" },
      { label: "Decrease amplitude", key: "-", action: "amplitude:-" },
      { label: "Increase frequency", key: ".", action: "frequency:+" },
      { label: "Decrease frequency", key: ",", action: "frequency:-" },
      { label: "Reset parameters and time", key: "0", action: "reset" },
      ...studies.map((study, i) => ({
        label: `Open ${study.name}`,
        key: "",
        action: `study:${i}`,
      })),
      { label: "Quit", key: "q", action: "quit" },
    ];
  }

  private filteredCommands(): Command[] {
    const query = this.state.filter.trim().toLowerCase();
    return this.commands().filter((command) =>
      `${command.label} ${command.key}`.toLowerCase().includes(query),
    );
  }

  private move(amount: number): void {
    this.state.selected = (this.state.selected + amount + studies.length) % studies.length;
  }

  private act(action: string): void {
    if (action === "noop") return;
    if (action === "quit") {
      this.close();
      return;
    }
    const s = this.state;
    if (action === "commands") {
      s.commandsOpen = !s.commandsOpen;
      s.filter = "";
      s.commandIndex = 0;
    } else {
      s.commandsOpen = false;
      if (action === "pause") s.paused = !s.paused;
      else if (action === "view") s.expanded = !s.expanded;
      else if (action === "next") this.move(1);
      else if (action === "previous") this.move(-1);
      else if (action === "reset") {
        s.parameters = defaults();
        s.time = 0;
      } else if (action.startsWith("study:")) {
        s.selected = Number(action.slice(6));
        s.expanded = true;
      } else {
        const [name, direction] = action.split(":") as [keyof Parameters, string];
        if (Object.hasOwn(limits, name)) {
          const [min, max, step] = limits[name];
          s.parameters[name] = Math.max(
            min,
            Math.min(max, s.parameters[name] + (direction === "+" ? step : -step)),
          );
        }
      }
    }
    this.updateAnimation();
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
    const s = this.state;
    if (s.commandsOpen) {
      if (key.name === "escape") this.act("commands");
      else if (key.name === "backspace") {
        s.filter = s.filter.slice(0, -1);
        s.commandIndex = 0;
      } else if (key.name === "up" || key.name === "down") {
        const count = this.filteredCommands().length;
        s.commandIndex = count
          ? (s.commandIndex + (key.name === "up" ? -1 : 1) + count) % count
          : 0;
      } else if (key.name === "return" || key.name === "enter") {
        const command = this.filteredCommands()[s.commandIndex];
        if (command) this.act(command.action);
      } else if (key.sequence.length === 1 && key.sequence >= " " && s.filter.length < 64) {
        s.filter += key.sequence;
        s.commandIndex = 0;
      }
      this.invalidate();
      return;
    }
    const action: Record<string, string> = {
      q: "quit",
      space: "pause",
      " ": "pause",
      return: "view",
      enter: "view",
      "?": "commands",
      right: "next",
      l: "next",
      left: "previous",
      h: "previous",
      "0": "reset",
      "]": "speed:+",
      "[": "speed:-",
      "+": "amplitude:+",
      "=": "amplitude:+",
      "-": "amplitude:-",
      ".": "frequency:+",
      ",": "frequency:-",
    };
    const selected = action[key.sequence] ?? action[key.name];
    if (selected) this.act(selected);
    else if (["up", "k", "down", "j"].includes(key.name)) {
      this.move((key.name === "up" || key.name === "k" ? -1 : 1) * (s.expanded ? 1 : this.columns));
      this.invalidate();
    } else if (key.name === "escape" && s.expanded) this.act("view");
  };

  private mouse(event: MouseEvent): void {
    // A keyboard transition can precede the next paint: old targets no longer own input.
    if (this.closed || !this.regionsCurrent) return;
    const region = this.regions.findLast(
      (r) =>
        event.x - this.x >= r.x &&
        event.x - this.x < r.x + r.width &&
        event.y - this.y >= r.y &&
        event.y - this.y < r.y + r.height,
    );
    if (event.type === "scroll") {
      const direction = event.scroll?.direction;
      if (direction !== "up" && direction !== "down") return;
      if (this.state.commandsOpen) {
        const count = this.filteredCommands().length;
        if (count)
          this.state.commandIndex =
            (this.state.commandIndex + (direction === "up" ? -1 : 1) + count) % count;
        this.invalidate();
      } else if (region?.action.includes(":") && !region.action.startsWith("study:")) {
        this.act(`${region.action.split(":")[0]}:${direction === "up" ? "+" : "-"}`);
      } else this.act(direction === "up" ? "previous" : "next");
    } else if (event.button === 0) {
      if (region) this.act(region.action);
      else if (this.state.commandsOpen) this.act("commands");
    }
    event.stopPropagation();
  }

  private text(
    buffer: OptimizedBuffer,
    text: string,
    x: number,
    y: number,
    color: RGBA,
    max = this.width - x,
    attributes = 0,
    background = this.colors.background,
  ): void {
    if (y < 0 || y >= this.height || x < 0 || x >= this.width) return;
    buffer.drawText(
      [...text].slice(0, Math.max(0, Math.min(max, this.width - x))).join(""),
      this.x + x,
      this.y + y,
      color,
      background,
      attributes,
    );
  }

  private button(
    buffer: OptimizedBuffer,
    label: string,
    x: number,
    y: number,
    action: string,
  ): void {
    const content = `[${label}]`;
    this.text(buffer, content, x, y, this.colors.secondary);
    this.regions.push({ x, y, width: content.length, height: 1, action });
  }

  private toolbar(): Array<{ label: string; action: string; x: number; row: number }> {
    const s = this.state;
    const items = [
      ["Prev", "previous"],
      ["Next", "next"],
      [s.expanded ? "Gallery" : "Expand", "view"],
      [s.paused ? "Play" : "Pause", "pause"],
      ["Reset", "reset"],
      ["Commands", "commands"],
      ["Quit", "quit"],
    ];
    let x = 2;
    let row = 0;
    return items.map(([label, action]) => {
      const width = label!.length + 2;
      if (x + width > this.width - 2) {
        x = 2;
        row++;
      }
      const item = { label: label!, action: action!, x, row };
      x += width + 1;
      return item;
    });
  }

  private plot(
    buffer: OptimizedBuffer,
    study: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    if (width < 1 || height < 1) return;
    const columns = Math.min(240, width);
    const rows = Math.min(100, height);
    const raster = renderStudy(study, columns, rows, this.state.time, this.state.parameters);
    const left = this.x + x + Math.floor((width - columns) / 2);
    const top = this.y + y + Math.floor((height - rows) / 2);
    for (let row = 0; row < rows; row++)
      for (let column = 0; column < columns; column++) {
        const cell = raster.cell(column, row);
        if (cell.char !== " ")
          buffer.setCell(
            left + column,
            top + row,
            cell.char,
            this.colors.ink[cell.ink]!,
            this.colors.ink[cell.lower]!,
          );
      }
  }

  protected renderSelf(buffer: OptimizedBuffer, deltaTime: number): void {
    if (this.live)
      this.state.time +=
        (Math.max(0, Math.min(100, deltaTime)) / 1000) * this.state.parameters.speed;
    this.regions = [];
    this.regionsCurrent = true;
    buffer.fillRect(this.x, this.y, this.width, this.height, this.colors.background);
    if (this.width < 32 || this.height < 12) {
      this.text(buffer, "Enlarge to 32 × 12", 0, 0, this.colors.primary);
      if (this.height > 1) this.button(buffer, "Quit", 0, this.height - 1, "quit");
      return;
    }
    const toolbar = this.toolbar();
    const toolbarY = this.height - 2 - toolbar.at(-1)!.row;
    const bodyHeight = toolbarY - 5;
    const s = this.state;
    this.text(
      buffer,
      s.expanded ? studies[s.selected]!.name : "Waveforms",
      2,
      1,
      this.colors.primary,
      this.width - 14,
      TextAttributes.BOLD,
    );
    if (s.paused) this.text(buffer, "paused", this.width - 8, 1, this.colors.dim);
    if (s.expanded) {
      this.text(buffer, studies[s.selected]!.description, 2, 2, this.colors.dim, this.width - 4);
      const desiredControlRows = this.width >= 80 ? 1 : 3;
      const controlRows = bodyHeight - desiredControlRows >= 3 ? desiredControlRows : 0;
      this.plot(buffer, s.selected, 2, 4, this.width - 4, bodyHeight - controlRows - 1);
      if (controlRows) this.parameters(buffer, toolbarY - controlRows - 1);
    } else {
      this.columns = this.width >= 112 ? 3 : this.width >= 72 ? 2 : 1;
      const rows = Math.max(1, Math.min(4, Math.floor(bodyHeight / 8)));
      const capacity = this.columns * rows;
      const first = Math.floor(s.selected / capacity) * capacity;
      const last = Math.min(studies.length, first + capacity);
      this.text(
        buffer,
        `${first + 1}–${last} of ${studies.length} · synthetic signals`,
        2,
        2,
        this.colors.dim,
      );
      const tileWidth = Math.floor((this.width - 4 - (this.columns - 1) * 2) / this.columns);
      const tileHeight = Math.floor(bodyHeight / rows);
      for (let i = first; i < last; i++) {
        const x = 2 + ((i - first) % this.columns) * (tileWidth + 2);
        const y = 4 + Math.floor((i - first) / this.columns) * tileHeight;
        const selected = i === s.selected;
        const titleBackground = selected ? this.colors.surface : this.colors.background;
        if (selected) buffer.fillRect(this.x + x, this.y + y, tileWidth, 1, titleBackground);
        this.text(
          buffer,
          `${selected ? "┃" : " "} ${studies[i]!.name}`,
          x,
          y,
          selected ? this.colors.primary : this.colors.secondary,
          tileWidth,
          selected ? TextAttributes.BOLD : 0,
          titleBackground,
        );
        const inset = tileHeight >= 5 ? 2 : 1;
        this.plot(buffer, i, x, y + inset, tileWidth, Math.max(1, tileHeight - inset - 1));
        this.regions.push({ x, y, width: tileWidth, height: tileHeight - 1, action: `study:${i}` });
      }
    }
    for (const item of toolbar)
      this.button(buffer, item.label, item.x, toolbarY + item.row, item.action);
    if (s.commandsOpen) this.drawCommands(buffer);
  }

  private parameters(buffer: OptimizedBuffer, y: number): void {
    const keys = Object.keys(limits) as Array<keyof Parameters>;
    const horizontal = this.width >= 80;
    keys.forEach((name, index) => {
      const x = 2 + (horizontal ? Math.floor((this.width - 4) / 3) * index : 0);
      const row = y + (horizontal ? 0 : index);
      this.regions.push({ x, y: row, width: 24, height: 1, action: `${name}:+` });
      this.text(buffer, name, x, row, this.colors.dim, 9);
      this.button(buffer, "−", x + 10, row, `${name}:-`);
      this.text(
        buffer,
        `${this.state.parameters[name].toFixed(2)}×`,
        x + 14,
        row,
        this.colors.primary,
        6,
      );
      this.button(buffer, "+", x + 21, row, `${name}:+`);
    });
  }

  private drawCommands(buffer: OptimizedBuffer): void {
    const commands = this.filteredCommands();
    const width = Math.min(62, this.width - 4);
    const height = Math.min(this.height - 2, 19);
    const x = Math.floor((this.width - width) / 2);
    const y = Math.floor((this.height - height) / 2);
    // Fxnk's single 20% scrim; the dialog keeps the terminal default background.
    buffer.fillRect(this.x, this.y, this.width, this.height, scrim);
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
      title: " commands ",
      titleColor: this.colors.primary,
    });
    // The overlay owns pointer input, including its empty interior.
    this.regions = [{ x: 0, y: 0, width: this.width, height: this.height, action: "commands" }];
    this.regions.push({ x, y, width, height, action: "noop" });
    this.text(
      buffer,
      `❯ ${this.state.filter || "type to filter"}`,
      x + 2,
      y + 1,
      this.state.filter ? this.colors.primary : this.colors.dim,
      width - 4,
    );
    const visibleRows = height - 5;
    const first = Math.max(
      0,
      Math.min(
        this.state.commandIndex - Math.floor(visibleRows / 2),
        commands.length - visibleRows,
      ),
    );
    if (!commands.length)
      this.text(buffer, "No matching commands", x + 2, y + 3, this.colors.dim, width - 4);
    for (let row = 0; row < visibleRows && first + row < commands.length; row++) {
      const index = first + row;
      const command = commands[index]!;
      const selected = index === this.state.commandIndex;
      this.text(buffer, selected ? "▎" : " ", x + 2, y + 3 + row, this.colors.focus, 1);
      this.text(
        buffer,
        command.label,
        x + 4,
        y + 3 + row,
        selected ? this.colors.primary : this.colors.secondary,
        width - 17,
        selected ? TextAttributes.BOLD : 0,
      );
      this.text(buffer, command.key, x + width - 11, y + 3 + row, this.colors.dim, 9);
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
      `${commands.length ? this.state.commandIndex + 1 : 0}/${commands.length}`,
      x + 2,
      y + height - 2,
      this.colors.dim,
      width - 14,
    );
    this.button(buffer, "Close", x + width - 9, y + height - 2, "commands");
  }
}
