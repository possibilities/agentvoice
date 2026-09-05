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
import type { ReadyInfo, VoicePhase } from "../core/voice-types.ts";
import { createCommandPalette } from "../tui/palette.ts";
import {
  AUDIO_CONTROL_KITTY_KEYBOARD,
  type AudioTarget,
  audioControlKeyAction,
  KEY_HOLD_LEASE_MS,
  spaceControlKeyAction,
} from "./audio-control.ts";
import { levelFromDb } from "./dsp.ts";
import { mixHex, SignalField } from "./signal-field.ts";
import {
  boundedViewportSize,
  conversationLines,
  instrumentRuns,
  pttRowCount,
  signalFieldStatus,
  styledInstrumentField,
} from "./signal-field-ui.ts";
import { VOICE_TONES } from "./theme.ts";

const PALETTE = VOICE_TONES;

/** The instrument text renders translucent over the field — fixed, never fading. */
const OVERLAY_ALPHA = 0.75;
/** A muted voice keeps animating, its strands sunk most of the way into the panel. */
const MUTED_STRAND_ALPHA = 0.55;

export type VoiceTuiInput = "pointer" | "space";

export interface VoiceTuiChannelState {
  muted: boolean;
  effectiveMuted: boolean;
  db: number;
}

export interface VoiceTuiState {
  /** False once the foreground host has closed. */
  available: boolean;
  phase: VoicePhase;
  liveForMs: number | null;
  workTier?: string;
  notice?: string;
  workspace?: string;
  conversation?: ReadyInfo;
  mic: VoiceTuiChannelState;
  speaker: VoiceTuiChannelState;
}

export interface VoiceTuiHost {
  state(): VoiceTuiState;
  setMuted(target: AudioTarget, muted: boolean): void;
  beginUnmute(target: AudioTarget, input: VoiceTuiInput): void;
  releaseUnmute(target: AudioTarget, input: VoiceTuiInput): void;
  redial(): void;
  fresh(): void;
  shutdown(): void | Promise<void>;
}

export interface VoiceTuiOptions {
  createRenderer?(): Promise<CliRenderer>;
}

export interface VoiceTui {
  readonly done: Promise<void>;
  refresh(): void;
  cancelInputs(): void;
  shutdown(): Promise<void>;
}

