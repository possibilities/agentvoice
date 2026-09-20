import { expect, test } from "bun:test";
import { reconcileView, transcriptPresentationView } from "../src/reconcile-view.ts";
import type { LiveView } from "../src/types.ts";

test("a tail delta preserves unchanged messages, the other lane and controls", () => {
  const prior: LiveView = {
    id: "view",
    phase: "live",
    agent: [
      { id: "first", role: "assistant", content: "old", status: "complete" },
      { id: "last", role: "assistant", content: "stream", status: "streaming" },
    ],
    voice: [{ id: "speech", role: "assistant", content: "spoken", status: "complete" }],
    agentControls: { available: true, active: true, stopping: false, pending: false, queue: [] },
  };
  const next = structuredClone(prior);
  next.agent[1]!.content += " delta";
  const merged = reconcileView(prior, next);
  expect(merged.agent).not.toBe(prior.agent);
  expect(merged.agent[0]).toBe(prior.agent[0]);
  expect(merged.agent[1]).toBe(next.agent[1]);
  expect(merged.voice).toBe(prior.voice);
  expect(merged.agentControls).toBe(prior.agentControls);
  expect(reconcileView(prior, structuredClone(prior)).agent).toBe(prior.agent);
  next.id = "replacement";
  expect(reconcileView(prior, next)).toBe(next);
});

test("reorders, removals and nested authoritative corrections are retained", () => {
  const prior: LiveView = {
    id: "view",
    phase: "live",
    voice: [],
    agent: [
      {
        id: "tool",
        role: "tool",
        content: "",
        status: "complete",
        toolActivity: {
          name: "run",
          detail: "run",
          state: "complete",
          sections: [{ label: "Output", content: "before" }],
        },
      },
      { id: "user", role: "user", content: "same", status: "complete" },
    ],
  };
  const next = structuredClone(prior);
  next.agent.reverse();
  next.agent[1]!.toolActivity!.sections![0]!.content = "corrected";
  const merged = reconcileView(prior, next);
  expect(merged.agent[0]).toBe(prior.agent[1]);
  expect(merged.agent[1]?.toolActivity?.sections?.[0]?.content).toBe("corrected");
  expect(reconcileView(prior, { ...next, agent: [] }).agent).toEqual([]);
});

test("the first Agent batch bypasses deferred history without following raw Voice readiness", () => {
  const empty: LiveView = {
    id: "view",
    phase: "detached",
    agent: [],
    voice: [],
  };
  const populated: LiveView = {
    ...empty,
    agent: [{ id: "history", role: "assistant", content: "Prior work", status: "complete" }],
  };
  expect(transcriptPresentationView(populated, empty)).toBe(populated);
  expect(
    transcriptPresentationView(
      {
        ...empty,
        voice: [{ id: "speech", role: "user", content: "Raw speech", status: "complete" }],
      },
      empty,
    ),
  ).toBe(empty);

  const later: LiveView = {
    ...populated,
    agent: [
      ...populated.agent,
      { id: "live", role: "assistant", content: "Now", status: "complete" },
    ],
  };
  expect(transcriptPresentationView(later, populated)).toBe(populated);
  const voiceStillLoading = { ...populated, voiceHistoryLoading: true };
  expect(transcriptPresentationView(later, voiceStillLoading)).toBe(voiceStillLoading);
  expect(transcriptPresentationView({ ...empty, id: "replacement" }, populated).id).toBe(
    "replacement",
  );
});
