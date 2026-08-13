import type { TranscriptItem, TranscriptState, TranscriptTurn } from "./transcript.ts";

type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
type ScrollBox = InstanceType<OpenTui["ScrollBoxRenderable"]>;
type SyntaxStyle = InstanceType<OpenTui["SyntaxStyle"]>;
type Box = InstanceType<OpenTui["BoxRenderable"]>;

export interface TranscriptPalette {
  canvas: string;
  panel: string;
  selected: string;
  line: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  local: string;
  remote: string;
  ok: string;
  hot: string;
  danger: string;
}

export interface TranscriptRow {
  key: string;
  turn: TranscriptTurn;
  item: TranscriptItem;
  turnNumber: number;
  firstInTurn: boolean;
  lastInTurn: boolean;
}

export interface TranscriptViewState {
  selectedKey: string | null;
  expanded: ReadonlySet<string>;
  raw: ReadonlySet<string>;
  width: number;
}

interface TranscriptWidget {
  box: Box;
  fingerprint: string;
}

function compact(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function duration(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

function label(item: TranscriptItem): string {
  switch (item.family) {
    case "user":
      return "USER";
    case "hook":
      return item.type === "hookRun" ? "HOOK" : "CONTEXT";
    case "agent":
      return "AGENT";
    case "plan":
      return "PLAN";
    case "reasoning":
      return "THINKING";
    case "command":
      return "COMMAND";
    case "fileChange":
      return "EDIT";
    case "tool":
      return "TOOL";
    case "collab":
      return "AGENT";
    case "web":
      return "SEARCH";
    case "media":
      return item.type === "imageView" ? "IMAGE" : "GENERATE";
    case "wait":
      return "WAIT";
    case "system":
      return "SYSTEM";
    case "error":
      return "ERROR";
    case "raw":
      return compact(item.type.toUpperCase(), 16);
  }
}

function diffStats(diff: string | undefined): string {
  if (!diff) return "";
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return `${added > 0 ? `+${added}` : ""}${added > 0 && removed > 0 ? " " : ""}${
    removed > 0 ? `−${removed}` : ""
  }`;
}

function summary(item: TranscriptItem, width: number): string {
  const limit = Math.max(18, Math.min(80, width - 38));
  switch (item.family) {
    case "reasoning":
      return compact(item.summary?.filter(Boolean).join(" ") ?? "", limit);
    case "command":
      return compact(item.command ?? "", limit);
    case "fileChange": {
      const paths = item.changes?.map((change) => change.path).join(", ") ?? "";
      return compact(`${paths}${paths && item.diff ? "  " : ""}${diffStats(item.diff)}`, limit);
    }
    case "tool":
      return compact(
        `${item.toolServer ? `${item.toolServer} / ` : ""}${item.toolName ?? "tool"}`,
        limit,
      );
    case "collab":
      return compact(`${item.toolName ?? "agent"}${item.text ? `  ${item.text}` : ""}`, limit);
    case "web":
      return compact(item.text ?? "", limit);
    case "media":
      return compact(item.text ?? "", limit);
    case "wait":
      return duration(item.durationMs);
    case "system":
    case "error":
      return compact(item.text ?? "", limit);
    case "plan":
      return compact(item.explanation ?? item.text?.split("\n")[0] ?? "", limit);
    case "hook":
      return compact(item.text?.split("\n")[0] ?? "", limit);
    case "raw":
      return "raw App-server item";
    case "user":
    case "agent":
      return "";
  }
}

function statusLabel(item: TranscriptItem): string {
  if (["user", "agent", "hook", "reasoning", "system"].includes(item.family)) {
    return duration(item.durationMs);
  }
  switch (item.status) {
    case "inProgress":
    case "running":
    case "pending":
      return "RUNNING";
    case "completed":
    case "success":
      return "DONE";
    case "failed":
    case "errored":
      return "FAILED";
    case "declined":
      return "DECLINED";
    case "blocked":
      return "BLOCKED";
    case "interrupted":
    case "cancelled":
    case "canceled":
    case "stopped":
      return "STOPPED";
    default:
      return item.status ? compact(item.status.toUpperCase(), 12) : "";
  }
}

function terminalStatus(status: string): boolean {
  return [
    "completed",
    "failed",
    "errored",
    "declined",
    "interrupted",
    "cancelled",
    "canceled",
    "blocked",
    "stopped",
  ].includes(status);
}

function statusTone(item: TranscriptItem, palette: TranscriptPalette): string {
  if (
    ["failed", "errored", "declined", "blocked"].includes(item.status) ||
    item.family === "error"
  ) {
    return palette.danger;
  }
  if (["inProgress", "running", "pending"].includes(item.status)) return palette.hot;
  if (["interrupted", "cancelled", "canceled", "blocked", "stopped"].includes(item.status)) {
    return palette.muted;
  }
  return palette.ok;
}

function familyTone(item: TranscriptItem, palette: TranscriptPalette): string {
  switch (item.family) {
    case "user":
    case "hook":
      return palette.local;
    case "agent":
    case "collab":
      return palette.remote;
    case "error":
      return palette.danger;
    case "reasoning":
    case "system":
      return palette.muted;
    default:
      return palette.accent;
  }
}

function marker(row: TranscriptRow): string {
  if (row.firstInTurn) return String(row.turnNumber).padStart(2, "0");
  return row.lastInTurn && terminalStatus(row.turn.status) ? "┗" : "┣";
}

export function previewOutput(value: string, expanded: boolean): string {
  if (expanded) return value;
  const maxChars = 2_400;
  const lines = value.split("\n");
  const visible = lines.slice(0, 10);
  const suffix =
    lines.length > visible.length ? `\n… ${lines.length - visible.length} more lines` : "";
  const available = Math.max(0, maxChars - suffix.length);
  const output = visible.join("\n");
  const clipped =
    output.length <= available ? output : `${output.slice(0, Math.max(0, available - 1))}…`;
  return `${clipped}${suffix}`;
}

function markdownBody(item: TranscriptItem, expanded: boolean): string {
  switch (item.family) {
    case "user":
    case "agent":
      return item.text ?? "";
    case "hook":
      return expanded ? (item.text ?? "") : "";
    case "reasoning":
      return expanded
        ? [...(item.summary ?? []), ...(item.content ?? [])].filter(Boolean).join("\n\n")
        : "";
    case "plan": {
      const prose = item.text ?? "";
      const steps = item.plan
        ?.map((step) => `- [${step.status === "completed" ? "x" : " "}] ${step.step}`)
        .join("\n");
      return [prose, steps].filter(Boolean).join("\n\n");
    }
    case "collab":
    case "web":
    case "media":
      return expanded ? (item.text ?? "") : "";
    case "system":
    case "error":
      return item.text ?? "";
    default:
      return "";
  }
}

function toolBody(item: TranscriptItem): string {
  return json({
    ...(item.arguments !== undefined ? { arguments: item.arguments } : {}),
    ...(item.result !== undefined && item.result !== null ? { result: item.result } : {}),
    ...(item.error ? { error: item.error } : {}),
    ...(item.progress?.length ? { progress: item.progress } : {}),
  });
}

function fingerprint(row: TranscriptRow, view: TranscriptViewState): string {
  return json({
    item: row.item,
    turnStatus: row.turn.status,
    turnNumber: row.turnNumber,
    first: row.firstInTurn,
    last: row.lastInTurn,
    selected: view.selectedKey === row.key,
    expanded: view.expanded.has(row.key),
    raw: view.raw.has(row.key),
    width: view.width > 120 ? "wide" : "compact",
  });
}

export function transcriptRows(transcript: TranscriptState | null): TranscriptRow[] {
  if (!transcript) return [];
  return transcript.turns.flatMap((turn, turnIndex) =>
    turn.items.map((item, itemIndex) => ({
      key: `${turn.id}:${item.id}`,
      turn,
      item,
      turnNumber: turnIndex + 1,
      firstInTurn: itemIndex === 0,
      lastInTurn: itemIndex === turn.items.length - 1,
    })),
  );
}

export class TranscriptHarnessView {
  private readonly widgets = new Map<string, TranscriptWidget>();
  private order: string[] = [];
  private empty: InstanceType<OpenTui["TextRenderable"]> | null = null;

  constructor(
    private readonly core: OpenTui,
    private readonly renderer: Renderer,
    private readonly scroll: ScrollBox,
    private readonly syntaxStyle: SyntaxStyle,
    private readonly palette: TranscriptPalette,
    private readonly onActivate: (key: string) => void,
  ) {}

  clear(): void {
    for (const child of this.scroll.getChildren()) {
      this.scroll.remove(child);
      child.destroyRecursively();
    }
    this.widgets.clear();
    this.order = [];
    this.empty = null;
  }

  sync(transcript: TranscriptState | null, view: TranscriptViewState): TranscriptRow[] {
    const rows = transcriptRows(transcript);
    const nextOrder = rows.map((row) => row.key);
    const sameOrder =
      this.order.length === nextOrder.length &&
      this.order.every((key, index) => key === nextOrder[index]);
    if (!sameOrder) {
      this.clear();
      if (rows.length === 0) {
        this.empty = new this.core.TextRenderable(this.renderer, {
          id: "harness-empty",
          content: "No Codex transcript yet. The next turn will appear here.",
          fg: this.palette.muted,
        });
        this.scroll.add(this.empty);
      } else {
        rows.forEach((row) => {
          const widget = this.createWidget(row, view);
          this.widgets.set(row.key, widget);
          this.scroll.add(widget.box);
        });
      }
      this.order = nextOrder;
      return rows;
    }

    rows.forEach((row, index) => {
      const nextFingerprint = fingerprint(row, view);
      const current = this.widgets.get(row.key);
      if (current?.fingerprint === nextFingerprint) return;
      const widget = this.createWidget(row, view);
      if (current) {
        this.scroll.remove(current.box);
        current.box.destroyRecursively();
      }
      this.scroll.add(widget.box, index);
      this.widgets.set(row.key, widget);
    });
    return rows;
  }

  scrollIntoView(key: string): void {
    const row = this.widgets.get(key);
    if (row) this.scroll.scrollChildIntoView(row.box.id);
  }

  private createWidget(row: TranscriptRow, view: TranscriptViewState): TranscriptWidget {
    const { item } = row;
    const selected = view.selectedKey === row.key;
    const expanded = view.expanded.has(row.key);
    const showRaw = view.raw.has(row.key) || item.family === "raw";
    const tone = selected ? this.palette.accent : familyTone(item, this.palette);
    const background = selected ? this.palette.selected : this.palette.canvas;
    const box = new this.core.BoxRenderable(this.renderer, {
      id: `harness-item-${item.id}`,
      width: "100%",
      marginBottom: row.lastInTurn ? 1 : 0,
      flexDirection: "column",
      backgroundColor: background,
      onMouseUp: () => this.onActivate(row.key),
    });
    const header = new this.core.BoxRenderable(this.renderer, {
      id: `harness-header-${item.id}`,
      width: "100%",
      height: 1,
      flexDirection: "row",
      backgroundColor: background,
    });
    const narrow = view.width < 56;
    const state = statusLabel(item);
    header.add(
      new this.core.TextRenderable(this.renderer, {
        id: `harness-marker-${item.id}`,
        width: 3,
        content: marker(row),
        fg: tone,
        wrapMode: "none",
      }),
    );
    header.add(
      new this.core.TextRenderable(this.renderer, {
        id: `harness-label-${item.id}`,
        width: narrow ? 10 : 12,
        content: label(item),
        fg: selected ? this.palette.text : tone,
        attributes: selected ? 1 : 0,
        wrapMode: "none",
      }),
    );
    header.add(
      new this.core.TextRenderable(this.renderer, {
        id: `harness-summary-${item.id}`,
        content: summary(item, view.width),
        fg: this.palette.text,
        flexGrow: 1,
        flexShrink: 1,
        wrapMode: "none",
        truncate: true,
      }),
    );
    if (!narrow || ["RUNNING", "FAILED", "DECLINED", "BLOCKED", "STOPPED"].includes(state)) {
      header.add(
        new this.core.TextRenderable(this.renderer, {
          id: `harness-state-${item.id}`,
          content: state,
          fg: statusTone(item, this.palette),
          flexShrink: 0,
          wrapMode: "none",
        }),
      );
    }
    box.add(header);

    const body = new this.core.BoxRenderable(this.renderer, {
      id: `harness-body-${item.id}`,
      width: "100%",
      paddingLeft: 2,
      paddingRight: 1,
      flexDirection: "column",
      backgroundColor: background,
      border: ["left"],
      borderStyle: "heavy",
      borderColor: tone,
    });
    let hasBody = false;
    if (showRaw) {
      hasBody = true;
      body.add(
        new this.core.CodeRenderable(this.renderer, {
          id: `harness-raw-${item.id}`,
          content: json(item.raw),
          filetype: "json",
          syntaxStyle: this.syntaxStyle,
          width: "100%",
          wrapMode: "word",
          selectable: true,
          selectionBg: this.palette.accent,
          selectionFg: this.palette.canvas,
          conceal: false,
          drawUnstyledText: true,
        }),
      );
    } else if (
      [
        "user",
        "agent",
        "hook",
        "reasoning",
        "plan",
        "collab",
        "web",
        "media",
        "system",
        "error",
      ].includes(item.family)
    ) {
      const content = markdownBody(item, expanded);
      if (content) {
        hasBody = true;
        body.add(
          new this.core.MarkdownRenderable(this.renderer, {
            id: `harness-markdown-${item.id}`,
            content,
            syntaxStyle: this.syntaxStyle,
            fg: item.family === "error" ? this.palette.danger : this.palette.text,
            bg: background,
            conceal: true,
            concealCode: true,
            streaming: item.status === "inProgress",
          }),
        );
      }
    } else if (item.family === "command") {
      const command = item.command ? `$ ${item.command}` : "";
      const output = item.output ? previewOutput(item.output, expanded) : "";
      const content = [command, output].filter(Boolean).join("\n");
      if (content) {
        hasBody = true;
        body.add(
          new this.core.CodeRenderable(this.renderer, {
            id: `harness-code-${item.id}`,
            content,
            filetype: "bash",
            syntaxStyle: this.syntaxStyle,
            width: "100%",
            wrapMode: "word",
            selectable: true,
            selectionBg: this.palette.accent,
            selectionFg: this.palette.canvas,
            conceal: true,
            drawUnstyledText: true,
          }),
        );
      }
    } else if (item.family === "fileChange" && item.diff) {
      hasBody = true;
      const lines = item.diff.split("\n").length;
      body.add(
        new this.core.DiffRenderable(this.renderer, {
          id: `harness-diff-${item.id}`,
          diff: item.diff,
          view: view.width > 120 ? "split" : "unified",
          syntaxStyle: this.syntaxStyle,
          width: "100%",
          height: expanded ? Math.max(3, lines + 2) : Math.min(12, Math.max(3, lines + 2)),
          wrapMode: "word",
          showLineNumbers: false,
          conceal: true,
          fg: this.palette.text,
          contextBg: background,
          addedBg: "#10251b",
          removedBg: "#29171b",
          addedSignColor: this.palette.ok,
          removedSignColor: this.palette.danger,
          lineNumberFg: this.palette.faint,
          selectionBg: this.palette.accent,
          selectionFg: this.palette.canvas,
        }),
      );
    } else if (item.family === "tool") {
      const progress = item.progress?.at(-1);
      if (expanded) {
        hasBody = true;
        body.add(
          new this.core.CodeRenderable(this.renderer, {
            id: `harness-code-${item.id}`,
            content: toolBody(item),
            filetype: "json",
            syntaxStyle: this.syntaxStyle,
            width: "100%",
            wrapMode: "word",
            selectable: true,
            selectionBg: this.palette.accent,
            selectionFg: this.palette.canvas,
            conceal: false,
            drawUnstyledText: true,
          }),
        );
      } else if (item.error || progress) {
        hasBody = true;
        body.add(
          new this.core.TextRenderable(this.renderer, {
            id: `harness-progress-${item.id}`,
            content: compact(item.error ?? progress ?? "", 240),
            fg: item.error ? this.palette.danger : this.palette.muted,
            wrapMode: "word",
          }),
        );
      }
    } else if (item.family === "wait" && expanded) {
      hasBody = true;
      body.add(
        new this.core.TextRenderable(this.renderer, {
          id: `harness-wait-${item.id}`,
          content: `Waiting for ${duration(item.durationMs)}`,
          fg: this.palette.muted,
        }),
      );
    }
    if (hasBody) box.add(body);

    return { box, fingerprint: fingerprint(row, view) };
  }
}
