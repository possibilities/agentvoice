/**
 * The terminal UI: the audio display only — one full-viewport Signal Room
 * panel with the live signal field, phase and timer centered on its rows,
 * and every action in the ctrl+k command palette. Narrative events go to
 * the debug log, not the screen.
 */

import { appendFileSync, mkdirSync } from "node:fs";
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
import type { ServerConfig } from "../core/config.ts";
import type { WatchedConfigSource } from "../core/config-watch.ts";
import { VoiceRuntime } from "../core/runtime.ts";
import { consoleControlSocketPath, stateDirectory } from "../paths.ts";
import { createCommandPalette } from "../tui/palette.ts";
import { formatClock, levelFromDb } from "./dsp.ts";
import { DuplexVoiceAudio } from "./duplex-audio.ts";
import { duplexAudioAvailabilityError } from "./duplex-device.ts";
import {
  PUSH_TO_TALK_KEY_LEASE_MS,
  PushToTalkGate,
  type PushToTalkSource,
  pushToTalkKeyAction,
} from "./push-to-talk.ts";
import { ClientControlServer, type RemoteControlPeer } from "./remote-control.ts";
import { REMOTE_PROTOCOL_VERSION } from "./remote-protocol.ts";
import { SignalField } from "./signal-field.ts";
import {
  boundedViewportExtent,
  boundedViewportSize,
  styledSignalField,
} from "./signal-field-ui.ts";
import { SIGNAL_GLYPHS, VOICE_TONES } from "./theme.ts";
import { type TransportPhase, VoiceTransport } from "./transport.ts";

export interface ConsoleOptions {
  deviceIndex?: number;
  outputDeviceIndex?: number;
  debug: boolean;
  /** Abandon the persisted orchestrator agent and start a fresh thread. */
  fresh: boolean;
}

export class ConsoleError extends Error {}

const PALETTE = VOICE_TONES;

const PHASE_LABEL: Record<TransportPhase, string> = {
  "waiting-ready": "WAITING FOR AGENT",
  negotiating: "NEGOTIATING VOICE",
  live: "LIVE",
  failed: "FAILED · R REDIAL",
  stopped: "STOPPED",
};

const COMPACT_PHASE_LABEL: Record<TransportPhase, string> = {
  "waiting-ready": "WAITING",
  negotiating: "NEGOTIATE",
  live: "LIVE",
  failed: "FAILED",
  stopped: "STOPPED",
};

interface Meter {
  db: number;
}

function styledFieldLabels(
  width: number,
  youMuted: boolean,
  youTalking: boolean,
  agentMuted: boolean,
  youColor: string,
  agentColor: string,
  mode = "",
): StyledText {
  const left = `YOU ${youTalking ? `${SIGNAL_GLYPHS.live} TALKING` : youMuted ? "× MUTED" : "▷ INPUT"}`;
  const right = `${agentMuted ? "MUTED ×" : "OUTPUT ◁"} AGENT`;
  const clippedRight = right.slice(
    Math.max(0, right.length - Math.max(0, width - left.length - 1)),
  );
  const clippedLeft = left.slice(0, Math.max(0, width - 1));
  const spare = Math.max(1, width - Math.min(left.length, width - 1) - clippedRight.length);
  const center = mode.length > 0 && spare >= mode.length + 4 ? mode : "";
  if (center.length === 0) {
    return new StyledText([
      bold(fg(youColor)(clippedLeft)),
      fg(PALETTE.faint)(" ".repeat(spare)),
      bold(fg(agentColor)(clippedRight)),
    ]);
  }
  const before = Math.max(1, Math.floor((width - center.length) / 2) - clippedLeft.length);
  const after = Math.max(1, spare - before - center.length);
  return new StyledText([
    bold(fg(youColor)(clippedLeft)),
    fg(PALETTE.faint)(" ".repeat(before)),
    fg(PALETTE.dim)(center),
    fg(PALETTE.faint)(" ".repeat(after)),
    bold(fg(agentColor)(clippedRight)),
  ]);
}

function styledFieldReadout(
  width: number,
  youDb: number,
  agentDb: number,
  youColor: string,
  agentColor: string,
  status?: { text: string; color: string },
): StyledText {
  const left = dbText(youDb);
  const right = dbText(agentDb);
  const spare = Math.max(1, width - left.length - right.length);
  const center = status !== undefined && spare >= status.text.length + 4 ? status : undefined;
  if (center === undefined) {
    return new StyledText([
      fg(youColor)(left),
      fg(PALETTE.faint)(" ".repeat(spare)),
      fg(agentColor)(right),
    ]);
  }
  const before = Math.max(1, Math.floor((width - center.text.length) / 2) - left.length);
  const after = Math.max(1, spare - before - center.text.length);
  return new StyledText([
    fg(youColor)(left),
    fg(PALETTE.faint)(" ".repeat(before)),
    fg(center.color)(center.text),
    fg(PALETTE.faint)(" ".repeat(after)),
    fg(agentColor)(right),
  ]);
}

