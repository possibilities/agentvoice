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
import { createCommandPalette } from "../tui/palette.ts";
import {
  AUDIO_CONTROL_KITTY_KEYBOARD,
  type AudioTarget,
  audioControlKeyAction,
  KEY_HOLD_LEASE_MS,
  releaseCommitsClick,
  spaceControlKeyAction,
  UnmuteHoldLabel,
} from "./audio-control.ts";
import { levelFromDb } from "./dsp.ts";
import { SignalField } from "./signal-field.ts";
import {
  boundedViewportExtent,
  boundedViewportSize,
  signalFieldStatus,
  styledSignalField,
  styledSignalLabels,
  styledSignalReadout,
} from "./signal-field-ui.ts";
import { VOICE_TONES } from "./theme.ts";
import type { TransportPhase } from "./transport.ts";

const PALETTE = VOICE_TONES;

export type VoiceTuiInput = "pointer" | "key" | "space";

export interface VoiceTuiChannelState {
  muted: boolean;
  effectiveMuted: boolean;
  db: number;
}

export interface VoiceTuiState {
  /** False while a Remote console has no current Console state. */
  available: boolean;
  phase: TransportPhase;
  liveForMs: number | null;
  mic: VoiceTuiChannelState;
  speaker: VoiceTuiChannelState;
}

export interface VoiceTuiHost {
  state(): VoiceTuiState;
  setMuted(target: AudioTarget, muted: boolean): void;
  beginUnmute(target: AudioTarget, input: VoiceTuiInput): void;
  releaseUnmute(target: AudioTarget, input: VoiceTuiInput, commit: boolean): void;
  redial(): void;
  fresh(): void;
  shutdown(): void | Promise<void>;
}

export interface VoiceTuiOptions {
  createRenderer?(): Promise<CliRenderer>;
  now?(): number;
}

export interface VoiceTui {
  readonly done: Promise<void>;
  refresh(): void;
  cancelInputs(): void;
  shutdown(): Promise<void>;
}

