import type { CliRenderer } from "@opentui/core";

type OpenTui = typeof import("@opentui/core");

export interface FleetFooterPalette {
  field: string;
  line: string;
  accent: string;
  muted: string;
}

export interface FleetFooterAction {
  id: string;
  key: string;
  label: string;
  shortLabel?: string;
  onPress(): void;
}

export interface FleetFooterState {
  actions: readonly FleetFooterAction[];
  mode?: string;
  width: number;
}

export interface FleetFooter {
  root: InstanceType<OpenTui["BoxRenderable"]>;
  update(state: FleetFooterState): void;
}

interface FooterCopy {
  labels: string[];
  mode: string;
}

/** Chooses responsive copy; the action rail scrolls when it cannot all fit. */
export function footerCopy(state: FleetFooterState): FooterCopy {
  const innerWidth = Math.max(1, state.width - 4);
  const mode = state.mode ?? "";
  const visibleMode = innerWidth >= Math.max(48, mode.length + 24) ? mode : "";
  const actionWidth = Math.max(
    1,
    innerWidth - (visibleMode.length > 0 ? visibleMode.length + 2 : 0),
  );
  const fullWidth = state.actions.reduce(
    (sum, action) => sum + action.key.length + action.label.length + 5,
    0,
  );

  if (fullWidth <= actionWidth) {
    return { labels: state.actions.map((action) => action.label), mode: visibleMode };
  }
  if (innerWidth >= 32) {
    return {
      labels: state.actions.map((action) => action.shortLabel ?? action.label),
      mode: visibleMode,
    };
  }
  return { labels: state.actions.map(() => ""), mode: "" };
}

/** Shared three-row Signal Room footer with one scrollable action rail. */
export function createFleetFooter(
  core: OpenTui,
  renderer: CliRenderer,
  id: string,
  palette: FleetFooterPalette,
): FleetFooter {
  let actionsBox!: InstanceType<OpenTui["ScrollBoxRenderable"]>;
  const root = new core.BoxRenderable(renderer, {
    id,
    width: "100%",
    height: 3,
    flexDirection: "row",
    flexWrap: "no-wrap",
    overflow: "hidden",
    alignItems: "center",
    paddingLeft: 2,
    paddingRight: 2,
    backgroundColor: palette.field,
    border: ["top"],
    borderStyle: "single",
    borderColor: palette.line,
    onMouseScroll: (event) => {
      const direction = event.scroll?.direction;
      if (direction !== "up" && direction !== "down") return;
      const delta = Math.max(1, Math.abs(event.scroll?.delta ?? 3));
      actionsBox.scrollBy({ x: direction === "down" ? delta : -delta, y: 0 });
      event.preventDefault();
    },
    onMouseUp: (event) => pressActionAt(event.x),
  });
  const pressActionAt = (x: number): void => {
    for (const child of actionsBox.getChildren()) {
      if (x < child.x || x >= child.x + child.width) continue;
      const action = currentActions.find(
        (candidate) => `${id}-action-${candidate.id}` === child.id,
      );
      action?.onPress();
      return;
    }
  };
  let currentActions: readonly FleetFooterAction[] = [];
  actionsBox = new core.ScrollBoxRenderable(renderer, {
    id: `${id}-actions`,
    flexShrink: 0,
    height: 1,
    overflow: "hidden",
    scrollX: true,
    scrollY: false,
    viewportCulling: false,
    backgroundColor: palette.field,
    rootOptions: { overflow: "hidden" },
    wrapperOptions: { overflow: "hidden" },
    viewportOptions: { overflow: "hidden" },
    contentOptions: {
      flexDirection: "row",
      flexWrap: "no-wrap",
      overflow: "hidden",
      alignItems: "center",
      backgroundColor: palette.field,
    },
    horizontalScrollbarOptions: { visible: false },
    verticalScrollbarOptions: { visible: false },
  });
  const modeText = new core.TextRenderable(renderer, {
    id: `${id}-mode`,
    content: "",
    fg: palette.muted,
    height: 1,
    flexShrink: 0,
    wrapMode: "none",
  });
  root.add(actionsBox);
  root.add(modeText);
  actionsBox.horizontalScrollBar.visible = false;
  actionsBox.verticalScrollBar.visible = false;

  const clearActions = (): void => {
    for (const child of actionsBox.getChildren()) {
      actionsBox.remove(child);
      child.destroyRecursively();
    }
  };
  let signature = "";

  return {
    root,
    update(state) {
      currentActions = state.actions;
      const copy = footerCopy(state);
      const innerWidth = Math.max(1, Math.floor(state.width) - 4);
      const modeWidth = copy.mode.length;
      actionsBox.width = Math.max(1, innerWidth - (modeWidth > 0 ? modeWidth + 2 : 0));
      modeText.width = Math.max(1, modeWidth);
      const nextSignature = JSON.stringify({
        actions: state.actions.map((action, index) => [action.id, action.key, copy.labels[index]]),
        mode: copy.mode,
      });
      if (signature === nextSignature) return;
      signature = nextSignature;
      clearActions();
      state.actions.forEach((action, index) => {
        const label = copy.labels[index] ?? "";
        const target = new core.BoxRenderable(renderer, {
          id: `${id}-action-${action.id}`,
          height: 1,
          flexShrink: 0,
          flexDirection: "row",
          paddingRight: 2,
          backgroundColor: palette.field,
        });
        target.add(
          new core.TextRenderable(renderer, {
            content: new core.StyledText([
              core.bold(core.fg(palette.accent)(`[${action.key}]`)),
              ...(label.length > 0 ? [core.fg(palette.muted)(` ${label}`)] : []),
            ]),
          }),
        );
        actionsBox.add(target);
      });
      actionsBox.scrollLeft = 0;
      modeText.content = copy.mode;
      modeText.visible = copy.mode.length > 0;
    },
  };
}