/** The foreground voice instrument. */
export async function createVoiceTui(
  host: VoiceTuiHost,
  options: VoiceTuiOptions = {},
): Promise<VoiceTui> {
  const renderer: CliRenderer = options.createRenderer
    ? await options.createRenderer()
    : await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 30,
        screenMode: "alternate-screen",
        useKittyKeyboard: AUDIO_CONTROL_KITTY_KEYBOARD,
        backgroundColor: PALETTE.bg,
      });

  const root = new BoxRenderable(renderer, {
    id: "voice-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: PALETTE.bg,
    onMouseUp: () => endPushToTalk(),
    onMouseDragEnd: () => endPushToTalk(),
  });
  renderer.root.add(root);

  const main = new BoxRenderable(renderer, {
    id: "voice-main",
    width: "100%",
    flexGrow: 1,
    flexDirection: "column",
    backgroundColor: PALETTE.bg,
  });
  root.add(main);

  // Touch zones tile the whole field, one function each: while the mic is
  // muted a bottom band holds it open (push-to-talk, never a toggle);
  // everything else splits into the mic and speaker mute toggles.
  const rails = new BoxRenderable(renderer, {
    id: "voice-rails",
    width: "100%",
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "column",
    minHeight: 7,
    backgroundColor: PALETTE.panel,
    onMouseDown: (event) => {
      const height = Math.max(1, rails.height);
      if (persistentMuted("mic") === true && event.y >= rails.y + height - pttRowCount(height)) {
        beginPushToTalk();
        return;
      }
      const middle = rails.x + rails.width / 2;
      toggle(event.x < middle ? "mic" : "speaker");
    },
    onMouseUp: () => endPushToTalk(),
    onMouseDragEnd: () => endPushToTalk(),
  });
  const fieldCanvas = new TextRenderable(renderer, {
    id: "voice-field-canvas",
    content: "",
    flexGrow: 1,
    wrapMode: "none",
    fg: PALETTE.faint,
    selectable: false,
  });
  rails.add(fieldCanvas);
  main.add(rails);

  const palette = createCommandPalette(
    {
      BoxRenderable,
      TextRenderable,
      StyledText,
      bold,
      fg,
    } as typeof import("@opentui/core"),
    renderer,
    "voice-palette",
    {
      panel: PALETTE.panel,
      line: PALETTE.border,
      accent: PALETTE.accent,
      muted: PALETTE.dim,
      text: PALETTE.text,
    },
  );
  renderer.root.add(palette.root);

  // A quiet, terminal-native touch target exposes the command palette on
  // pointer-first hosts without turning the ctrl+k convention into chrome.
  const commandTrigger = new BoxRenderable(renderer, {
    id: "voice-command-trigger",
    position: "absolute",
    zIndex: 20,
    top: 0,
    right: 0,
    width: 7,
    height: 3,
    alignItems: "center",
    justifyContent: "center",
    onMouseDown: (event) => {
      event.stopPropagation();
      event.preventDefault();
      if (!palette.isOpen()) {
        cancelInputs();
        palette.open();
      }
    },
    onMouseUp: (event) => {
      event.stopPropagation();
      event.preventDefault();
    },
  });
  commandTrigger.add(
    new TextRenderable(renderer, {
      id: "voice-command-trigger-mark",
      content: "···",
      height: 1,
      wrapMode: "none",
      fg: PALETTE.dim,
      selectable: false,
    }),
  );
  renderer.root.add(commandTrigger);

  // Persistent, wrapped explanation; no consent controls or invented answers.
  const noticePanel = new BoxRenderable(renderer, {
    id: "voice-notice-panel",
    position: "absolute",
    top: 5,
    left: 0,
    right: 0,
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: PALETTE.panel,
  });
  const notice = new TextRenderable(renderer, {
    id: "voice-notice",
    width: "100%",
    content: "",
    fg: PALETTE.agent,
    bg: PALETTE.panel,
    selectable: false,
  });
  noticePanel.add(notice);
  renderer.root.add(noticePanel);

  let pttHeld = false;
  let spaceLease: ReturnType<typeof setTimeout> | null = null;
  let layoutWidth = 0;
  let layoutHeight = 0;
  let pulse = 0;
  let closed = false;
  let shutdownPromise: Promise<void> | null = null;
  const signalField = new SignalField();
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  function refresh(): void {
    if (closed) return;
    const width = renderer.width || process.stdout.columns || 40;
    const height = renderer.height || process.stdout.rows || 24;
    const state = host.state();
    notice.content = state.notice ?? "";
    noticePanel.visible = !!state.notice;
    noticePanel.top = height < 12 ? 1 : 5;
    layoutWidth = width;
    layoutHeight = height;
    rails.minHeight = height < 9 ? 4 : 7;
    palette.update({
      width,
      height,
      commands: [
        {
          id: "mic",
          key: "M",
          label: `mic — ${state.mic.muted ? "unmute · Space holds to talk" : "mute"}`,
          onRun: () => toggle("mic"),
        },
        {
          id: "speaker",
          key: "S",
          label: `speaker — ${state.speaker.muted ? "unmute" : "mute"}`,
          onRun: () => toggle("speaker"),
        },
        {
          id: "redial",
          key: "R",
          label: "redial the voice link",
          onRun: () => host.redial(),
        },
        {
          id: "fresh",
          key: "F",
          label: "fresh conversation",
          onRun: () => host.fresh(),
        },
        { id: "quit", key: "Q", label: "quit", onRun: () => void shutdown() },
      ],
    });
    renderer.requestRender();
  }

  function persistentMuted(target: AudioTarget): boolean | null {
    const state = host.state();
    if (!state.available) return null;
    return target === "mic" ? state.mic.muted : state.speaker.muted;
  }

  function toggle(target: AudioTarget): void {
    const muted = persistentMuted(target);
    if (muted === null) return;
    host.setMuted(target, !muted);
    refresh();
  }

  /** The push-to-talk band only holds a muted mic open; release never commits a toggle. */
  function beginPushToTalk(): void {
    if (pttHeld) return;
    if (persistentMuted("mic") !== true) return;
    pttHeld = true;
    host.beginUnmute("mic", "pointer");
    refresh();
  }

  function endPushToTalk(): void {
    if (!pttHeld) return;
    pttHeld = false;
    host.releaseUnmute("mic", "pointer");
    refresh();
  }

  function renewSpaceControl(begin: boolean): void {
    // Repeats only renew a live hold. After a lost-release timeout, require
    // another press rather than reopening the microphone on a stray repeat.
    if (!spaceLease && (!begin || persistentMuted("mic") !== true)) return;
    if (spaceLease) clearTimeout(spaceLease);
    else host.beginUnmute("mic", "space");
    spaceLease = setTimeout(endSpaceControl, KEY_HOLD_LEASE_MS);
    spaceLease.unref?.();
    refresh();
  }

  function endSpaceControl(): void {
    if (!spaceLease) return;
    clearTimeout(spaceLease);
    spaceLease = null;
    host.releaseUnmute("mic", "space");
    refresh();
  }

  function cancelInputs(): void {
    endSpaceControl();
    endPushToTalk();
  }

  const frameCallback = async (deltaMs: number): Promise<void> => {
    const dt = deltaMs / 1000;
    pulse += dt;
    if (renderer.width !== layoutWidth || renderer.height !== layoutHeight) refresh();
    const viewportWidth = renderer.width || process.stdout.columns || 40;
    const viewportHeight = renderer.height || process.stdout.rows || 24;
    const state = host.state();
    const micMuted = state.mic.effectiveMuted;
    const micTalking = state.mic.muted && !micMuted;
    const agentMuted = state.speaker.effectiveMuted;
    signalField.step(dt, {
      you: state.available ? levelFromDb(state.mic.db) : 0,
      agent: state.available ? levelFromDb(state.speaker.db) : 0,
    });
    const fieldSize = boundedViewportSize(
      fieldCanvas.width,
      fieldCanvas.height,
      viewportWidth,
      viewportHeight,
    );
    const frame = signalField.render(fieldSize.width, fieldSize.height, {
      you: micMuted,
      agent: agentMuted,
    });
    const youFieldColor = micMuted
      ? mixHex(PALETTE.panel, PALETTE.youDim, MUTED_STRAND_ALPHA)
      : PALETTE.you;
    const agentFieldColor = agentMuted
      ? mixHex(PALETTE.panel, PALETTE.agentDim, MUTED_STRAND_ALPHA)
      : PALETTE.agent;
    const youLabelColor = micMuted ? PALETTE.youDim : PALETTE.you;
    const agentLabelColor = agentMuted ? PALETTE.agentDim : PALETTE.agent;
    const runs = instrumentRuns(
      fieldSize.width,
      fieldSize.height,
      signalFieldStatus(state.phase, state.liveForMs, renderer.width, pulse, state.workTier),
      { muted: state.mic.muted, talking: micTalking, color: youLabelColor, db: state.mic.db },
      { muted: agentMuted, color: agentLabelColor, db: state.speaker.db },
      state.mic.muted,
      fieldSize.height >= 12
        ? conversationLines(state.workspace, state.conversation, fieldSize.width)
        : [],
    ).map((run) => ({ ...run, color: mixHex(PALETTE.panel, run.color, OVERLAY_ALPHA) }));
    fieldCanvas.content = styledInstrumentField(
      frame,
      { faint: PALETTE.faint, dim: PALETTE.dim, you: youFieldColor, agent: agentFieldColor },
      runs,
      fieldSize.height >= 12 ? [0, 1, 2, 3] : [0],
    );
  };

  function shutdown(): Promise<void> {
    shutdownPromise ??= (async () => {
      cancelInputs();
      closed = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      renderer.removeFrameCallback(frameCallback);
      renderer.dropLive();
      try {
        await host.shutdown();
      } finally {
        renderer.destroy();
        resolveDone();
      }
    })();
    return shutdownPromise;
  }

  const onSignal = (): void => {
    void shutdown();
  };

  renderer.keyInput.on("keypress", (key: ParsedKey) => {
    const spaceAction = spaceControlKeyAction(key, palette.isOpen());
    const controlAction = audioControlKeyAction(key, palette.isOpen());
    if (spaceAction === "end") {
      endSpaceControl();
      return;
    }
    if (palette.handleKey(key)) {
      if (palette.isOpen()) cancelInputs();
      return;
    }
    if (spaceAction) {
      renewSpaceControl(spaceAction === "begin");
      return;
    }
    if (controlAction) {
      toggle(controlAction.target);
      return;
    }
    if (key.name === "space" || key.eventType !== "press" || key.repeated) return;
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      void shutdown();
      return;
    }
    if (key.name === "r") host.redial();
    else if (key.name === "f") host.fresh();
  });
  renderer.keyInput.on("keyrelease", (key: ParsedKey) => {
    if (spaceControlKeyAction(key, palette.isOpen()) === "end") endSpaceControl();
  });
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  renderer.setFrameCallback(frameCallback);
  renderer.requestLive();
  refresh();

  return { done, refresh, cancelInputs, shutdown };
}