function dbText(db: number): string {
  return Number.isFinite(db) ? `${db.toFixed(1).padStart(6)} dB` : "  -∞  dB";
}

export async function runConsole(
  config: ServerConfig,
  options: ConsoleOptions,
  version: string,
  configSource?: WatchedConfigSource,
): Promise<void> {
  // ---- preflights: fail with plain text before any screen takeover --------
  const availabilityError = duplexAudioAvailabilityError();
  if (availabilityError) throw new ConsoleError(availabilityError);

  // ---- debug log ----------------------------------------------------------
  let debugLog: ((line: string) => void) | undefined;
  if (options.debug) {
    const stateDir = stateDirectory(process.env, homedir());
    mkdirSync(stateDir, { recursive: true });
    const path = join(stateDir, "console-debug.log");
    debugLog = (line: string) => {
      try {
        appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
      } catch {
        // debug logging must never break the console
      }
    };
    debugLog("console start");
  }

  // ---- state --------------------------------------------------------------
  const mic: Meter = { db: -Infinity };
  const agent: Meter = { db: -Infinity };
  const microphone = new PushToTalkGate();
  const keyboardTalk = Symbol("console-keyboard");
  const pointerTalk = Symbol("console-pointer");
  let keyboardTalkLease: ReturnType<typeof setTimeout> | null = null;
  const signalField = new SignalField();
  let phase: TransportPhase = "waiting-ready";
  let shuttingDown = false;
  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  // The TUI is the audio display only; narrative events go to the debug
  // log, never the screen.
  const feed = (text: string, _color: string = PALETTE.dim): void => {
    debugLog?.(`feed: ${text}`);
  };

  // ---- wiring: audio <-> runtime <-> transport ----------------------------
  const audio = new DuplexVoiceAudio({
    deviceIndex: options.deviceIndex,
    outputDeviceIndex: options.outputDeviceIndex,
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

  // Bind the control socket before the runtime: it doubles as the
  // single-console lock, so a second console fails here — with plain text —
  // before it can touch the shared orchestrator agent.
  let remoteSequence = 0;
  const remoteControl = new ClientControlServer({
    socketPath: consoleControlSocketPath(process.env, homedir()),
    state: () => ({
      type: "state",
      protocol: REMOTE_PROTOCOL_VERSION,
      sequence: remoteSequence++,
      phase,
      mic: {
        muted: microphone.muted,
        talking: microphone.talking,
        level: levelFromDb(mic.db),
      },
      speaker: { muted: audio.speakerMuted, level: levelFromDb(agent.db) },
    }),
    onCommand: (command, peer) => {
      if (command.type === "set-muted") setMuted(command.target, command.muted);
      else setPushToTalk(peer, command.active);
    },
    onPeerClose: (peer) => setPushToTalk(peer, false),
  });
  try {
    await remoteControl.start();
  } catch (error) {
    throw new ConsoleError(
      `could not open the console control socket: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // The runtime boots before the TUI so failures land as plain text — and so
  // does its progress: each stage prints as it starts, so a slow or wedged
  // resident is visible mid-stage instead of a silent blank screen. The same
  // lines replay into the debug log once the screen exists.
  const sink: { transport: VoiceTransport | null } = { transport: null };
  const bufferedStatus: string[] = [];
  console.log("agentvoice: attaching to the resident app-server…");
  let runtime: VoiceRuntime;
  try {
    runtime = await VoiceRuntime.start(
      config,
      version,
      {
        onReady: (info) => sink.transport?.handleReady(info),
        onAnswer: (sdp) => void sink.transport?.handleAnswer(sdp),
        onClosed: (reason) => sink.transport?.handleClosed(reason),
        onRedial: (reason) => sink.transport?.handleRedial(reason),
        onError: (text, fatal) => sink.transport?.handleError(text, fatal),
        onWorker: (worker) => sink.transport?.handleWorker(worker),
        onStatus: (line) => {
          if (sink.transport) {
            feed(line);
          } else {
            console.log(`agentvoice: ${line}`);
            bufferedStatus.push(line);
          }
        },
        debug: debugLog,
      },
      { fresh: options.fresh, ...(configSource ? { configSource } : {}) },
    );
  } catch (error) {
    await remoteControl.close().catch(() => {});
    throw new ConsoleError(error instanceof Error ? error.message : String(error));
  }

  const transport = new VoiceTransport({
    runtime,
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
    useKittyKeyboard: { events: true },
    backgroundColor: PALETTE.bg,
  });

  const root = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: PALETTE.bg,
    onMouseUp: () => setPushToTalk(pointerTalk, false),
  });
  renderer.root.add(root);

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
    flexShrink: 1,
    flexDirection: "column",
    border: ["left"],
    borderStyle: "single",
    borderColor: PALETTE.accent,
    backgroundColor: PALETTE.panel,
    paddingLeft: 2,
    paddingRight: 2,
    onMouseDown: (event) => {
      const middle = meters.x + meters.width / 2;
      if (event.x < middle) setPushToTalk(pointerTalk, true);
      else toggleSpeaker();
    },
    onMouseUp: () => setPushToTalk(pointerTalk, false),
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

  const palette = createCommandPalette(
    {
      BoxRenderable,
      TextRenderable,
      StyledText,
      bold,
      fg,
    } as typeof import("@opentui/core"),
    renderer,
    "client-palette",
    {
      panel: PALETTE.panel,
      line: PALETTE.border,
      accent: PALETTE.accent,
      muted: PALETTE.dim,
      text: PALETTE.text,
    },
  );
  renderer.root.add(palette.root);

  // ---- view refresh -------------------------------------------------------
  let layoutWidth = 0;

  function refreshStatic(): void {
    const width = renderer.width || process.stdout.columns || 100;
    layoutWidth = width;
    palette.update({
      width,
      height: renderer.height || process.stdout.rows || 24,
      commands: [
        {
          id: "mic",
          key: "M",
          label: `mic — ${microphone.muted ? "unmute · hold Space to talk" : "mute"}`,
          onRun: toggleMic,
        },
        {
          id: "speaker",
          key: "S",
          label: `speaker — ${audio.speakerMuted ? "unmute" : "mute"}`,
          onRun: toggleSpeaker,
        },
        {
          id: "redial",
          key: "R",
          label: "redial the voice link",
          onRun: () => transport.redial("manual"),
        },
        {
          id: "fresh",
          key: "F",
          label: "fresh orchestrator thread",
          onRun: () => void runtime.fresh(),
        },
        { id: "quit", key: "Q", label: "quit", onRun: () => void shutdown() },
      ],
    });

    const youMuted = microphone.effectiveMuted;
    const youColor = youMuted ? PALETTE.youDim : PALETTE.you;
    const agentColor = audio.speakerMuted ? PALETTE.agentDim : PALETTE.agent;
    fieldLabels.content = styledFieldLabels(
      Math.max(1, fieldLabels.width),
      youMuted,
      microphone.talking,
      audio.speakerMuted,
      youColor,
      agentColor,
      "DUPLEX / 48 KHZ",
    );
  }

  let pulse = 0;
  const frameCallback = async (deltaMs: number): Promise<void> => {
    const dt = deltaMs / 1000;
    pulse += dt;
    if (renderer.width !== layoutWidth) refreshStatic();
    const viewportWidth = renderer.width || process.stdout.columns || 100;
    const viewportHeight = renderer.height || process.stdout.rows || 24;

    const youMuted = microphone.effectiveMuted;
    const youColor = youMuted ? PALETTE.youDim : PALETTE.you;
    const agentColor = audio.speakerMuted ? PALETTE.agentDim : PALETTE.agent;
    signalField.step(dt, {
      you: levelFromDb(mic.db),
      agent: levelFromDb(agent.db),
      youMuted,
      agentMuted: audio.speakerMuted,
    });
    const fieldSize = boundedViewportSize(
      fieldCanvas.width,
      fieldCanvas.height,
      viewportWidth,
      viewportHeight,
    );
    const fieldFrame = signalField.render(fieldSize.width, fieldSize.height, {
      you: youMuted,
      agent: audio.speakerMuted,
    });
    fieldCanvas.content = styledSignalField(fieldFrame, {
      faint: PALETTE.faint,
      dim: PALETTE.dim,
      you: youColor,
      agent: agentColor,
    });
    fieldLabels.content = styledFieldLabels(
      boundedViewportExtent(fieldLabels.width, viewportWidth),
      youMuted,
      microphone.talking,
      audio.speakerMuted,
      youColor,
      agentColor,
      "DUPLEX / 48 KHZ",
    );
    // With no masthead, the phase and live timer read out from the signal
    // panel itself — the one region already repainting every frame.
    const busy = phase === "waiting-ready" || phase === "negotiating";
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
    const live = transport.liveForMs;
    fieldReadout.content = styledFieldReadout(
      boundedViewportExtent(fieldReadout.width, viewportWidth),
      mic.db,
      agent.db,
      youColor,
      agentColor,
      {
        text: `${dotOn ? SIGNAL_GLYPHS.live : SIGNAL_GLYPHS.idle} ${phaseLabel}${live !== null ? ` ${formatClock(live)}` : ""}`,
        color,
      },
    );
  };

  // ---- controls -----------------------------------------------------------
  function toggleMic(): void {
    setMuted("mic", !microphone.muted);
  }
  function toggleSpeaker(): void {
    setMuted("speaker", !audio.speakerMuted);
  }
  function setMuted(target: "mic" | "speaker", muted: boolean): void {
    const previous = target === "mic" ? microphone.muted : audio.speakerMuted;
    if (previous === muted) return;
    if (target === "mic") {
      microphone.setMuted(muted);
      audio.micMuted = microphone.effectiveMuted;
    } else {
      audio.speakerMuted = muted;
    }
    feed(
      `${target === "mic" ? "microphone" : "speaker"} ${muted ? "muted" : "live"}`,
      target === "mic" ? PALETTE.you : PALETTE.agent,
    );
    // The palette's mute/unmute labels live in refreshStatic, which no
    // longer runs on every feed line.
    refreshStatic();
    remoteControl.publish();
  }

  function setPushToTalk(source: PushToTalkSource | RemoteControlPeer, active: boolean): void {
    const changed = active ? microphone.begin(source) : microphone.end(source);
    if (!changed) return;
    audio.micMuted = microphone.effectiveMuted;
    feed(
      `microphone ${microphone.talking ? "talking" : microphone.effectiveMuted ? "muted" : "live"}`,
      PALETTE.you,
    );
    refreshStatic();
    remoteControl.publish();
  }

  function renewKeyboardTalk(): void {
    if (!microphone.muted) return;
    setPushToTalk(keyboardTalk, true);
    if (keyboardTalkLease) clearTimeout(keyboardTalkLease);
    keyboardTalkLease = setTimeout(() => {
      keyboardTalkLease = null;
      setPushToTalk(keyboardTalk, false);
    }, PUSH_TO_TALK_KEY_LEASE_MS);
    keyboardTalkLease.unref?.();
  }

  function endKeyboardTalk(): void {
    if (keyboardTalkLease) clearTimeout(keyboardTalkLease);
    keyboardTalkLease = null;
    setPushToTalk(keyboardTalk, false);
  }

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    if (keyboardTalkLease) clearTimeout(keyboardTalkLease);
    keyboardTalkLease = null;
    audio.micMuted = true;
    debugLog?.("console shutdown");
    renderer.removeFrameCallback(frameCallback);
    renderer.dropLive();
    await remoteControl.close().catch(() => {});
    await audio.stop().catch(() => {});
    await transport.stop().catch(() => {});
    await runtime.shutdown().catch(() => {});
    renderer.destroy();
    resolveDone();
  }

  renderer.keyInput.on("keypress", (key: ParsedKey) => {
    const talkAction = pushToTalkKeyAction(key, palette.isOpen());
    if (talkAction === "end") {
      endKeyboardTalk();
      return;
    }
    if (palette.handleKey(key)) return;
    if (talkAction === "renew") {
      renewKeyboardTalk();
      return;
    }
    if (key.name === "space") {
      return;
    }
    if (key.eventType !== "press") return;
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      void shutdown();
      return;
    }
    if (key.name === "m") toggleMic();
    else if (key.name === "s") toggleSpeaker();
    else if (key.name === "r") transport.redial("manual");
    else if (key.name === "f") void runtime.fresh();
  });
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  renderer.keyInput.on("keyrelease", (key: ParsedKey) => {
    if (pushToTalkKeyAction(key, palette.isOpen()) === "end") endKeyboardTalk();
  });

  // ---- go -----------------------------------------------------------------
  renderer.setFrameCallback(frameCallback);
  renderer.requestLive();
  refreshStatic();
  sink.transport = transport;
  for (const line of bufferedStatus) feed(line);
  bufferedStatus.length = 0;
  for (const worker of runtime.workerSnapshots()) transport.handleWorker(worker);

  try {
    await audio.start();
  } catch (error) {
    await shutdown();
    throw new ConsoleError(error instanceof Error ? error.message : String(error));
  }
  transport.start();

  await done;
}
