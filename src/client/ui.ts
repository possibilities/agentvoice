/**
 * The terminal UI: a dark, two-voice console — YOU in warm amber, AGENT in
 * cool blue — with live sub-cell meters, history sparklines, session facts,
 * and an event feed. Imperative @opentui/core, like every OpenTUI audio
 * example.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BoxRenderable,
  type CliRenderer,
  createCliRenderer,
  type ParsedKey,
  TextRenderable,
} from "@opentui/core";
import { stateDirectory } from "../config.ts";
import { resolvePlaybackCommand, VoiceAudio } from "./audio.ts";
import { barString, formatClock, levelFromDb, shortId, sparkline } from "./dsp.ts";
import { type TransportPhase, VoiceTransport } from "./transport.ts";

export interface ClientConfig {
  url: string;
  deviceIndex?: number;
  debug: boolean;
}

export class ClientError extends Error {}

const PALETTE = {
  bg: "#0a0d13",
  panel: "#10141d",
  border: "#232a38",
  text: "#cdd6e4",
  dim: "#5c6678",
  you: "#ffb454",
  youDim: "#8a6a3a",
  agent: "#73b8ff",
  agentDim: "#41628c",
  ok: "#7fd88f",
  warn: "#ffd166",
  err: "#f27983",
} as const;

const PHASE_LABEL: Record<TransportPhase, string> = {
  connecting: "connecting",
  "waiting-ready": "waiting for server",
  negotiating: "negotiating voice",
  live: "live",
  reconnecting: "reconnecting",
  failed: "failed — press r",
  stopped: "stopped",
};

interface Meter {
  db: number;
  display: number;
  history: number[];
}

export async function runClient(config: ClientConfig): Promise<void> {
  // ---- preflights: fail with plain text before any screen takeover --------
  if (!resolvePlaybackCommand()) {
    throw new ClientError(
      'sox is required for speaker playback — run "bun run setup" or "brew install sox"',
    );
  }
  let origin: string;
  try {
    const url = new URL(config.url);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new Error(`unsupported protocol ${url.protocol}`);
    }
    origin = `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}/`;
  } catch (error) {
    throw new ClientError(
      `invalid --url ${JSON.stringify(config.url)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const response = await fetch(origin, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch {
    throw new ClientError(
      `voice server not reachable at ${config.url} — start it with: agentvoicenext server`,
    );
  }

  // ---- debug log ----------------------------------------------------------
  let debugLog: ((line: string) => void) | undefined;
  if (config.debug) {
    const stateDir = stateDirectory(process.env, homedir());
    mkdirSync(stateDir, { recursive: true });
    const path = join(stateDir, "client-debug.log");
    debugLog = (line: string) => {
      try {
        appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
      } catch {
        // debug logging must never break the client
      }
    };
    debugLog(`client start url=${config.url}`);
  }

  // ---- state --------------------------------------------------------------
  const mic: Meter = { db: -Infinity, display: 0, history: [] };
  const agent: Meter = { db: -Infinity, display: 0, history: [] };
  const events: { text: string; color: string }[] = [];
  let phase: TransportPhase = "connecting";
  let shuttingDown = false;
  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const feed = (text: string, color: string = PALETTE.dim): void => {
    events.push({ text, color });
    if (events.length > 50) events.shift();
    debugLog?.(`feed: ${text}`);
    refreshStatic();
  };

  // ---- wiring: audio <-> transport ---------------------------------------
  const audio = new VoiceAudio({
    deviceIndex: config.deviceIndex,
    sendFrame: (frame) => transport.sendOpusFrame(frame),
    onMicLevel: (db) => {
      mic.db = db;
    },
    onAgentLevel: (db) => {
      agent.db = db;
    },
    onWarning: (line) => feed(line, PALETTE.warn),
    debug: debugLog,
  });

  const transport = new VoiceTransport({
    url: config.url,
    debug: debugLog,
    onPhase: (next) => {
      phase = next;
      refreshStatic();
    },
    onReady: () => refreshStatic(),
    onRemoteTrack: (track) => audio.attachRemote(track),
    onOaiEvent: (event) => {
      const type = typeof event["type"] === "string" ? event["type"] : "";
      debugLog?.(`oai-event: ${JSON.stringify(event).slice(0, 400)}`);
      if (type === "session.started" || type === "session.created") {
        const session = event["session"] as Record<string, unknown> | undefined;
        const model = typeof session?.["model"] === "string" ? ` · ${session["model"]}` : "";
        feed(`voice session started${model}`);
        return;
      }
      // The v3 session streams finished turns with role + transcript.
      if (type === "turn.done") {
        const turn = event["turn"] as Record<string, unknown> | undefined;
        const transcript =
          typeof turn?.["transcript"] === "string" ? turn["transcript"].trim() : "";
        if (!transcript) return;
        const isUser = turn?.["role"] === "user";
        const line = `${isUser ? "you" : "agent"} · ${transcript.length > 70 ? `${transcript.slice(0, 69)}…` : transcript}`;
        feed(line, isUser ? PALETTE.you : PALETTE.agent);
        return;
      }
      if (type === "error") {
        feed(`upstream: ${JSON.stringify(event).slice(0, 90)}`, PALETTE.err);
      }
    },
    onInfo: (line) => feed(line),
    onError: (line) => feed(line, PALETTE.err),
  });

  // ---- UI -----------------------------------------------------------------
  const renderer: CliRenderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
  });

  const root = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: PALETTE.bg,
    padding: 1,
    gap: 1,
  });
  renderer.root.add(root);

  const header = new BoxRenderable(renderer, {
    height: 3,
    border: true,
    borderStyle: "rounded",
    borderColor: PALETTE.border,
    backgroundColor: PALETTE.panel,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingLeft: 2,
    paddingRight: 2,
  });
  const titleText = new TextRenderable(renderer, {
    content: "◉ AGENTVOICE",
    fg: PALETTE.you,
  });
  const statusText = new TextRenderable(renderer, { content: "", fg: PALETTE.warn });
  const timerText = new TextRenderable(renderer, { content: "--:--", fg: PALETTE.dim });
  header.add(titleText);
  header.add(statusText);
  header.add(timerText);
  root.add(header);

  const meters = new BoxRenderable(renderer, {
    flexGrow: 1,
    flexDirection: "row",
    gap: 1,
  });
  root.add(meters);

  const makePanel = (title: string, onClick: () => void) => {
    const panel = new BoxRenderable(renderer, {
      flexGrow: 1,
      flexBasis: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: PALETTE.border,
      backgroundColor: PALETTE.panel,
      title,
      titleAlignment: "left",
      flexDirection: "column",
      justifyContent: "center",
      paddingLeft: 2,
      paddingRight: 2,
      gap: 1,
      onMouseDown: onClick,
    });
    const bar = new TextRenderable(renderer, { content: "" });
    const spark = new TextRenderable(renderer, { content: "" });
    const caption = new TextRenderable(renderer, { content: "", fg: PALETTE.dim });
    panel.add(bar);
    panel.add(spark);
    panel.add(caption);
    meters.add(panel);
    return { panel, bar, spark, caption };
  };

  const youPanel = makePanel(" YOU ", () => toggleMic());
  const agentPanel = makePanel(" AGENT ", () => toggleSpeaker());

  const sessionBox = new BoxRenderable(renderer, {
    height: 4,
    border: true,
    borderStyle: "rounded",
    borderColor: PALETTE.border,
    backgroundColor: PALETTE.panel,
    title: " session ",
    titleAlignment: "left",
    flexDirection: "row",
    paddingLeft: 2,
    paddingRight: 2,
    gap: 4,
  });
  const sessionLeft = new TextRenderable(renderer, { content: "", fg: PALETTE.dim });
  const sessionRight = new TextRenderable(renderer, { content: "", fg: PALETTE.dim });
  sessionBox.add(sessionLeft);
  sessionBox.add(sessionRight);
  root.add(sessionBox);

  const eventText = new TextRenderable(renderer, { content: "", height: 3, fg: PALETTE.dim });
  root.add(eventText);

  const footerText = new TextRenderable(renderer, { content: "", fg: PALETTE.dim });
  root.add(footerText);

  // ---- view refresh -------------------------------------------------------
  function refreshStatic(): void {
    const info = transport.readyInfo;
    const orDefault = (value: string | null) => value ?? "codex default";
    const primed =
      info && info.prompts.length > 0 ? ` · ${plural(info.prompts.length, "prompt")}` : "";
    sessionLeft.content = info
      ? `thread     ${shortId(info.threadId)}${primed}\nworkspace  ${tail(info.workspace, 34)}`
      : "thread     —\nworkspace  —";
    const renew = transport.renewInMs;
    sessionRight.content = info
      ? `model  ${orDefault(info.model)} · effort ${orDefault(info.effort)}\nvoice  ${orDefault(info.voiceModel)}${info.voice ? ` · ${info.voice}` : ""}${renew !== null ? ` · renew in ${formatClock(renew)}` : ""}`
      : "";
    const recent = events.slice(-3);
    eventText.content = recent.map((e) => `· ${e.text}`).join("\n");
    eventText.fg = recent.at(-1)?.color ?? PALETTE.dim;
    footerText.content = `[m] mic ${audio.micMuted ? "muted" : "live "}   [s] speaker ${audio.speakerMuted ? "muted" : "live "}   [r] redial voice   [q] quit`;
    youPanel.panel.title = audio.micMuted ? " YOU · MUTED " : " YOU ";
    agentPanel.panel.title = audio.speakerMuted ? " AGENT · MUTED " : " AGENT ";
  }

  function tail(path: string, max: number): string {
    return path.length <= max ? path : `…${path.slice(-max + 1)}`;
  }

  function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
  }

  let pulse = 0;
  const frameCallback = async (deltaMs: number): Promise<void> => {
    const dt = deltaMs / 1000;
    pulse += dt;

    for (const meter of [mic, agent]) {
      const level = levelFromDb(meter.db);
      meter.display = Math.max(level, meter.display - dt * 1.6);
      meter.history.push(level);
      if (meter.history.length > 120) meter.history.shift();
    }

    const innerWidth = Math.max(12, youPanel.panel.width - 6);
    const youColor = audio.micMuted ? PALETTE.youDim : PALETTE.you;
    const agentColor = audio.speakerMuted ? PALETTE.agentDim : PALETTE.agent;
    youPanel.bar.content = barString(mic.display, innerWidth);
    youPanel.bar.fg = youColor;
    youPanel.spark.content = sparkline(mic.history, innerWidth);
    youPanel.spark.fg = youColor;
    youPanel.caption.content = captionFor(mic.db, audio.micMuted);
    agentPanel.bar.content = barString(agent.display, innerWidth);
    agentPanel.bar.fg = agentColor;
    agentPanel.spark.content = sparkline(agent.history, innerWidth);
    agentPanel.spark.fg = agentColor;
    agentPanel.caption.content = captionFor(agent.db, audio.speakerMuted);

    const busy =
      phase === "connecting" ||
      phase === "waiting-ready" ||
      phase === "negotiating" ||
      phase === "reconnecting";
    const dotOn = !busy || Math.sin(pulse * 6) > 0;
    const color =
      phase === "live"
        ? PALETTE.ok
        : phase === "failed"
          ? PALETTE.err
          : busy
            ? PALETTE.warn
            : PALETTE.dim;
    statusText.content = `${dotOn ? "●" : "○"} ${PHASE_LABEL[phase]}`;
    statusText.fg = color;

    const live = transport.liveForMs;
    timerText.content = live !== null ? formatClock(live) : "--:--";
    timerText.fg = live !== null ? PALETTE.text : PALETTE.dim;

    if (transport.renewInMs !== null && Math.floor(pulse) % 5 === 0) refreshStatic();
  };

  function captionFor(db: number, muted: boolean): string {
    const dbText = Number.isFinite(db) ? `${db.toFixed(1).padStart(6)} dB` : "  -∞  dB";
    return muted ? `${dbText}   MUTED` : dbText;
  }

  // ---- controls -----------------------------------------------------------
  function toggleMic(): void {
    audio.micMuted = !audio.micMuted;
    feed(audio.micMuted ? "microphone muted" : "microphone live", PALETTE.you);
  }
  function toggleSpeaker(): void {
    audio.speakerMuted = !audio.speakerMuted;
    feed(audio.speakerMuted ? "speaker muted" : "speaker live", PALETTE.agent);
  }

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    debugLog?.("client shutdown");
    renderer.removeFrameCallback(frameCallback);
    renderer.dropLive();
    await audio.stop().catch(() => {});
    await transport.stop().catch(() => {});
    renderer.destroy();
    resolveDone();
  }

  renderer.keyInput.on("keypress", (key: ParsedKey) => {
    if (key.eventType === "release") return;
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      void shutdown();
      return;
    }
    if (key.name === "m") toggleMic();
    else if (key.name === "s") toggleSpeaker();
    else if (key.name === "r") transport.redial("manual");
  });
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  // ---- go -----------------------------------------------------------------
  renderer.setFrameCallback(frameCallback);
  renderer.requestLive();
  refreshStatic();

  try {
    await audio.start();
  } catch (error) {
    await shutdown();
    throw new ClientError(error instanceof Error ? error.message : String(error));
  }
  transport.start();
  feed("connecting to voice server");

  await done;
}
