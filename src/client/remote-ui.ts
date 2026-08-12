import { createConnection, type Socket } from "node:net";
import {
  BoxRenderable,
  bold,
  type CliRenderer,
  createCliRenderer,
  fg,
  type ParsedKey,
  StyledText,
  TextRenderable,
} from "@opentui/core";
import { barString } from "./dsp.ts";
import { encodeRemoteMessage, parseRemoteState, type RemoteState } from "./remote-protocol.ts";
import { SIGNAL_GLYPHS, VOICE_TONES } from "./theme.ts";

const RECONNECT_MS = 750;
const PALETTE = VOICE_TONES;

export class RemoteError extends Error {}

export async function runRemote(socketPath: string): Promise<void> {
  const renderer: CliRenderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
    screenMode: "alternate-screen",
    backgroundColor: PALETTE.bg,
  });
  const root = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: PALETTE.bg,
  });
  renderer.root.add(root);

  const header = new BoxRenderable(renderer, {
    width: "100%",
    height: 3,
    border: ["bottom"],
    borderStyle: "single",
    borderColor: PALETTE.border,
    backgroundColor: PALETTE.field,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingLeft: 1,
    paddingRight: 1,
    // Signal Room headers reserve the first row and put the divider directly
    // below the title row; direct Text children otherwise round upward here.
    paddingTop: 1,
  });
  const brand = new TextRenderable(renderer, {
    content: new StyledText([
      fg(PALETTE.accent)(SIGNAL_GLYPHS.rail),
      bold(fg(PALETTE.text)(" AGENTVOICE")),
      fg(PALETTE.dim)(" / REMOTE"),
    ]),
  });
  const status = new TextRenderable(renderer, { content: "○ WAITING", fg: PALETTE.warn });
  header.add(brand);
  header.add(status);
  root.add(header);

  const main = new BoxRenderable(renderer, {
    width: "100%",
    flexGrow: 1,
    flexDirection: "column",
    padding: 1,
    gap: 1,
    backgroundColor: PALETTE.bg,
  });
  root.add(main);

  const rails = new BoxRenderable(renderer, {
    width: "100%",
    flexGrow: 1,
    flexDirection: "column",
    justifyContent: "center",
    gap: 1,
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: PALETTE.panel,
  });
  const youRail = new TextRenderable(renderer, { content: "YOU", fg: PALETTE.you });
  const agentRail = new TextRenderable(renderer, { content: "AGENT", fg: PALETTE.agent });
  rails.add(youRail);
  rails.add(agentRail);
  main.add(rails);

  const controls = new BoxRenderable(renderer, {
    width: "100%",
    height: "48%",
    minHeight: 7,
    flexDirection: "row",
    gap: 1,
    backgroundColor: PALETTE.bg,
  });
  main.add(controls);

  const makeControl = (target: "mic" | "speaker", label: string, color: string) => {
    const panel = new BoxRenderable(renderer, {
      flexGrow: 1,
      flexBasis: 1,
      border: true,
      borderStyle: "single",
      borderColor: color,
      backgroundColor: PALETTE.panel,
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
      gap: 1,
      onMouseDown: () => toggle(target),
    });
    const title = new TextRenderable(renderer, {
      content: new StyledText([bold(fg(color)(label))]),
    });
    const state = new TextRenderable(renderer, { content: "—", fg: PALETTE.dim });
    panel.add(title);
    panel.add(state);
    controls.add(panel);
    return { panel, title, state, color };
  };
  const micControl = makeControl("mic", "MIC", PALETTE.you);
  const speakerControl = makeControl("speaker", "SPEAKER", PALETTE.agent);

  let latest: RemoteState | null = null;
  let socket: Socket | null = null;
  let connected = false;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let layoutWidth = 0;

  const paint = (): void => {
    const width = renderer.width || process.stdout.columns || 40;
    layoutWidth = width;
    const compact = width < 34;
    controls.flexDirection = width < 26 ? "column" : "row";
    brand.content = new StyledText([
      fg(PALETTE.accent)(SIGNAL_GLYPHS.rail),
      bold(fg(PALETTE.text)(compact ? " AV" : " AGENTVOICE")),
      ...(compact ? [] : [fg(PALETTE.dim)(" / REMOTE")]),
    ]);
    const phase = latest?.phase;
    status.content = connected
      ? `${phase === "live" ? SIGNAL_GLYPHS.live : SIGNAL_GLYPHS.idle} ${phaseLabel(phase)}`
      : `${SIGNAL_GLYPHS.idle} WAITING`;
    status.fg = phase === "live" ? PALETTE.ok : connected ? PALETTE.warn : PALETTE.dim;

    const meterWidth = Math.max(4, width - (compact ? 9 : 11));
    youRail.content = railLine("YOU", latest?.mic.level ?? 0, meterWidth);
    agentRail.content = railLine(compact ? "AGT" : "AGENT", latest?.speaker.level ?? 0, meterWidth);
    paintControl(micControl, "MIC", latest?.mic.muted, connected);
    paintControl(speakerControl, "SPEAKER", latest?.speaker.muted, connected);
    renderer.requestRender();
  };

  const connect = (): void => {
    if (closed) return;
    const next = createConnection(socketPath);
    socket = next;
    let buffered = "";
    next.setEncoding("utf8");
    next.on("connect", () => {
      connected = true;
      paint();
    });
    next.on("data", (chunk: string) => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline === -1) break;
        const parsed = parseRemoteState(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (parsed) latest = parsed;
      }
      paint();
    });
    next.on("error", () => {});
    next.on("close", () => {
      if (socket === next) socket = null;
      connected = false;
      latest = null;
      paint();
      if (!closed) reconnectTimer = setTimeout(connect, RECONNECT_MS);
    });
  };

  function toggle(target: "mic" | "speaker"): void {
    if (!connected || !socket || !latest) return;
    const muted = target === "mic" ? latest.mic.muted : latest.speaker.muted;
    socket.write(encodeRemoteMessage({ type: "set-muted", target, muted: !muted }));
  }

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.destroy();
    renderer.destroy();
    resolveDone();
  };
  renderer.keyInput.on("keypress", (key: ParsedKey) => {
    if (key.eventType === "release") return;
    if (key.name === "q" || (key.ctrl && key.name === "c")) shutdown();
    else if (key.name === "m") toggle("mic");
    else if (key.name === "s") toggle("speaker");
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  renderer.setFrameCallback(async () => {
    if (renderer.width !== layoutWidth) paint();
  });
  renderer.requestLive();
  paint();
  connect();
  await done;
}

function railLine(label: string, level: number, width: number): string {
  return `${label.padEnd(6)}${barString(level, width)}`;
}

function phaseLabel(phase: RemoteState["phase"] | undefined): string {
  if (phase === "live") return "LIVE";
  if (phase === "failed") return "FAILED";
  if (phase === "reconnecting") return "RECONNECT";
  if (phase === "negotiating") return "CONNECT";
  return "WAITING";
}

function paintControl(
  control: { panel: BoxRenderable; title: TextRenderable; state: TextRenderable; color: string },
  label: string,
  muted: boolean | undefined,
  connected: boolean,
): void {
  const active = connected && muted !== undefined;
  const color = active ? (muted ? PALETTE.dim : control.color) : PALETTE.faint;
  control.panel.borderColor = color;
  control.panel.backgroundColor = active && muted ? PALETTE.field : PALETTE.panel;
  control.title.content = new StyledText([bold(fg(color)(label))]);
  control.state.content = active ? (muted ? "MUTED" : "LIVE") : "—";
  control.state.fg = color;
}
