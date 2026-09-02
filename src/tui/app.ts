/**
 * The bare-bones voice screen: one status line, two channel rows with live
 * meters, the backend's state, an event feed, and the key legend. The host
 * owns every fact; this file only draws and turns key gestures into calls.
 */

import {
  BoxRenderable,
  bold,
  type CliRenderer,
  createCliRenderer,
  fg,
  type ParsedKey,
  StyledText,
  type TextChunk,
  TextRenderable,
} from "@opentui/core";
import type { OrchestratorAgentState } from "../orchestrator-adapter.ts";
import { barString, formatClock, levelFromDb } from "./dsp.ts";
import {
  AUDIO_CONTROL_KITTY_KEYBOARD,
  type AudioTarget,
  audioControlKeyAction,
  KEY_HOLD_LEASE_MS,
  releaseCommitsClick,
  spaceControlKeyAction,
} from "./mute-gate.ts";
import { SIGNAL_ROOM as C, GLYPHS } from "./theme.ts";
import type { VoicePhase } from "./voice-transport.ts";

export type VoiceAppInput = "key" | "space";

export interface VoiceAppChannel {
  muted: boolean;
  effectiveMuted: boolean;
  db: number;
}

export interface VoiceAppState {
  title: string;
  phase: VoicePhase;
  liveForMs: number | null;
  backend: { name: string; state: OrchestratorAgentState | "stopped"; detail: string | null };
  mic: VoiceAppChannel;
  speaker: VoiceAppChannel;
  feed: readonly string[];
}

export interface VoiceAppHost {
  state(): VoiceAppState;
  setMuted(target: AudioTarget, muted: boolean): void;
  beginUnmute(target: AudioTarget, input: VoiceAppInput): void;
  releaseUnmute(target: AudioTarget, input: VoiceAppInput, commit: boolean): void;
  redial(): void;
  shutdown(): void | Promise<void>;
}

export interface VoiceAppOptions {
  createRenderer?(): Promise<CliRenderer>;
  now?(): number;
}

export interface VoiceApp {
  readonly done: Promise<void>;
  refresh(): void;
  shutdown(): Promise<void>;
}

const METER_WIDTH = 24;
const FIXED_ROWS = 8;

interface Gesture {
  startedAt: number;
  startedMuted: boolean;
  clickEligible: boolean;
  lease: ReturnType<typeof setTimeout>;
}

export async function createVoiceApp(
  host: VoiceAppHost,
  options: VoiceAppOptions = {},
): Promise<VoiceApp> {
  const now = options.now ?? (() => performance.now());
  const renderer = options.createRenderer
    ? await options.createRenderer()
    : await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 30,
        screenMode: "alternate-screen",
        useKittyKeyboard: AUDIO_CONTROL_KITTY_KEYBOARD,
        backgroundColor: C.canvas,
      });

  const root = new BoxRenderable(renderer, {
    id: "voice-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: C.canvas,
  });
  renderer.root.add(root);
  const screen = new TextRenderable(renderer, {
    id: "voice-screen",
    content: "",
    flexGrow: 1,
    wrapMode: "none",
    fg: C.text,
    selectable: false,
  });
  root.add(screen);

  const keyGestures = new Map<AudioTarget, Gesture>();
  let spaceGesture: Gesture | null = null;
  let closed = false;
  let shutdownPromise: Promise<void> | null = null;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolvePromise) => {
    resolveDone = resolvePromise;
  });

  function persistentMuted(target: AudioTarget): boolean {
    const state = host.state();
    return target === "mic" ? state.mic.muted : state.speaker.muted;
  }

  function toggle(target: AudioTarget): void {
    host.setMuted(target, !persistentMuted(target));
    refresh();
  }

  function renewKey(target: AudioTarget, clickEligible: boolean): void {
    const existing = keyGestures.get(target);
    if (existing) {
      clearTimeout(existing.lease);
      existing.lease = setTimeout(() => endKey(target, false), KEY_HOLD_LEASE_MS);
      existing.lease.unref?.();
      return;
    }
    const muted = persistentMuted(target);
    if (muted) host.beginUnmute(target, "key");
    const lease = setTimeout(() => endKey(target, false), KEY_HOLD_LEASE_MS);
    lease.unref?.();
    keyGestures.set(target, { startedAt: now(), startedMuted: muted, clickEligible, lease });
    refresh();
  }

  function endKey(target: AudioTarget, classifyClick = true): void {
    const gesture = keyGestures.get(target);
    if (!gesture) return;
    keyGestures.delete(target);
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

  function renewSpace(clickEligible: boolean): void {
    if (spaceGesture) {
      clearTimeout(spaceGesture.lease);
      spaceGesture.lease = setTimeout(() => endSpace(false), KEY_HOLD_LEASE_MS);
      spaceGesture.lease.unref?.();
      return;
    }
    const muted = persistentMuted("mic");
    if (muted) host.beginUnmute("mic", "space");
    const lease = setTimeout(() => endSpace(false), KEY_HOLD_LEASE_MS);
    lease.unref?.();
    spaceGesture = { startedAt: now(), startedMuted: muted, clickEligible, lease };
    refresh();
  }

  function endSpace(classifyClick = true): void {
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
    if (spaceGesture) endSpace(false);
    for (const target of [...keyGestures.keys()]) endKey(target, false);
  }

  function refresh(): void {
    if (closed) return;
    renderer.requestRender();
  }

  const frameCallback = async (): Promise<void> => {
    const width = renderer.width || process.stdout.columns || 80;
    const height = renderer.height || process.stdout.rows || 24;
    screen.content = renderScreen(host.state(), width, height);
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
    const spaceAction = spaceControlKeyAction(key);
    const controlAction = audioControlKeyAction(key);
    if (spaceAction === "end") {
      endSpace();
      return;
    }
    if (controlAction?.action === "end") {
      endKey(controlAction.target);
      return;
    }
    if (spaceAction) {
      renewSpace(spaceAction === "begin");
      return;
    }
    if (controlAction) {
      if (controlAction.action === "toggle") toggle(controlAction.target);
      else renewKey(controlAction.target, controlAction.action === "begin");
      return;
    }
    if (key.name === "space" || key.eventType !== "press") return;
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      void shutdown();
      return;
    }
    if (key.name === "r") host.redial();
  });
  renderer.keyInput.on("keyrelease", (key: ParsedKey) => {
    if (spaceControlKeyAction(key) === "end") endSpace();
    const controlAction = audioControlKeyAction(key);
    if (controlAction?.action === "end") endKey(controlAction.target);
  });
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  renderer.setFrameCallback(frameCallback);
  renderer.requestLive();
  refresh();

  return { done, refresh, shutdown };
}

