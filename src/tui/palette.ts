type OpenTui = typeof import("@opentui/core");

export interface PaletteCommand {
  id: string;
  /** Display combo only ("R", "⇧G") — the binding itself stays with the app. */
  key: string;
  label: string;
  onRun(): void;
}

export interface PaletteState {
  commands: readonly PaletteCommand[];
  width: number;
  height: number;
}

export interface PaletteTokens {
  panel: string;
  line: string;
  accent: string;
  muted: string;
  text: string;
}

export interface CommandPalette {
  root: InstanceType<OpenTui["BoxRenderable"]>;
  isOpen(): boolean;
  open(): void;
  /** First stop for every keypress; true means consumed. ctrl+c always falls through. */
  handleKey(key: {
    name: string;
    ctrl: boolean;
    meta?: boolean;
    sequence?: string;
    eventType?: string;
  }): boolean;
  update(state: PaletteState): void;
}

/** Case-insensitive substring filter over "label key". Pure for tests. */
export function paletteMatches(
  commands: readonly PaletteCommand[],
  filter: string,
): PaletteCommand[] {
  const needle = filter.trim().toLowerCase();
  if (needle.length === 0) return [...commands];
  return commands.filter((command) =>
    `${command.label} ${command.key}`.toLowerCase().includes(needle),
  );
}

const MAX_VISIBLE_ROWS = 10;

export function createCommandPalette(
  core: OpenTui,
  renderer: Awaited<ReturnType<OpenTui["createCliRenderer"]>>,
  id: string,
  tokens: PaletteTokens,
): CommandPalette {
  let open = false;
  let filter = "";
  let selected = 0;
  let start = 0;
  let state: PaletteState = { commands: [], width: 80, height: 24 };
  let signature = "";

  const root = new core.BoxRenderable(renderer, {
    id,
    position: "absolute",
    zIndex: 100,
    visible: false,
    flexDirection: "column",
    border: true,
    borderStyle: "single",
    borderColor: tokens.line,
    backgroundColor: tokens.panel,
    title: " COMMANDS ",
    titleColor: tokens.muted,
    titleAlignment: "left",
    paddingLeft: 2,
    paddingRight: 2,
    onMouseScroll: (event) => {
      const direction = event.scroll?.direction;
      if (direction !== "up" && direction !== "down") return;
      moveSelection(direction === "down" ? 1 : -1);
      event.preventDefault();
    },
  });
  const filterText = new core.TextRenderable(renderer, {
    id: `${id}-filter`,
    content: "",
    height: 1,
    wrapMode: "none",
  });
  const rowsBox = new core.BoxRenderable(renderer, {
    id: `${id}-rows`,
    flexDirection: "column",
    marginTop: 1,
    backgroundColor: tokens.panel,
  });
  root.add(filterText);
  root.add(rowsBox);

  const matches = (): PaletteCommand[] => paletteMatches(state.commands, filter);

  const moveSelection = (delta: number): void => {
    const count = matches().length;
    if (count === 0) return;
    selected = Math.min(count - 1, Math.max(0, selected + delta));
    layout();
    renderer.requestRender();
  };

  const run = (command: PaletteCommand): void => {
    close();
    command.onRun();
  };

  const openPalette = (): void => {
    open = true;
    filter = "";
    selected = 0;
    start = 0;
    root.visible = true;
    layout();
    renderer.requestRender();
  };

  const close = (): void => {
    open = false;
    root.visible = false;
    renderer.requestRender();
  };

  function layout(): void {
    const visible = matches();
    selected = Math.min(selected, Math.max(0, visible.length - 1));
    const width = Math.max(24, Math.min(48, state.width - 4));
    const rowCount = Math.min(
      Math.max(1, visible.length),
      Math.max(3, state.height - 8),
      MAX_VISIBLE_ROWS,
    );
    if (selected < start) start = selected;
    if (selected >= start + rowCount) start = selected - rowCount + 1;
    start = Math.max(0, Math.min(start, Math.max(0, visible.length - rowCount)));
    const height = rowCount + 4;
    root.width = width;
    root.height = height;
    root.left = Math.max(0, Math.floor((state.width - width) / 2));
    root.top = Math.max(1, Math.floor((state.height - height) / 3));

    const window = visible.slice(start, start + rowCount);
    const keyWidth = state.commands.reduce((max, command) => Math.max(max, command.key.length), 1);
    const nextSignature = JSON.stringify({
      filter,
      selected,
      start,
      width,
      window: window.map((command) => [command.id, command.key, command.label]),
    });
    if (signature === nextSignature) return;
    signature = nextSignature;

    filterText.content = new core.StyledText([
      core.bold(core.fg(tokens.accent)("> ")),
      filter.length > 0 ? core.fg(tokens.text)(filter) : core.fg(tokens.muted)("type to filter"),
    ]);
    for (const child of rowsBox.getChildren()) {
      rowsBox.remove(child);
      child.destroyRecursively();
    }
    if (visible.length === 0) {
      rowsBox.add(
        new core.TextRenderable(renderer, {
          content: "no matching command",
          fg: tokens.muted,
          height: 1,
        }),
      );
      return;
    }
    window.forEach((command, index) => {
      const isSelected = start + index === selected;
      const row = new core.BoxRenderable(renderer, {
        id: `${id}-command-${command.id}`,
        height: 1,
        flexDirection: "row",
        backgroundColor: tokens.panel,
        onMouseUp: () => run(command),
      });
      const key = `[${command.key}]`.padEnd(keyWidth + 2);
      row.add(
        new core.TextRenderable(renderer, {
          content: new core.StyledText([
            isSelected ? core.bold(core.fg(tokens.accent)("▎ ")) : core.fg(tokens.panel)("  "),
            core.bold(core.fg(tokens.accent)(key)),
            core.fg(isSelected ? tokens.text : tokens.muted)(` ${command.label}`),
          ]),
        }),
      );
      rowsBox.add(row);
    });
  }

  return {
    root,
    isOpen: () => open,
    open: openPalette,
    handleKey(key) {
      if (key.ctrl && key.name === "c") return false;
      if (key.eventType === "release") return open;
      // Kitty event reporting makes a held ctrl+k repeat; only a fresh press
      // may toggle the palette.
      if (key.eventType === "repeat" && key.ctrl && key.name === "k") return open;
      if (!open) {
        if (key.ctrl && key.name === "k") {
          openPalette();
          return true;
        }
        return false;
      }
      if (key.name === "escape" || (key.ctrl && key.name === "k")) {
        close();
        return true;
      }
      if (key.name === "return" || key.name === "enter") {
        const command = matches()[selected];
        if (command) run(command);
        return true;
      }
      if (key.name === "up") {
        moveSelection(-1);
        return true;
      }
      if (key.name === "down") {
        moveSelection(1);
        return true;
      }
      if (key.name === "backspace") {
        filter = filter.slice(0, -1);
        selected = 0;
        start = 0;
        layout();
        renderer.requestRender();
        return true;
      }
      const sequence = key.sequence ?? "";
      if (!key.ctrl && key.meta !== true && sequence.length === 1 && sequence >= " ") {
        filter += sequence;
        selected = 0;
        start = 0;
        layout();
        renderer.requestRender();
        return true;
      }
      return true;
    },
    update(next) {
      state = next;
      if (open) layout();
    },
  };
}
