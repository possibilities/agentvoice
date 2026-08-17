import {
  BoxRenderable,
  bold,
  createCliRenderer,
  fg,
  type ParsedKey,
  StyledText,
  TextRenderable,
} from "@opentui/core";
import { SignalField } from "../src/console/signal-field.ts";
import { styledSignalField } from "../src/console/signal-field-ui.ts";
import { SIGNAL_GLYPHS, VOICE_TONES as TONE } from "../src/console/theme.ts";

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  targetFps: 30,
  screenMode: "alternate-screen",
  backgroundColor: TONE.bg,
});

const root = new BoxRenderable(renderer, {
  width: "100%",
  height: "100%",
  flexDirection: "column",
  backgroundColor: TONE.bg,
});
renderer.root.add(root);

const header = new BoxRenderable(renderer, {
  width: "100%",
  height: 3,
  border: ["bottom"],
  borderStyle: "single",
  borderColor: TONE.border,
  backgroundColor: TONE.field,
  paddingTop: 1,
  paddingLeft: 2,
  paddingRight: 2,
  flexDirection: "row",
  justifyContent: "space-between",
});
const galleryTitle = new TextRenderable(renderer, { content: "" });
header.add(galleryTitle);
const scenarioLabel = new TextRenderable(renderer, { content: "", fg: TONE.ok });
header.add(scenarioLabel);
root.add(header);

const main = new BoxRenderable(renderer, {
  width: "100%",
  flexGrow: 1,
  flexDirection: "column",
  padding: 1,
  backgroundColor: TONE.bg,
});
const instrument = new BoxRenderable(renderer, {
  width: "100%",
  flexGrow: 1,
  minHeight: 8,
  border: ["left"],
  borderStyle: "single",
  borderColor: TONE.accent,
  backgroundColor: TONE.panel,
  flexDirection: "column",
  paddingLeft: 2,
  paddingRight: 2,
});
const labels = new TextRenderable(renderer, { content: "", height: 1, wrapMode: "none" });
const canvas = new TextRenderable(renderer, { content: "", flexGrow: 1, wrapMode: "none" });
const readout = new TextRenderable(renderer, { content: "", height: 1, wrapMode: "none" });
instrument.add(labels);
instrument.add(canvas);
instrument.add(readout);
main.add(instrument);
root.add(main);

const footer = new BoxRenderable(renderer, {
  width: "100%",
  height: 3,
  border: ["top"],
  borderStyle: "single",
  borderColor: TONE.border,
  backgroundColor: TONE.field,
  paddingLeft: 2,
  paddingRight: 2,
  alignItems: "center",
  justifyContent: "space-between",
  flexDirection: "row",
});
const galleryControls = new TextRenderable(renderer, { content: "" });
const galleryDoctrine = new TextRenderable(renderer, { content: "", fg: TONE.dim });
footer.add(galleryControls);
footer.add(galleryDoctrine);
root.add(footer);

const scenarios = [
  {
    name: "01 HUMAN / EDGE PRESSURE",
    short: "01 HUMAN",
    sample: (t: number) => ({ you: pulse(t, 1.1), agent: 0.02 }),
  },
  {
    name: "02 AGENT / BLUE RETURN",
    short: "02 AGENT",
    sample: (t: number) => ({ you: 0.01, agent: pulse(t + 0.4, 0.82) }),
  },
  {
    name: "03 TURNSTILE / HANDOFF",
    short: "03 HANDOFF",
    sample: (t: number) => {
      const phase = t % 6;
      return {
        you: phase < 2.35 ? voicePhrase(phase, 0.94) : 0,
        agent: phase > 2.7 ? voicePhrase(phase - 2.7, 0.78) : 0,
      };
    },
  },
  {
    name: "04 CROSSTALK / INTERRUPTION",
    short: "04 CROSSTALK",
    sample: (t: number) => ({ you: pulse(t, 0.91), agent: pulse(t + 0.19, 0.86) }),
  },
  {
    name: "05 NO CARRIER / PHOSPHOR IDLE",
    short: "05 IDLE",
    sample: () => ({ you: 0, agent: 0 }),
  },
] as const;

const field = new SignalField({ seed: 0x6a11_e7 });
let elapsed = 0;
let scenario = 0;
let autoplay = true;
let switchedAt = 0;

