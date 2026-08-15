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
  ScrollBoxRenderable,
  StyledText,
  TextRenderable,
} from "@opentui/core";
import { clientControlSocketPath, stateDirectory, tokenPath } from "../paths.ts";
import { createFleetFooter } from "../tui/footer.ts";
import { formatClock, levelFromDb, shortId } from "./dsp.ts";
import { DuplexVoiceAudio } from "./duplex-audio.ts";
import { duplexAudioAvailabilityError } from "./duplex-device.ts";
import { ClientControlServer } from "./remote-control.ts";
import { REMOTE_PROTOCOL_VERSION } from "./remote-protocol.ts";
import { SignalField } from "./signal-field.ts";
import {
  boundedViewportExtent,
  boundedViewportSize,
  styledSignalField,
} from "./signal-field-ui.ts";
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
}

export const VOICE_ACTIVITY_PANEL_HEIGHT = 9;

export function voiceActivityHeight(_width: number): number {
  return VOICE_ACTIVITY_PANEL_HEIGHT;
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

function styledFieldLabels(
  width: number,
  youMuted: boolean,
  agentMuted: boolean,
  youColor: string,
  agentColor: string,
): StyledText {
  const left = `YOU ${youMuted ? "× MUTED" : "▷ INPUT"}`;
  const right = `${agentMuted ? "MUTED ×" : "OUTPUT ◁"} AGENT`;
  const clippedRight = right.slice(
    Math.max(0, right.length - Math.max(0, width - left.length - 1)),
  );
  return new StyledText([
    bold(fg(youColor)(left.slice(0, Math.max(0, width - 1)))),
    fg(PALETTE.faint)(
      " ".repeat(Math.max(1, width - Math.min(left.length, width - 1) - clippedRight.length)),
    ),
    bold(fg(agentColor)(clippedRight)),
  ]);
}

function styledFieldReadout(
  width: number,
  youDb: number,
  agentDb: number,
  contact: number,
  youColor: string,
  agentColor: string,
): StyledText {
  const left = dbText(youDb);
  const right = dbText(agentDb);
  const contactText = contact > 0.12 ? ` CONTACT ${Math.min(99, Math.round(contact * 100))}` : "";
  const spare = Math.max(0, width - left.length - right.length);
  const middle = contactText.length + 2 <= spare ? contactText : "";
  const leftGap = Math.max(1, Math.floor((spare - middle.length) / 2));
  const rightGap = Math.max(0, spare - middle.length - leftGap);
  return new StyledText([
    fg(youColor)(left),
    fg(PALETTE.faint)(" ".repeat(leftGap)),
    ...(middle ? [fg(PALETTE.contact)(middle)] : []),
    fg(PALETTE.faint)(" ".repeat(rightGap)),
    fg(agentColor)(right),
  ]);
}

function dbText(db: number): string {
  return Number.isFinite(db) ? `${db.toFixed(1).padStart(6)} dB` : "  -∞  dB";
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
  const mic: Meter = { db: -Infinity };
  const agent: Meter = { db: -Infinity };
  const signalField = new SignalField();
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

  let remoteSequence = 0;
  const remoteControl = new ClientControlServer({
    socketPath: clientControlSocketPath(process.env, homedir()),
    state: () => ({
      type: "state",
      protocol: REMOTE_PROTOCOL_VERSION,
      sequence: remoteSequence++,
      phase,
      mic: { muted: audio.micMuted, level: levelFromDb(mic.db) },
      speaker: { muted: audio.speakerMuted, level: levelFromDb(agent.db) },
    }),
    onCommand: (command) => setMuted(command.target, command.muted),
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
    height: voiceActivityHeight(renderer.width || process.stdout.columns || 100),
    flexShrink: 0,
    flexDirection: "column",
    border: ["left"],
    borderStyle: "single",
    borderColor: PALETTE.accent,
    backgroundColor: PALETTE.panel,
    paddingLeft: 2,
    paddingRight: 2,
    onMouseDown: (event) => {
      const middle = meters.x + meters.width / 2;
      if (event.x < middle) toggleMic();
      else toggleSpeaker();
    },
  });
  main.add(meters);

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
  meters.add(fieldLabels);
  meters.add(fieldCanvas);
  meters.add(fieldReadout);

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

  const eventBox = new ScrollBoxRenderable(renderer, {
    width: "100%",
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 3,
    border: ["top"],
    borderStyle: "single",
    borderColor: PALETTE.border,
    backgroundColor: PALETTE.bg,
    title: " EVENTS ",
    titleColor: PALETTE.dim,
    titleAlignment: "left",
    paddingLeft: 2,
    paddingRight: 2,
    paddingTop: 1,
    stickyScroll: true,
    stickyStart: "bottom",
    scrollX: false,
    scrollY: true,
  });
  const eventRows: TextRenderable[] = [];
  main.add(eventBox);

  const footer = createFleetFooter(
    {
      BoxRenderable,
      ScrollBoxRenderable,
      TextRenderable,
      StyledText,
      bold,
      fg,
    } as typeof import("@opentui/core"),
    renderer,
    "client-footer",
    {
      field: PALETTE.field,
      line: PALETTE.border,
      accent: PALETTE.accent,
      muted: PALETTE.dim,
    },
  );
  root.add(footer.root);

  // ---- view refresh -------------------------------------------------------
  let layoutWidth = 0;

  function refreshStatic(): void {
    const width = renderer.width || process.stdout.columns || 100;
    layoutWidth = width;
    const narrow = width < 104;
    meters.height = voiceActivityHeight(width);
    sessionBox.flexDirection = narrow ? "column" : "row";
    sessionBox.height = narrow ? 7 : 5;
    sessionBox.gap = narrow ? 0 : 4;
    contextText.content = width >= 72 ? " / LIVE AUDIO" : "";
    footer.update({
      width,
      mode: "DUPLEX / 48 KHZ",
      actions: [
        {
          id: "mic",
          key: "M",
          label: `mic ${audio.micMuted ? "muted" : "live"}`,
          shortLabel: "mic",
          onPress: toggleMic,
        },
        {
          id: "speaker",
          key: "S",
          label: `speaker ${audio.speakerMuted ? "muted" : "live"}`,
          shortLabel: "speaker",
          onPress: toggleSpeaker,
        },
        { id: "redial", key: "R", label: "redial", onPress: () => transport.redial("manual") },
        { id: "quit", key: "Q", label: "quit", onPress: () => void shutdown() },
      ],
    });

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
    const rowCount = Math.max(1, events.length);
    while (eventRows.length > rowCount) {
      const row = eventRows.pop();
      if (row) eventBox.remove(row);
    }
    while (eventRows.length < rowCount) {
      const row = new TextRenderable(renderer, {
        id: `event-${eventRows.length}`,
        content: "",
        fg: PALETTE.dim,
      });
      eventRows.push(row);
      eventBox.add(row);
    }
    eventRows.forEach((row, index) => {
      const event = events[index];
      row.content = event === undefined ? "" : `${SIGNAL_GLYPHS.event} ${event.text}`;
      row.fg = event?.color ?? PALETTE.faint;
    });
    const youColor = audio.micMuted ? PALETTE.youDim : PALETTE.you;
    const agentColor = audio.speakerMuted ? PALETTE.agentDim : PALETTE.agent;
    fieldLabels.content = styledFieldLabels(
      Math.max(1, fieldLabels.width),
      audio.micMuted,
      audio.speakerMuted,
      youColor,
      agentColor,
    );
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
    const viewportWidth = renderer.width || process.stdout.columns || 100;
    const viewportHeight = renderer.height || process.stdout.rows || 24;

    const youColor = audio.micMuted ? PALETTE.youDim : PALETTE.you;
    const agentColor = audio.speakerMuted ? PALETTE.agentDim : PALETTE.agent;
    signalField.step(dt, {
      you: levelFromDb(mic.db),
      agent: levelFromDb(agent.db),
      youMuted: audio.micMuted,
      agentMuted: audio.speakerMuted,
    });
    const fieldSize = boundedViewportSize(
      fieldCanvas.width,
      fieldCanvas.height,
      viewportWidth,
      viewportHeight,
    );
    const fieldFrame = signalField.render(fieldSize.width, fieldSize.height, {
      you: audio.micMuted,
      agent: audio.speakerMuted,
    });
    fieldCanvas.content = styledSignalField(fieldFrame, {
      faint: PALETTE.faint,
      dim: PALETTE.dim,
      you: youColor,
      agent: agentColor,
      contact: PALETTE.contact,
    });
    fieldLabels.content = styledFieldLabels(
      boundedViewportExtent(fieldLabels.width, viewportWidth),
      audio.micMuted,
      audio.speakerMuted,
      youColor,
      agentColor,
    );
    fieldReadout.content = styledFieldReadout(
      boundedViewportExtent(fieldReadout.width, viewportWidth),
      mic.db,
      agent.db,
      fieldFrame.contact,
      youColor,
      agentColor,
    );

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

  // ---- controls -----------------------------------------------------------
  function toggleMic(): void {
    setMuted("mic", !audio.micMuted);
  }
  function toggleSpeaker(): void {
    setMuted("speaker", !audio.speakerMuted);
  }
  function setMuted(target: "mic" | "speaker", muted: boolean): void {
    const previous = target === "mic" ? audio.micMuted : audio.speakerMuted;
    if (previous === muted) return;
    if (target === "mic") audio.micMuted = muted;
    else audio.speakerMuted = muted;
    feed(
      `${target === "mic" ? "microphone" : "speaker"} ${muted ? "muted" : "live"}`,
      target === "mic" ? PALETTE.you : PALETTE.agent,
    );
    remoteControl.publish();
  }

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    debugLog?.("client shutdown");
    renderer.removeFrameCallback(frameCallback);
    renderer.dropLive();
    await remoteControl.close().catch(() => {});
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
    await remoteControl.start();
  } catch (error) {
    await shutdown();
    throw new ClientError(
      `could not open client control socket: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

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
