import { describe, expect, test } from "bun:test";
import { recordRootTurnNotification, validateOracleEvidence } from "../src/codex-runner.ts";
import { EventJournal } from "../src/events.ts";

describe("Codex runner canonical events", () => {
  test("foreign thread turns cannot satisfy root orchestrator waits", async () => {
    const journal = new EventJournal();
    const foreign = recordRootTurnNotification(
      journal,
      "turn/completed",
      { threadId: "child", turn: { id: "child-turn", status: "completed" } },
      "root",
    );
    const root = recordRootTurnNotification(
      journal,
      "turn/completed",
      { threadId: "root", turn: { id: "root-turn", status: "completed" } },
      "root",
    );

    expect(foreign).toBe(false);
    expect(root).toBe(true);
    expect(journal.count("orchestrator.turn.completed")).toBe(1);
    expect((await journal.waitFor("orchestrator.turn.completed", 1, 10)).data).toMatchObject({
      threadId: "root",
      turnId: "root-turn",
    });
  });

  test("separates a valid quality score from harness evidence validity", () => {
    expect(
      validateOracleEvidence({ passed: 2, total: 4, score: 0.5, checks: [{}, {}, {}, {}] }, 0),
    ).toEqual({ valid: true, validationError: null, score: 0.5 });
    expect(validateOracleEvidence({ score: 1 }, 0)).toMatchObject({
      valid: false,
      score: 1,
    });
    expect(
      validateOracleEvidence({ passed: 1, total: 1, score: 1, checks: [{}] }, 124).validationError,
    ).toContain("oracle exited with code 124");
  });
});
