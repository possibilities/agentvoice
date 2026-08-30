import { describe, expect, test } from "bun:test";
import { scenarioSchema } from "../src/scenario.ts";

describe("scenario schema", () => {
  test("defaults the reference models", () => {
    const scenario = scenarioSchema.parse({
      schemaVersion: 1,
      id: "small-eval",
      description: "A compact test.",
      workspace: "workspace",
      steps: [{ type: "sleep", ms: 1 }],
    });
    expect(scenario.agent).toMatchObject({
      voiceModel: "gpt-live-1-codex",
      voice: "cove",
      orchestratorModel: "gpt-5.6-terra",
      reasoningEffort: "medium",
    });
  });

  test("requires an occurrence or an anchor, but not both", () => {
    expect(() =>
      scenarioSchema.parse({
        schemaVersion: 1,
        id: "small-eval",
        description: "A compact test.",
        workspace: "workspace",
        steps: [{ type: "wait", event: "session.connected" }],
      }),
    ).toThrow();

    expect(() =>
      scenarioSchema.parse({
        schemaVersion: 1,
        id: "small-eval",
        description: "A compact test.",
        workspace: "workspace",
        steps: [
          {
            type: "wait",
            event: "output.transcript.done",
            occurrence: 1,
            after: { event: "orchestrator.turn.completed", occurrence: 1 },
          },
        ],
      }),
    ).toThrow();
  });
});
