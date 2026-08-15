import { describe, expect, test } from "bun:test";
import { composeSurfaceReport, SurfaceTracker } from "../src/core/surface.ts";

function pane(
  paneId: string,
  status: string,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type: "pane_updated", pane: { pane_id: paneId, agent_status: status, ...extras } };
}

function tagged(
  paneId: string,
  status: string,
  name = "lint-sweep",
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return pane(paneId, status, { tokens: { worker: name }, ...extras });
}

describe("SurfaceTracker", () => {
  test("a tagged pane wakes on the transition to blocked, once", () => {
    const tracker = new SurfaceTracker("worker");
    expect(tracker.handleEvent("pane_updated", tagged("w1:p1", "working"))).toEqual([]);
    const wakes = tracker.handleEvent("pane_updated", tagged("w1:p1", "blocked"));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ worker: "lint-sweep", status: "blocked" });
    expect(tracker.handleEvent("pane_updated", tagged("w1:p1", "blocked"))).toEqual([]);
  });

  test("unknown neither wakes nor re-arms a blocked wake through a flap", () => {
    const tracker = new SurfaceTracker("worker");
    tracker.handleEvent("pane_updated", tagged("w1:p1", "working"));
    expect(tracker.handleEvent("pane_updated", tagged("w1:p1", "blocked"))).toHaveLength(1);
    expect(tracker.handleEvent("pane_updated", tagged("w1:p1", "unknown"))).toEqual([]);
    expect(tracker.handleEvent("pane_updated", tagged("w1:p1", "blocked"))).toEqual([]);
  });

  test("done wakes; a later run can wake done again", () => {
    const tracker = new SurfaceTracker("worker");
    tracker.handleEvent("pane_updated", tagged("w1:p1", "working"));
    expect(tracker.handleEvent("pane_updated", tagged("w1:p1", "done"))).toMatchObject([
      { status: "done" },
    ]);
    expect(tracker.handleEvent("pane_updated", tagged("w1:p1", "idle"))).toEqual([]);
    tracker.handleEvent("pane_updated", tagged("w1:p1", "working"));
    expect(tracker.handleEvent("pane_updated", tagged("w1:p1", "done"))).toHaveLength(1);
  });

  test("first sight of an already-stuck worker wakes", () => {
    const tracker = new SurfaceTracker("worker");
    const wakes = tracker.handleEvent("pane_updated", tagged("w1:p2", "blocked"));
    expect(wakes).toMatchObject([{ worker: "lint-sweep", status: "blocked" }]);
  });

  test("untagged panes never wake; removing the tag untracks", () => {
    const tracker = new SurfaceTracker("worker");
    expect(tracker.handleEvent("pane_updated", pane("w1:p3", "blocked"))).toEqual([]);
    tracker.handleEvent("pane_updated", tagged("w1:p4", "working"));
    expect(tracker.size).toBe(1);
    expect(tracker.handleEvent("pane_updated", pane("w1:p4", "blocked", { tokens: {} }))).toEqual(
      [],
    );
    expect(tracker.size).toBe(0);
  });

  test("a pane event without a tokens field still transitions a tracked pane", () => {
    const tracker = new SurfaceTracker("worker");
    tracker.handleEvent("pane_updated", tagged("w1:p5", "working"));
    const wakes = tracker.handleEvent("pane_updated", pane("w1:p5", "blocked"));
    expect(wakes).toMatchObject([{ worker: "lint-sweep", status: "blocked" }]);
  });

  test("pane_exited on a tracked pane is gone; on an untracked pane, nothing", () => {
    const tracker = new SurfaceTracker("worker");
    tracker.handleEvent("pane_updated", tagged("w1:p6", "working"));
    expect(
      tracker.handleEvent("pane_exited", { type: "pane_exited", pane_id: "w1:p6" }),
    ).toMatchObject([{ worker: "lint-sweep", status: "gone" }]);
    expect(tracker.handleEvent("pane_exited", { type: "pane_exited", pane_id: "w1:p7" })).toEqual(
      [],
    );
  });

  test("a released agent is gone, carrying its final status", () => {
    const tracker = new SurfaceTracker("worker");
    tracker.handleEvent("pane_updated", tagged("w1:p8", "working"));
    const wakes = tracker.handleEvent("pane_agent_detected", {
      type: "pane_agent_detected",
      pane_id: "w1:p8",
      released: true,
      final_status: "done",
    });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.detail).toContain("done");
    // A detection (released: false) is a worker starting, not ending.
    tracker.handleEvent("pane_updated", tagged("w1:p9", "working"));
    expect(
      tracker.handleEvent("pane_agent_detected", {
        type: "pane_agent_detected",
        pane_id: "w1:p9",
        released: false,
      }),
    ).toEqual([]);
  });

  test("reconcile wakes missed transitions and reports vanished workers", () => {
    const tracker = new SurfaceTracker("worker");
    tracker.handleEvent("pane_updated", tagged("w1:p10", "working", "alpha"));
    tracker.handleEvent("pane_updated", tagged("w1:p11", "working", "beta"));
    const wakes = tracker.reconcile([
      { pane_id: "w1:p10", agent_status: "blocked", tokens: { worker: "alpha" } },
      { pane_id: "w1:p12", agent_status: "done", tokens: { worker: "gamma" } },
    ]);
    expect(wakes).toHaveLength(3);
    expect(wakes).toMatchObject([
      { worker: "alpha", status: "blocked" },
      { worker: "gamma", status: "done" },
      { worker: "beta", status: "gone" },
    ]);
    expect(tracker.size).toBe(2);
  });
});

describe("composeSurfaceReport", () => {
  test("wraps the wake in a surface_report envelope with status guidance", () => {
    const report = composeSurfaceReport({
      worker: "lint-sweep",
      status: "blocked",
      detail: '"lint sweep" is blocked on an approval or a question in its pane',
    });
    expect(report).toContain('<surface_report worker="lint-sweep" status="blocked">');
    expect(report).toContain("</surface_report>");
    expect(report).toContain("not the user speaking");
    expect(report).toContain("herdr agent prompt");
  });

  test("sanitizes a handle that would break the attribute", () => {
    const report = composeSurfaceReport({ worker: 'a"b<c>', status: "gone", detail: "x" });
    expect(report).toContain('worker="a_b_c_"');
  });
});
