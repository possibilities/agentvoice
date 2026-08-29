import { describe, expect, test } from "bun:test";
import { linesToText, renderFrameLines } from "../src/render.ts";
import { formatClock, type UsageViewModel } from "../src/view.ts";

const vm: UsageViewModel = {
  nowMs: Date.parse("2026-08-10T23:00:00Z"),
  claude: {
    provider: "claude",
    health: "ok",
    ageText: "fresh 4s",
    fresh: true,
    notes: [],
    cards: [
      {
        provider: "claude",
        name: "claude-1",
        detail: "Max 20× · a deliberately long account description",
        status: null,
        dimmed: false,
        measuredAgo: "12s",
        focus: ["non-fable"],
        meters: [
          { label: "session", usedPercent: 42, resetText: "3h 12m", tone: "good", spark: false },
          { label: "gpt-5.3-codex-spark", usedPercent: 88.4, resetText: "6d 23h", tone: "hot", spark: true },
        ],
      },
    ],
  },
  codex: null,
  focus: [
    { kind: "claude", state: "off", target: null, lifetime: null },
    { kind: "non-fable", state: "active", target: "claude-1", lifetime: "permanent" },
  ],
};

describe("Signal Room frame", () => {
  test("lets account rows stand alone, with no provider section headers", () => {
    const text = linesToText(renderFrameLines(vm, 80), false);
    expect(text).toContain("▎ AGENTUSAGE / CAPACITY");
    expect(text).not.toContain("▎ CLAUDE");
    expect(text).not.toContain("▎ CODEX");
    expect(text).toContain("● claude-1");
    expect(text).toContain("▎ FOCUS");
    expect(text).toContain("[NON-FABLE]");
  });

  test("surfaces a non-ok observation by provider name where headers once did", () => {
    const broken: UsageViewModel = {
      ...vm,
      claude: { ...vm.claude!, health: "error", ageText: "stale 3m", fresh: false },
    };
    const text = linesToText(renderFrameLines(broken, 80, { title: false }), false);
    expect(text).toContain("⚠ CLAUDE ERROR · stale 3m");
    expect(linesToText(renderFrameLines(vm, 80, { title: false }), false)).not.toContain("⚠");
  });

  test("compresses meters and metadata before they wrap", () => {
    for (const width of [40, 48, 64, 80, 100, 120]) {
      const lines = renderFrameLines(vm, width, { title: false });
      for (const line of lines) {
        expect(line.map((span) => span.text).join("").length).toBeLessThanOrEqual(width);
      }
    }
  });

  test("uses comfortable instrument spacing without changing snapshot density", () => {
    const compact = linesToText(renderFrameLines(vm, 80, { title: false }), false).split("\n");
    const comfortable = linesToText(
      renderFrameLines(vm, 80, { title: false, density: "comfortable" }),
      false,
    ).split("\n");
    const compactMetadata = compact.findIndex((line) => line.includes("sampled 12s ago"));
    const comfortableMetadata = comfortable.findIndex((line) => line.includes("sampled 12s ago"));

    expect(compact[compactMetadata + 1]).toContain("session");
    expect(comfortable[comfortableMetadata + 1]).toBe("");
    expect(comfortable[comfortableMetadata + 2]).toContain("session");
  });

  test("never renders more than one consecutive blank line", () => {
    for (const density of ["compact", "comfortable"] as const) {
      const lines = renderFrameLines(vm, 80, { density });
      const hasDoubleBlank = lines.some((line, index) => line.length === 0 && lines[index - 1]?.length === 0);
      expect(hasDoubleBlank).toBe(false);
    }
  });

  test("lets meters occupy the field instead of huddling at the left", () => {
    const text = linesToText(renderFrameLines(vm, 80, { title: false }), false);
    const meter = text.split("\n").find((line) => line.includes("session"))!;
    const bar = meter.slice(meter.indexOf("▕") + 1, meter.indexOf("▏"));
    expect(bar.length).toBe(36);
  });

  test("shares agentvoice's elapsed time grammar", () => {
    expect(formatClock(-1)).toBe("00:00");
    expect(formatClock(61_000)).toBe("01:01");
    expect(formatClock(3_661_000)).toBe("1:01:01");
  });

  test("clips unbounded provider data at the frame edge", () => {
    const noisy: UsageViewModel = {
      ...vm,
      claude: {
        ...vm.claude!,
        health: "provider-error-with-a-long-name",
        ageText: "stale for an unexpectedly long time",
        notes: ["an upstream diagnostic that is intentionally much wider than the terminal"],
        cards: [
          {
            ...vm.claude!.cards[0]!,
            name: "claude-account-with-an-unusually-long-display-name",
            status: "unavailable-for-a-very-long-reason",
            meters: [
              {
                label: "gpt-5.3-codex-spark-with-a-long-suffix",
                usedPercent: 112,
                resetText: "123d 23h 59m",
                tone: "over",
                spark: true,
              },
            ],
          },
        ],
      },
    };

    for (const width of [32, 40, 48]) {
      for (const line of renderFrameLines(noisy, width)) {
        expect(line.map((span) => span.text).join("").length).toBeLessThanOrEqual(width);
      }
    }
  });

  test("keeps color optional for snapshot output", () => {
    const plain = linesToText(renderFrameLines(vm, 80), false);
    const color = linesToText(renderFrameLines(vm, 80), true);
    expect(plain).not.toContain("\u001b[");
    expect(color).toContain("\u001b[38;2;");
  });
});
