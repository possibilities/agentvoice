import {
  BoxRenderable,
  type CliRenderer,
  createCliRenderer,
  type KeyEvent,
  TextRenderable,
} from "@opentui/core";
import type { AudioTarget } from "./audio-control.ts";
import type { VoiceHost, VoiceView } from "./state.ts";

export interface VoiceTuiOptions {
  createRenderer?(): Promise<CliRenderer>;
}

const background = "#000000";
const foreground = "#ffffff";
const muted = "#666666";

/** A static, pointer-only frontend. The server owns the call. */
export async function createVoiceTui(
  host: VoiceHost,
  options: VoiceTuiOptions = {},
): Promise<VoiceView> {
  const renderer = options.createRenderer
    ? await options.createRenderer()
    : await createCliRenderer({
        exitOnCtrlC: false,
        screenMode: "alternate-screen",
        useKittyKeyboard: null,
        backgroundColor: background,
      });
  let closed = false;
  let held = false;
  let shutdownPromise: Promise<void> | undefined;
  const { promise: done, resolve: resolveDone } = Promise.withResolvers<void>();
  const root = new BoxRenderable(renderer, {
    id: "voice-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: background,
    onMouseUp: release,
    onMouseDragEnd: release,
  });
  renderer.root.add(root);
  const connection = new TextRenderable(renderer, {
    id: "voice-connection",
    height: 1,
    content: "",
    fg: foreground,
    selectable: false,
  });
  root.add(connection);
  const channels = new BoxRenderable(renderer, {
    id: "voice-channels",
    width: "100%",
    flexGrow: 1,
    flexDirection: "row",
    minHeight: 1,
  });
  root.add(channels);
  function button(id: string, label: string, action: () => void) {
    const box = new BoxRenderable(renderer, {
      id,
      flexGrow: 1,
      flexBasis: 0,
      minWidth: 1,
      minHeight: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: foreground,
      alignItems: "center",
      justifyContent: "center",
      onMouseDown: (event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        action();
      },
      onMouseUp: release,
      onMouseDragEnd: release,
    });
    const text = new TextRenderable(renderer, {
      id: `${id}-label`,
      content: label,
      fg: foreground,
      selectable: false,
    });
    box.add(text);
    return { box, text };
  }
  const mic = button("voice-mic", "HUMAN ▷ INPUT", () => toggle("mic"));
  const speaker = button("voice-speaker", "AGENT ◁ OUTPUT", () => toggle("speaker"));
  channels.add(mic.box);
  channels.add(speaker.box);
  const ptt = button("voice-ptt", "PUSH TO TALK", () => {
    const state = host.state();
    if (held || !state.available || !state.mic.muted || state.phase !== "live") return;
    held = true;
    host.beginUnmute("mic", "pointer");
    refresh();
  });
  ptt.box.flexGrow = 0;
  ptt.box.flexBasis = "auto";
  ptt.box.height = 5;
  ptt.box.maxHeight = "35%";
  root.add(ptt.box);

  function toggle(target: AudioTarget) {
    const state = host.state();
    if (!state.available) return;
    release();
    host.setMuted(target, !state[target].muted);
    refresh();
  }
  function release() {
    if (!held) return;
    held = false;
    host.releaseUnmute("mic", "pointer");
    refresh();
  }
  function refresh() {
    if (closed) return;
    const state = host.state();
    if (held && (!state.available || state.phase !== "live")) release();
    connection.content = {
      "waiting-ready": "WAITING FOR AGENT",
      negotiating: "NEGOTIATING VOICE",
      live: "LIVE",
      failed: "FAILED",
      stopped: "STOPPED",
    }[state.phase];
    for (const [target, control] of [
      ["mic", mic],
      ["speaker", speaker],
    ] as const) {
      const dim = !state.available || state[target].effectiveMuted;
      control.box.borderColor = dim ? muted : foreground;
      control.text.fg = dim ? muted : foreground;
      control.text.content =
        target === "mic"
          ? state.mic.muted
            ? state.mic.effectiveMuted
              ? "HUMAN × PUSH"
              : "HUMAN ● TALKING"
            : "HUMAN ▷ INPUT"
          : state.speaker.muted
            ? "AGENT × MUTED"
            : "AGENT ◁ OUTPUT";
    }
    ptt.box.visible = state.mic.muted;
    ptt.text.content = held ? "TALKING" : "PUSH TO TALK";
    ptt.text.fg = state.available && state.phase === "live" ? foreground : muted;
    ptt.box.borderColor = ptt.text.fg;
    renderer.requestRender();
  }
  function shutdown(): Promise<void> {
    shutdownPromise ??= Promise.resolve().then(async () => {
      release();
      closed = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
      renderer.keyInput.off("keypress", onKeypress);
      renderer.off("resize", refresh);
      renderer.off("blur", release);
      try {
        await host.shutdown();
      } finally {
        renderer.destroy();
        resolveDone();
      }
    });
    return shutdownPromise;
  }
  const onSignal = () => {
    void shutdown().catch(() => {});
  };
  const onKeypress = (key: KeyEvent) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      onSignal();
    }
  };
  renderer.keyInput.on("keypress", onKeypress);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);
  renderer.on("resize", refresh);
  renderer.on("blur", release);
  refresh();
  return { done, refresh, cancelInputs: release, shutdown };
}
