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
import { encodeRemoteMessage, parseRemoteState, type RemoteState } from "./remote-protocol.ts";
import { SignalField } from "./signal-field.ts";
import { styledSignalField } from "./signal-field-ui.ts";
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
    minHeight: 7,
    border: ["left"],
    borderStyle: "single",
    borderColor: PALETTE.accent,
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: PALETTE.panel,
    onMouseDown: (event) => {
      const middle = rails.x + rails.width / 2;
      toggle(event.x < middle ? "mic" : "speaker");
    },
  });
  const fieldLabels = new TextRenderable(renderer, { content: "", height: 1, wrapMode: "none" });
  const fieldCanvas = new TextRenderable(renderer, {
    content: "",
    flexGrow: 1,
    wrapMode: "none",
    fg: PALETTE.faint,
  });
  const fieldReadout = new TextRenderable(renderer, {
    content: "",
    height: 1,
    wrapMode: "none",
    fg: PALETTE.dim,
  });
  rails.add(fieldLabels);
  rails.add(fieldCanvas);
  rails.add(fieldReadout);
  main.add(rails);

  const controls = new BoxRenderable(renderer, {
    width: "100%",
    height: "42%",
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
  const signalField = new SignalField({ seed: 0x2e6d_07e });

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
  renderer.setFrameCallback(async (deltaMs) => {
    if (renderer.width !== layoutWidth) paint();
    const micMuted = latest?.mic.muted ?? false;
    const agentMuted = latest?.speaker.muted ?? false;
    signalField.step(deltaMs / 1000, {
      you: connected ? (latest?.mic.level ?? 0) : 0,
      agent: connected ? (latest?.speaker.level ?? 0) : 0,
      youMuted: micMuted,
      agentMuted,
    });
    const frame = signalField.render(
      Math.max(1, fieldCanvas.width),
      Math.max(1, fieldCanvas.height),
      {
        you: micMuted,
        agent: agentMuted,
      },
    );
    const youColor = micMuted ? PALETTE.youDim : PALETTE.you;
    const agentColor = agentMuted ? PALETTE.agentDim : PALETTE.agent;
    fieldCanvas.content = styledSignalField(frame, {
      faint: PALETTE.faint,
      dim: PALETTE.dim,
      you: youColor,
      agent: agentColor,
      contact: PALETTE.contact,
    });
    fieldLabels.content = remoteFieldLabels(
      Math.max(1, fieldLabels.width),
      micMuted,
      agentMuted,
      youColor,
      agentColor,
    );
    fieldReadout.content = remoteFieldReadout(
      Math.max(1, fieldReadout.width),
      latest?.mic.level ?? 0,
      latest?.speaker.level ?? 0,
      frame.contact,
      youColor,
      agentColor,
    );
  });
  renderer.requestLive();
  paint();
  connect();
  await done;
}

function phaseLabel(phase: RemoteState["phase"] | undefined): string {
  if (phase === "live") return "LIVE";
  if (phase === "failed") return "FAILED";
  if (phase === "reconnecting") return "RECONNECT";
  if (phase === "negotiating") return "CONNECT";
  return "WAITING";
}

function remoteFieldLabels(
  width: number,
  youMuted: boolean,
  agentMuted: boolean,
  youColor: string,
  agentColor: string,
): StyledText {
  const left = width < 30 ? "YOU ▷" : `YOU ${youMuted ? "× MUTED" : "▷ INPUT"}`;
  const right = width < 30 ? "◁ AGT" : `${agentMuted ? "MUTED ×" : "OUTPUT ◁"} AGENT`;
  const availableRight = Math.max(0, width - Math.min(left.length, width) - 1);
  const clippedRight = right.slice(Math.max(0, right.length - availableRight));
  const clippedLeft = left.slice(0, Math.max(0, width - clippedRight.length - 1));
  return new StyledText([
    bold(fg(youColor)(clippedLeft)),
    fg(PALETTE.faint)(" ".repeat(Math.max(1, width - clippedLeft.length - clippedRight.length))),
    bold(fg(agentColor)(clippedRight)),
  ]);
}

function remoteFieldReadout(
  width: number,
  you: number,
  agent: number,
  contact: number,
  youColor: string,
  agentColor: string,
): StyledText {
  const left = `${Math.round(you * 100)
    .toString()
    .padStart(3)}%`;
  const right = `${Math.round(agent * 100)
    .toString()
    .padStart(3)}%`;
  const middle = contact > 0.12 && width >= 24 ? "CONTACT" : "";
  const spare = Math.max(0, width - left.length - right.length - middle.length);
  const leftGap = Math.max(1, Math.floor(spare / 2));
  const rightGap = Math.max(0, spare - leftGap);
  return new StyledText([
    fg(youColor)(left),
    fg(PALETTE.faint)(" ".repeat(leftGap)),
    ...(middle ? [fg(PALETTE.contact)(middle)] : []),
    fg(PALETTE.faint)(" ".repeat(rightGap)),
    fg(agentColor)(right),
  ]);
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