function renderChrome(you: number, agent: number): void {
  const terminalWidth = renderer.width || process.stdout.columns || 80;
  const compact = terminalWidth < 60;
  galleryTitle.content = new StyledText(
    compact
      ? [fg(TONE.accent)(SIGNAL_GLYPHS.rail), bold(fg(TONE.text)(" FIELD"))]
      : [
          fg(TONE.accent)(SIGNAL_GLYPHS.rail),
          bold(fg(TONE.text)(" SIGNAL FIELD")),
          fg(TONE.dim)(" / LIVE GALLERY"),
        ],
  );
  galleryControls.content =
    terminalWidth < 45
      ? new StyledText([
          bold(fg(TONE.accent)("[←/→]")),
          fg(TONE.dim)("  "),
          bold(fg(TONE.accent)("[SPACE]")),
          fg(TONE.dim)("  "),
          bold(fg(TONE.accent)("[Q]")),
        ])
      : new StyledText([
          bold(fg(TONE.accent)("[←/→]")),
          fg(TONE.dim)(" scene  "),
          bold(fg(TONE.accent)("[SPACE]")),
          fg(TONE.dim)(" auto  "),
          bold(fg(TONE.accent)("[Q]")),
          fg(TONE.dim)(" quit"),
        ]);
  galleryDoctrine.content = compact ? "" : "TWO ENVELOPES / NO FFT";
  const width = Math.max(1, labels.width);
  const left = "YOU ▷ INPUT";
  const right = "OUTPUT ◁ AGENT";
  labels.content = new StyledText([
    bold(fg(TONE.you)(left)),
    fg(TONE.faint)(" ".repeat(Math.max(1, width - left.length - right.length))),
    bold(fg(TONE.agent)(right)),
  ]);
  const l = `${Math.round(you * 100)
    .toString()
    .padStart(3)}%`;
  const r = `${Math.round(agent * 100)
    .toString()
    .padStart(3)}%`;
  const mid = you + agent < 0.05 ? "NO CARRIER" : "";
  const spare = Math.max(2, width - l.length - r.length - mid.length);
  const gap = Math.floor(spare / 2);
  readout.content = new StyledText([
    fg(TONE.you)(l),
    fg(TONE.faint)(" ".repeat(gap)),
    fg(TONE.faint)(mid),
    fg(TONE.faint)(" ".repeat(Math.max(1, spare - gap))),
    fg(TONE.agent)(r),
  ]);
  const scenarioName = compact ? scenarios[scenario]!.short : scenarios[scenario]!.name;
  scenarioLabel.content = `${autoplay ? "● AUTO" : "○ HOLD"} · ${scenarioName}`;
}

const frame = async (deltaMs: number): Promise<void> => {
  const dt = deltaMs / 1000;
  elapsed += dt;
  if (autoplay && elapsed - switchedAt > 6) {
    scenario = (scenario + 1) % scenarios.length;
    switchedAt = elapsed;
  }
  const sample = scenarios[scenario]!.sample(elapsed - switchedAt);
  field.step(dt, sample);
  const image = field.render(Math.max(1, canvas.width), Math.max(1, canvas.height));
  canvas.content = styledSignalField(image, {
    faint: TONE.faint,
    dim: TONE.dim,
    grid: TONE.border,
    axis: TONE.faint,
    you: TONE.you,
    agent: TONE.agent,
  });
  renderChrome(image.you, image.agent);
};

function move(by: number): void {
  scenario = (scenario + by + scenarios.length) % scenarios.length;
  switchedAt = elapsed;
}

function shutdown(): void {
  renderer.removeFrameCallback(frame);
  renderer.dropLive();
  renderer.destroy();
  process.exitCode = 0;
}

renderer.keyInput.on("keypress", (key: ParsedKey) => {
  if (key.eventType === "release") return;
  if (key.name === "q" || (key.ctrl && key.name === "c")) shutdown();
  else if (key.name === "left" || key.name === "h") move(-1);
  else if (key.name === "right" || key.name === "l") move(1);
  else if (key.name === "space") autoplay = !autoplay;
});
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
renderer.setFrameCallback(frame);
renderer.requestLive();

function pulse(t: number, strength: number): number {
  const gate = Math.sin(t * 1.7) > -0.28 ? 1 : 0;
  return (
    gate *
    strength *
    (0.46 + 0.34 * Math.abs(Math.sin(t * 5.3)) + 0.2 * Math.abs(Math.sin(t * 11.1)))
  );
}

function voicePhrase(t: number, strength: number): number {
  if (t < 0 || t > 2.8) return 0;
  const envelope = Math.sin(Math.min(1, t / 0.18) * Math.PI * 0.5) * Math.min(1, (2.8 - t) / 0.3);
  return Math.max(0, envelope) * pulse(t + 0.2, strength);
}