/** Pure: one frame of the screen for a state and viewport. */
export function renderScreen(state: VoiceAppState, width: number, height: number): StyledText {
  const rows: TextChunk[][] = [];
  const rule = [fg(C.line)(GLYPHS.rule.repeat(Math.max(1, width)))];

  const phaseColor = state.phase === "live" ? C.ok : state.phase === "failed" ? C.danger : C.muted;
  const clock = state.liveForMs === null ? "" : ` ${formatClock(state.liveForMs)}`;
  rows.push([
    fg(C.accent)(GLYPHS.rail),
    bold(fg(C.text)(` ${state.title} `)),
    fg(C.faint)(`${GLYPHS.event} `),
    fg(C.muted)(`${state.backend.name} `),
    fg(C.faint)(`${GLYPHS.event} `),
    bold(fg(phaseColor)(`${state.phase.toUpperCase()}${clock}`)),
  ]);
  rows.push(rule);
  rows.push(channelRow("you  ", state.mic, C.local, C.localDim, true));
  rows.push(channelRow("agent", state.speaker, C.remote, C.remoteDim, false));

  const backendColor =
    state.backend.state === "blocked"
      ? C.hot
      : state.backend.state === "working"
        ? C.accent
        : state.backend.state === "stopped"
          ? C.danger
          : C.muted;
  rows.push([
    fg(C.muted)(" fx    "),
    fg(backendColor)(`${state.backend.state === "blocked" ? GLYPHS.live : GLYPHS.idle} `),
    fg(backendColor)(state.backend.state),
    ...(state.backend.detail
      ? [fg(C.faint)(` ${GLYPHS.event} `), fg(C.muted)(state.backend.detail)]
      : []),
  ]);
  rows.push(rule);

  const feedRows = Math.max(1, height - FIXED_ROWS);
  const visible = state.feed.slice(-feedRows);
  for (const line of visible) rows.push([fg(C.faint)(` ${GLYPHS.event} `), fg(C.text)(line)]);
  for (let pad = visible.length; pad < feedRows; pad++) rows.push([fg(C.faint)("")]);

  rows.push(rule);
  rows.push([
    fg(C.muted)(" m "),
    fg(C.faint)("mic  "),
    fg(C.muted)("s "),
    fg(C.faint)("speaker  "),
    fg(C.muted)("space "),
    fg(C.faint)("hold to talk  "),
    fg(C.muted)("r "),
    fg(C.faint)("redial  "),
    fg(C.muted)("q "),
    fg(C.faint)("quit"),
  ]);

  const chunks: TextChunk[] = [];
  rows.slice(0, height).forEach((row, index) => {
    chunks.push(...clipRow(row, width));
    if (index < Math.min(rows.length, height) - 1) chunks.push(fg(C.faint)("\n"));
  });
  return new StyledText(chunks);
}

function channelRow(
  label: string,
  channel: VoiceAppChannel,
  color: string,
  dimColor: string,
  isMic: boolean,
): TextChunk[] {
  const talking = isMic && channel.muted && !channel.effectiveMuted;
  const live = !channel.effectiveMuted;
  const stateText = talking ? "TALKING" : live ? "LIVE   " : "MUTED  ";
  const stateColor = talking ? C.ok : live ? color : dimColor;
  const level = live ? levelFromDb(channel.db) : 0;
  const db = Number.isFinite(channel.db) ? `${channel.db.toFixed(0).padStart(4)} dB` : "  -∞ dB";
  return [
    fg(live ? color : dimColor)(` ${label} `),
    fg(stateColor)(`${live ? GLYPHS.live : GLYPHS.idle} `),
    bold(fg(stateColor)(stateText)),
    fg(live ? color : dimColor)(` ${barString(level, METER_WIDTH)} `),
    fg(C.muted)(db),
  ];
}

/** Keep each row within the viewport; the renderable never wraps. */
function clipRow(row: TextChunk[], width: number): TextChunk[] {
  let remaining = width;
  const out: TextChunk[] = [];
  for (const chunk of row) {
    if (remaining <= 0) break;
    const text = chunk.text;
    if (text.length <= remaining) {
      out.push(chunk);
      remaining -= text.length;
    } else {
      out.push({ ...chunk, text: text.slice(0, remaining) });
      remaining = 0;
    }
  }
  return out;
}
