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
import {
  encodeRemoteMessage,
  parseRemoteState,
  type RemoteState,
  type RemoteUnmuteInput,
} from "./remote-protocol.ts";
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

const RECONNECT_MS = 750;
const PALETTE = VOICE_TONES;

export class RemoteError extends Error {}

export interface RemoteUiOptions {
  createRenderer?(): Promise<CliRenderer>;
  now?(): number;
}

export async function runRemote(socketPath: string, options: RemoteUiOptions = {}): Promise<void> {
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
    id: "remote-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: PALETTE.bg,
    onMouseUp: () => endPointerControl(),
    onMouseDragEnd: () => endPointerControl(),
  });
  renderer.root.add(root);

  const main = new BoxRenderable(renderer, {
    id: "remote-main",
    width: "100%",
    flexGrow: 1,
    flexDirection: "column",
    padding: 1,
    gap: 1,
    backgroundColor: PALETTE.bg,
  });
  root.add(main);

  const rails = new BoxRenderable(renderer, {
    id: "remote-rails",
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
      beginPointerControl(event.x < middle ? "mic" : "speaker");
    },
    onMouseUp: () => endPointerControl(),
    onMouseDragEnd: () => endPointerControl(),
  });
  const fieldLabels = new TextRenderable(renderer, { content: "", height: 1, wrapMode: "none" });
  const fieldCanvas = new TextRenderable(renderer, {
    id: "remote-field-canvas",
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
    "remote-palette",
    {
      panel: PALETTE.panel,
      line: PALETTE.border,
      accent: PALETTE.accent,
      muted: PALETTE.dim,
      text: PALETTE.text,
    },
  );
  renderer.root.add(palette.root);

  let latest: RemoteState | null = null;
  let socket: Socket | null = null;
  let connected = false;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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
  const signalField = new SignalField({ seed: 0x2e6d_07e });
  const micHoldLabel = new UnmuteHoldLabel();
  let pulse = 0;

  const paint = (): void => {
    if (closed) return;
    const width = renderer.width || process.stdout.columns || 40;
    const height = renderer.height || process.stdout.rows || 24;
    layoutWidth = width;
    layoutHeight = height;
    // The signal field is the whole instrument and its channel halves are
    // the two large pointer targets.
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
          label: `mic — ${latest?.mic.muted ? "unmute · hold M/Space" : "mute on release"}`,
          onRun: () => toggle("mic"),
        },
        {
          id: "speaker",
          key: "S",
          label: `speaker — ${latest?.speaker.muted ? "unmute · hold S" : "mute on release"}`,
          onRun: () => toggle("speaker"),
        },
        { id: "quit", key: "Q", label: "quit", onRun: shutdown },
      ],
    });

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
      clearInputs();
      paint();
      if (!closed) reconnectTimer = setTimeout(connect, RECONNECT_MS);
    });
  };

  function toggle(target: AudioTarget): void {
    if (!connected || !socket || !latest) return;
    const muted = target === "mic" ? latest.mic.muted : latest.speaker.muted;
    setMuted(target, !muted);
  }

  function setMuted(target: AudioTarget, muted: boolean): void {
    if (!connected || !socket || !latest) return;
    socket.write(encodeRemoteMessage({ type: "set-muted", target, muted }));
  }

  function persistentMuted(target: AudioTarget): boolean | null {
    if (!latest) return null;
    return target === "mic" ? latest.mic.muted : latest.speaker.muted;
  }

  function beginUnmute(target: AudioTarget, input: RemoteUnmuteInput): void {
    if (!connected || !socket || !latest) return;
    socket.write(encodeRemoteMessage({ type: "hold-unmuted", target, input }));
  }

  function releaseUnmute(target: AudioTarget, input: RemoteUnmuteInput, commit = false): void {
    if (!connected || !socket || !latest) return;
    socket.write(encodeRemoteMessage({ type: "release-unmuted", target, input, commit }));
  }

  function beginPointerControl(target: AudioTarget): void {
    if (pointerGesture) endPointerControl(false);
    const muted = persistentMuted(target);
    if (muted === null) return;
    pointerGesture = { target, startedAt: now(), startedMuted: muted };
    if (muted) beginUnmute(target, "pointer");
  }

  function endPointerControl(classifyClick = true): void {
    const gesture = pointerGesture;
    if (!gesture) return;
    pointerGesture = null;
    if (gesture.startedMuted) {
      const commit = classifyClick && releaseCommitsClick(gesture.startedAt, now());
      releaseUnmute(gesture.target, "pointer", commit);
    } else if (classifyClick) {
      setMuted(gesture.target, true);
    }
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
    if (muted) beginUnmute(target, "key");
    const lease = setTimeout(() => endControlKey(target, false), KEY_HOLD_LEASE_MS);
    lease.unref?.();
    keyControlGestures.set(target, {
      startedAt: now(),
      startedMuted: muted,
      clickEligible,
      lease,
    });
  }

  function endControlKey(target: AudioTarget, classifyClick = true): void {
    const gesture = keyControlGestures.get(target);
    if (!gesture) return;
    keyControlGestures.delete(target);
    clearTimeout(gesture.lease);
    if (gesture.startedMuted) {
      const commit =
        classifyClick && gesture.clickEligible && releaseCommitsClick(gesture.startedAt, now());
      releaseUnmute(target, "key", commit);
    } else if (classifyClick && gesture.clickEligible) {
      setMuted(target, true);
    }
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
    if (muted) beginUnmute("mic", "space");
    const lease = setTimeout(() => endSpaceControl(false), KEY_HOLD_LEASE_MS);
    lease.unref?.();
    spaceGesture = {
      startedAt: now(),
      startedMuted: muted,
      clickEligible,
      lease,
    };
  }

  function endSpaceControl(classifyClick = true): void {
    const gesture = spaceGesture;
    if (!gesture) return;
    spaceGesture = null;
    clearTimeout(gesture.lease);
    if (gesture.startedMuted) {
      const commit =
        classifyClick && gesture.clickEligible && releaseCommitsClick(gesture.startedAt, now());
      releaseUnmute("mic", "space", commit);
    } else if (classifyClick && gesture.clickEligible) {
      setMuted("mic", true);
    }
  }

  function clearInputs(): void {
    if (spaceGesture) clearTimeout(spaceGesture.lease);
    spaceGesture = null;
    pointerGesture = null;
    for (const gesture of keyControlGestures.values()) clearTimeout(gesture.lease);
    keyControlGestures.clear();
  }

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    clearInputs();
    socket?.destroy();
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    renderer.removeFrameCallback(frameCallback);
    renderer.dropLive();
    renderer.destroy();
    resolveDone();
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
    if (key.name === "space") {
      return;
    }
    if (key.eventType !== "press") return;
    if (key.name === "q" || (key.ctrl && key.name === "c")) shutdown();
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  renderer.keyInput.on("keyrelease", (key: ParsedKey) => {
    if (spaceControlKeyAction(key, palette.isOpen()) === "end") endSpaceControl();
    const controlAction = audioControlKeyAction(key, palette.isOpen());
    if (controlAction?.action === "end") endControlKey(controlAction.target);
  });
  const frameCallback = async (deltaMs: number): Promise<void> => {
    const dt = deltaMs / 1000;
    pulse += dt;
    if (renderer.width !== layoutWidth || renderer.height !== layoutHeight) paint();
    const viewportWidth = renderer.width || process.stdout.columns || 40;
    const viewportHeight = renderer.height || process.stdout.rows || 24;
    const micDb = latest?.mic.db ?? -Infinity;
    const agentDb = latest?.speaker.db ?? -Infinity;
    const micMuted = latest?.mic.effectiveMuted ?? false;
    const micLabel = micHoldLabel.state(latest?.mic.muted ?? false, micMuted, now());
    const agentMuted = latest?.speaker.effectiveMuted ?? false;
    signalField.step(dt, {
      you: connected ? levelFromDb(micDb) : 0,
      agent: connected ? levelFromDb(agentDb) : 0,
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
      you: youColor,
      agent: agentColor,
    });
    const phase = latest?.phase ?? "waiting-ready";
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
      micDb,
      agentDb,
      youColor,
      agentColor,
      signalFieldStatus(phase, latest?.liveForMs ?? null, renderer.width, pulse),
    );
  };
  renderer.setFrameCallback(frameCallback);
  renderer.requestLive();
  paint();
  connect();
  await done;
}