/** One instrument shared by the Console and Remote console hosts. */
export async function createVoiceTui(
  host: VoiceTuiHost,
  options: VoiceTuiOptions = {},
): Promise<VoiceTui> {
  const now = options.now ?? (() => performance.now());
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
    onMouseUp: () => endPointerControl(),
    onMouseDragEnd: () => endPointerControl(),
  });
  renderer.root.add(root);

  const main = new BoxRenderable(renderer, {
    id: "voice-main",
    width: "100%",
    flexGrow: 1,
    flexDirection: "column",
    padding: 1,
    gap: 1,
    backgroundColor: PALETTE.bg,
  });
  root.add(main);

  const rails = new BoxRenderable(renderer, {
    id: "voice-rails",
    width: "100%",
    flexGrow: 1,
    flexShrink: 1,
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
      beginPointerControl(event.x < middle ? "mic" : "speaker");
    },
    onMouseUp: () => endPointerControl(),
    onMouseDragEnd: () => endPointerControl(),
  });
  const fieldLabels = new TextRenderable(renderer, { content: "", height: 1, wrapMode: "none" });
  const fieldCanvas = new TextRenderable(renderer, {
    id: "voice-field-canvas",
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

  let pointerGesture: {
    target: AudioTarget;
    startedAt: number;
    startedMuted: boolean;
  } | null = null;
  const keyControlGestures = new Map<
    AudioTarget,
    {
      startedAt: number;
      startedMuted: boolean;
      clickEligible: boolean;
      lease: ReturnType<typeof setTimeout>;
    }
  >();
  let spaceGesture: {
    startedAt: number;
    startedMuted: boolean;
    clickEligible: boolean;
    lease: ReturnType<typeof setTimeout>;
  } | null = null;
  let layoutWidth = 0;
  let layoutHeight = 0;
  let pulse = 0;
  let closed = false;
  let shutdownPromise: Promise<void> | null = null;
  const signalField = new SignalField();
  const micHoldLabel = new UnmuteHoldLabel();
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  function refresh(): void {
    if (closed) return;
    const width = renderer.width || process.stdout.columns || 40;
    const height = renderer.height || process.stdout.rows || 24;
    const state = host.state();
    layoutWidth = width;
    layoutHeight = height;
    const short = height < 9;
    main.paddingTop = short ? 0 : 1;
    main.paddingBottom = short ? 0 : 1;
    rails.minHeight = short ? 4 : 7;
    palette.update({
      width,
      height,
      commands: [
        {
          id: "mic",
          key: "M",
          label: `mic — ${state.mic.muted ? "unmute · hold M/Space" : "mute on release"}`,
          onRun: () => toggle("mic"),
        },
        {
          id: "speaker",
          key: "S",
          label: `speaker — ${state.speaker.muted ? "unmute · hold S" : "mute on release"}`,
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
          label: "fresh orchestrator thread",
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

  function beginPointerControl(target: AudioTarget): void {
    if (pointerGesture) endPointerControl(false);
    const muted = persistentMuted(target);
    if (muted === null) return;
    pointerGesture = { target, startedAt: now(), startedMuted: muted };
    if (muted) host.beginUnmute(target, "pointer");
    refresh();
  }

  function endPointerControl(classifyClick = true): void {
    const gesture = pointerGesture;
    if (!gesture) return;
    pointerGesture = null;
    if (gesture.startedMuted) {
      const commit = classifyClick && releaseCommitsClick(gesture.startedAt, now());
      host.releaseUnmute(gesture.target, "pointer", commit);
    } else if (classifyClick) {
      host.setMuted(gesture.target, true);
    }
    refresh();
  }

  function renewControlKey(target: AudioTarget, clickEligible: boolean): void {
    const existing = keyControlGestures.get(target);
    if (existing) {
      clearTimeout(existing.lease);
      existing.lease = setTimeout(() => endControlKey(target, false), KEY_HOLD_LEASE_MS);
      existing.lease.unref?.();
      return;
    }
    const muted = persistentMuted(target);
    if (muted === null) return;
    if (muted) host.beginUnmute(target, "key");
    const lease = setTimeout(() => endControlKey(target, false), KEY_HOLD_LEASE_MS);
    lease.unref?.();
    keyControlGestures.set(target, {
      startedAt: now(),
      startedMuted: muted,
      clickEligible,
      lease,
    });
    refresh();
  }

  function endControlKey(target: AudioTarget, classifyClick = true): void {
    const gesture = keyControlGestures.get(target);
    if (!gesture) return;
    keyControlGestures.delete(target);
    clearTimeout(gesture.lease);
    if (gesture.startedMuted) {
      const commit =
        classifyClick && gesture.clickEligible && releaseCommitsClick(gesture.startedAt, now());
      host.releaseUnmute(target, "key", commit);
    } else if (classifyClick && gesture.clickEligible) {
      host.setMuted(target, true);
    }
    refresh();
  }

  function renewSpaceControl(clickEligible: boolean): void {
    if (spaceGesture) {
      clearTimeout(spaceGesture.lease);
      spaceGesture.lease = setTimeout(() => endSpaceControl(false), KEY_HOLD_LEASE_MS);
      spaceGesture.lease.unref?.();
      return;
    }
    const muted = persistentMuted("mic");
    if (muted === null) return;
    if (muted) host.beginUnmute("mic", "space");
    const lease = setTimeout(() => endSpaceControl(false), KEY_HOLD_LEASE_MS);
    lease.unref?.();
    spaceGesture = {
      startedAt: now(),
      startedMuted: muted,
      clickEligible,
      lease,
    };
    refresh();
  }

  function endSpaceControl(classifyClick = true): void {
    const gesture = spaceGesture;
    if (!gesture) return;
    spaceGesture = null;
    clearTimeout(gesture.lease);
    if (gesture.startedMuted) {
      const commit =
        classifyClick && gesture.clickEligible && releaseCommitsClick(gesture.startedAt, now());
      host.releaseUnmute("mic", "space", commit);
    } else if (classifyClick && gesture.clickEligible) {
      host.setMuted("mic", true);
    }
    refresh();
  }

  function cancelInputs(): void {
    if (spaceGesture) endSpaceControl(false);
    if (pointerGesture) endPointerControl(false);
    for (const target of [...keyControlGestures.keys()]) endControlKey(target, false);
  }

  const frameCallback = async (deltaMs: number): Promise<void> => {
    const dt = deltaMs / 1000;
    pulse += dt;
    if (renderer.width !== layoutWidth || renderer.height !== layoutHeight) refresh();
    const viewportWidth = renderer.width || process.stdout.columns || 40;
    const viewportHeight = renderer.height || process.stdout.rows || 24;
    const state = host.state();
    const micMuted = state.mic.effectiveMuted;
    const micLabel = micHoldLabel.state(state.mic.muted, micMuted, now());
    const agentMuted = state.speaker.effectiveMuted;
    signalField.step(dt, {
      you: state.available ? levelFromDb(state.mic.db) : 0,
      agent: state.available ? levelFromDb(state.speaker.db) : 0,
      youMuted: micMuted,
      agentMuted,
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
    const youColor = micMuted ? PALETTE.youDim : PALETTE.you;
    const youLabelColor = micLabel.muted ? PALETTE.youDim : PALETTE.you;
    const agentColor = agentMuted ? PALETTE.agentDim : PALETTE.agent;
    fieldCanvas.content = styledSignalField(frame, {
      faint: PALETTE.faint,
      dim: PALETTE.dim,
      grid: PALETTE.border,
      axis: PALETTE.faint,
      you: youColor,
      agent: agentColor,
    });
    fieldLabels.content = styledSignalLabels(
      boundedViewportExtent(fieldLabels.width, viewportWidth),
      micLabel.muted,
      micLabel.talking,
      agentMuted,
      youLabelColor,
      agentColor,
    );
    fieldReadout.content = styledSignalReadout(
      boundedViewportExtent(fieldReadout.width, viewportWidth),
      state.mic.db,
      state.speaker.db,
      youColor,
      agentColor,
      signalFieldStatus(state.phase, state.liveForMs, renderer.width, pulse),
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
    if (controlAction?.action === "end") {
      endControlKey(controlAction.target);
      return;
    }
    if (palette.handleKey(key)) return;
    if (spaceAction) {
      renewSpaceControl(spaceAction === "begin");
      return;
    }
    if (controlAction) {
      if (controlAction.action === "toggle") toggle(controlAction.target);
      else renewControlKey(controlAction.target, controlAction.action === "begin");
      return;
    }
    if (key.name === "space" || key.eventType !== "press") return;
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      void shutdown();
      return;
    }
    if (key.name === "r") host.redial();
    else if (key.name === "f") host.fresh();
  });
  renderer.keyInput.on("keyrelease", (key: ParsedKey) => {
    if (spaceControlKeyAction(key, palette.isOpen()) === "end") endSpaceControl();
    const controlAction = audioControlKeyAction(key, palette.isOpen());
    if (controlAction?.action === "end") endControlKey(controlAction.target);
  });
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  renderer.setFrameCallback(frameCallback);
  renderer.requestLive();
  refresh();

  return { done, refresh, cancelInputs, shutdown };
}
