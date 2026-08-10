/**
 * The terminal UI: a Signal Room instrument panel with local and remote
 * signal rails, live sub-cell meters, session facts, and an event feed.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
import { stateDirectory, tokenPath } from "../paths.ts";
import { barString, formatClock, levelFromDb, shortId, sparkline } from "./dsp.ts";
import { DuplexVoiceAudio } from "./duplex-audio.ts";
import { duplexAudioAvailabilityError } from "./duplex-device.ts";
import { SIGNAL_GLYPHS, VOICE_TONES } from "./theme.ts";
import { type TransportPhase, VoiceTransport } from "./transport.ts";

export interface ClientConfig {
  url: string;
  /** Connection token; defaults to the server-written token file. */
  token?: string;
  deviceIndex?: number;
  outputDeviceIndex?: number;
  debug: boolean;
}

export class ClientError extends Error {}

function readTokenFile(): string | undefined {
  try {
    const token = readFileSync(tokenPath(process.env, homedir()), "utf8").trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

const PALETTE = VOICE_TONES;

const PHASE_LABEL: Record<TransportPhase, string> = {
  connecting: "CONNECTING",
  "waiting-ready": "WAITING FOR SERVER",
  negotiating: "NEGOTIATING VOICE",
  live: "LIVE",
  reconnecting: "RECONNECTING",
  failed: "FAILED · R REDIAL",
  stopped: "STOPPED",
};

const COMPACT_PHASE_LABEL: Record<TransportPhase, string> = {
  connecting: "CONNECT",
  "waiting-ready": "WAITING",
  negotiating: "NEGOTIATE",
  live: "LIVE",
  reconnecting: "RECONNECT",
  failed: "FAILED",
  stopped: "STOPPED",
};

interface Meter {
  db: number;
  display: number;
  history: number[];
}

function styledFacts(rows: ReadonlyArray<readonly [label: string, value: string]>): StyledText {
  const chunks: ReturnType<typeof bold>[] = [];
  rows.forEach(([label, value], index) => {
    chunks.push(fg(PALETTE.dim)(label.padEnd(11)));
    chunks.push(fg(PALETTE.text)(value));
    if (index < rows.length - 1) chunks.push(fg(PALETTE.text)("\n"));
  });
  return new StyledText(chunks);
}

function styledKeybar(entries: ReadonlyArray<readonly [key: string, label: string]>): StyledText {
  const chunks: ReturnType<typeof bold>[] = [];
  entries.forEach(([key, label], index) => {
    chunks.push(bold(fg(PALETTE.accent)(`[${key}]`)));
    chunks.push(fg(PALETTE.dim)(` ${label}${index < entries.length - 1 ? "  " : ""}`));
  });
  return new StyledText(chunks);
}

export async function runClient(config: ClientConfig): Promise<void> {
  // ---- preflights: fail with plain text before any screen takeover --------
  const availabilityError = duplexAudioAvailabilityError();
  if (availabilityError) throw new ClientError(availabilityError);
  let origin: string;
  let wsUrl: string;
  try {
    const url = new URL(config.url);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new Error(`unsupported protocol ${url.protocol}`);
    }
    origin = `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}/`;
    // Missing token is not an error here: the server answers 4401 with a
    // message that says what to do, and older servers ignore the parameter.
    const token = config.token ?? readTokenFile();
    if (token !== undefined && !url.searchParams.has("token")) {
      url.searchParams.set("token", token);
    }
    wsUrl = url.toString();
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
      `voice server not reachable at ${config.url} — start it with: agentvoice server`,
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
  const audio = new DuplexVoiceAudio({
    deviceIndex: config.deviceIndex,
    outputDeviceIndex: config.outputDeviceIndex,
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
    url: wsUrl,
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
    onWorker: (worker) => {
      const seconds =
        worker.finishedAt === undefined
          ? ""
          : ` (${Math.max(0, Math.round((worker.finishedAt - worker.startedAt) / 1000))}s)`;
      feed(
        `worker ${worker.id} · ${worker.title} — ${worker.status}${seconds}`,
        worker.status === "failed" || worker.status === "lost" ? PALETTE.warn : PALETTE.agent,
      );
    },
    onInfo: (line) => feed(line),
    onError: (line) => feed(line, PALETTE.err),
  });

  // ---- UI -----------------------------------------------------------------
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
    paddingLeft: 2,
    paddingRight: 2,
  });
  const brand = new BoxRenderable(renderer, {
    flexDirection: "row",
    alignItems: "center",
    gap: 1,
    backgroundColor: PALETTE.field,
  });
  const railText = new TextRenderable(renderer, {
    content: SIGNAL_GLYPHS.rail,
    fg: PALETTE.accent,
  });
  const titleText = new TextRenderable(renderer, {
    content: new StyledText([bold(fg(PALETTE.text)("AGENTVOICE"))]),
  });
  const contextText = new TextRenderable(renderer, { content: " / LIVE AUDIO", fg: PALETTE.dim });
  brand.add(railText);
  brand.add(titleText);
  brand.add(contextText);

  const phaseCluster = new BoxRenderable(renderer, {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    backgroundColor: PALETTE.field,
  });
  const statusText = new TextRenderable(renderer, { content: "", fg: PALETTE.warn });
  const timerText = new TextRenderable(renderer, { content: "--:--", fg: PALETTE.dim });
  phaseCluster.add(statusText);
  phaseCluster.add(timerText);
  header.add(brand);
  header.add(phaseCluster);
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

  const meters = new BoxRenderable(renderer, {
    flexGrow: 1,
    flexDirection: "row",
    gap: 1,
    backgroundColor: PALETTE.bg,
  });
  main.add(meters);

  const makePanel = (labelText: string, color: string, onClick: () => void) => {
    const panel = new BoxRenderable(renderer, {
      flexGrow: 1,
      flexBasis: 1,
      border: ["left"],
      borderStyle: "single",
      borderColor: color,
      backgroundColor: PALETTE.panel,
      flexDirection: "column",
      justifyContent: "center",
      paddingLeft: 2,
      paddingRight: 2,
      gap: 1,
      onMouseDown: onClick,
    });
    const label = new TextRenderable(renderer, { content: labelText, fg: color });
    const bar = new TextRenderable(renderer, { content: "" });
    const spark = new TextRenderable(renderer, { content: "" });
    const caption = new TextRenderable(renderer, { content: "", fg: PALETTE.dim });
    panel.add(label);
    panel.add(bar);
    panel.add(spark);
    panel.add(caption);
    meters.add(panel);
    return { panel, label, bar, spark, caption };
  };

  const youPanel = makePanel("INPUT / YOU", PALETTE.you, () => toggleMic());
  const agentPanel = makePanel("OUTPUT / AGENT", PALETTE.agent, () => toggleSpeaker());

  const sessionBox = new BoxRenderable(renderer, {
    width: "100%",
    height: 5,
    border: ["top"],
    borderStyle: "single",
    borderColor: PALETTE.border,
    backgroundColor: PALETTE.field,
    title: " SESSION ",
    titleColor: PALETTE.dim,
    titleAlignment: "left",
    flexDirection: "row",
    paddingLeft: 2,
    paddingRight: 2,
    paddingTop: 1,
    gap: 4,
  });
  const sessionLeft = new TextRenderable(renderer, {
    content: "",
    fg: PALETTE.dim,
    flexGrow: 1,
    flexBasis: 1,
  });
  const sessionRight = new TextRenderable(renderer, {
    content: "",
    fg: PALETTE.dim,
    flexGrow: 1,
    flexBasis: 1,
  });
  sessionBox.add(sessionLeft);
  sessionBox.add(sessionRight);
  main.add(sessionBox);

  const eventBox = new BoxRenderable(renderer, {
    width: "100%",
    height: 5,
    border: ["top"],
    borderStyle: "single",
    borderColor: PALETTE.border,
    backgroundColor: PALETTE.bg,
    title: " EVENTS ",
    titleColor: PALETTE.dim,
    titleAlignment: "left",
    flexDirection: "column",
    paddingLeft: 2,
    paddingRight: 2,
    paddingTop: 1,
  });
  const eventRows = Array.from(
    { length: 3 },
    (_, index) =>
      new TextRenderable(renderer, { id: `event-${index}`, content: "", fg: PALETTE.dim }),
  );
  for (const row of eventRows) eventBox.add(row);
  main.add(eventBox);

  const footer = new BoxRenderable(renderer, {
    width: "100%",
    height: 3,
    border: ["top"],
    borderStyle: "single",
    borderColor: PALETTE.border,
    backgroundColor: PALETTE.field,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingLeft: 2,
    paddingRight: 2,
  });
  const footerText = new TextRenderable(renderer, { content: "", fg: PALETTE.dim });
  const footerMode = new TextRenderable(renderer, { content: "DUPLEX / 48 KHZ", fg: PALETTE.dim });
  footer.add(footerText);
  footer.add(footerMode);
  root.add(footer);

  // ---- view refresh -------------------------------------------------------
  let layoutWidth = 0;

  function refreshStatic(): void {
    const width = renderer.width || process.stdout.columns || 100;
    layoutWidth = width;
    const narrow = width < 104;
    meters.flexDirection = width < 68 ? "column" : "row";
    sessionBox.flexDirection = narrow ? "column" : "row";
    sessionBox.height = narrow ? 7 : 5;
    sessionBox.gap = narrow ? 0 : 4;
    contextText.content = width >= 72 ? " / LIVE AUDIO" : "";
    footerMode.content = width >= 92 ? "DUPLEX / 48 KHZ" : "";

    const info = transport.readyInfo;
    const orDefault = (value: string | null) => value ?? "codex default";
    const primed =
      info && info.prompts.length > 0 ? ` · ${plural(info.prompts.length, "prompt")}` : "";
    sessionLeft.content = styledFacts(
      info
        ? [
            ["thread", `${shortId(info.threadId)}${primed}`],
            ["workspace", tail(info.workspace, narrow ? Math.max(20, width - 20) : 34)],
          ]
        : [
            ["thread", "—"],
            ["workspace", "—"],
          ],
    );
    const renew = transport.renewInMs;
    sessionRight.content = styledFacts(
      info
        ? [
            ["model", `${orDefault(info.model)} · effort ${orDefault(info.effort)}`],
            [
              "voice",
              `${orDefault(info.voiceModel)}${info.voice ? ` · ${info.voice}` : ""}${renew !== null ? ` · renew in ${formatClock(renew)}` : ""}`,
            ],
          ]
        : [],
    );
    const recent = events.slice(-3);
    const visibleEvents: Array<{ text: string; color: string } | undefined> = [
      ...Array.from({ length: 3 - recent.length }, () => undefined),
      ...recent,
    ];
    eventRows.forEach((row, index) => {
      const event = visibleEvents[index];
      row.content = event === undefined ? "" : `${SIGNAL_GLYPHS.event} ${event.text}`;
      row.fg = event?.color ?? PALETTE.faint;
    });
    footerText.content = styledKeybar([
      ["M", narrow ? "mic" : `mic ${audio.micMuted ? "muted" : "live"}`],
      ["S", narrow ? "speaker" : `speaker ${audio.speakerMuted ? "muted" : "live"}`],
      ["R", "redial"],
      ["Q", "quit"],
    ]);
    const youColor = audio.micMuted ? PALETTE.youDim : PALETTE.you;
    const agentColor = audio.speakerMuted ? PALETTE.agentDim : PALETTE.agent;
    youPanel.label.content = audio.micMuted ? "INPUT / YOU · MUTED" : "INPUT / YOU";
    youPanel.label.fg = youColor;
    youPanel.panel.borderColor = youColor;
    agentPanel.label.content = audio.speakerMuted ? "OUTPUT / AGENT · MUTED" : "OUTPUT / AGENT";
    agentPanel.label.fg = agentColor;
    agentPanel.panel.borderColor = agentColor;
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
    if (renderer.width !== layoutWidth) refreshStatic();

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
    const phaseLabel = renderer.width < 64 ? COMPACT_PHASE_LABEL[phase] : PHASE_LABEL[phase];
    statusText.content = `${dotOn ? SIGNAL_GLYPHS.live : SIGNAL_GLYPHS.idle} ${phaseLabel}`;
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
