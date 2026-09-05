import { describe, expect, test } from "bun:test";
import { type ConfigValues, type Prompts, resolveConfig } from "../src/core/config.ts";
import { realtimeParams, threadParams } from "../src/core/params.ts";

const HOME = "/home/tester";

function configure(values: ConfigValues = {}) {
  return resolveConfig({}, values, {}, HOME);
}

function thread(
  values: ConfigValues = {},
  prompts: Prompts = {},
  kind: "start" | "resume" = "start",
) {
  return threadParams(configure(values), prompts, kind);
}

function realtime(values: ConfigValues = {}, prompts: Prompts = {}) {
  return realtimeParams(configure(values), prompts, "th_1", "rt_1", "v=0");
}

describe("threadParams", () => {
  test("adds no custom tools; raw native metadata still passes through without an implementation", () => {
    for (const kind of ["start", "resume"] as const)
      expect(thread({}, {}, kind)).not.toHaveProperty("dynamicTools");
    const dynamicTools = [
      {
        name: "explicit-external-tool",
        description: "Operator supplied",
        inputSchema: { type: "object" },
      },
    ];
    expect(thread({ orchestrator: { extra: { dynamicTools } } })["dynamicTools"]).toEqual(
      dynamicTools,
    );
  });
  test("sends nothing beyond the server's own defaults", () => {
    expect(thread()).toEqual({
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      threadSource: "agentvoice-orchestrator",
    });
  });

  test("maps every orchestrator key onto its wire field", () => {
    const params = thread({
      orchestrator: {
        model: "gpt-5.3-codex",
        "model-provider": "openai",
        "service-tier": "flex",
        personality: "pragmatic",
        "approvals-reviewer": "auto_review",
        "approval-policy": "never",
        sandbox: "danger-full-access",
        "runtime-workspace-roots": ["/a"],
        ephemeral: true,
        "history-mode": "paginated",
      },
    });
    expect(params).toMatchObject({
      model: "gpt-5.3-codex",
      modelProvider: "openai",
      serviceTier: "flex",
      personality: "pragmatic",
      approvalsReviewer: "auto_review",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      runtimeWorkspaceRoots: ["/a"],
      ephemeral: true,
      historyMode: "paginated",
    });
  });

  test("permissions replaces sandbox rather than joining it", () => {
    const params = thread({ orchestrator: { permissions: ":danger-full-access" } });
    expect(params["permissions"]).toBe(":danger-full-access");
    expect(params).not.toHaveProperty("sandbox");
  });

  test("effort is shorthand for a config entry, and an explicit entry wins", () => {
    expect(thread({ orchestrator: { effort: "high" } })["config"]).toEqual({
      model_reasoning_effort: "high",
    });
    expect(
      thread({
        orchestrator: { effort: "high", config: { model_reasoning_effort: "low", other: 1 } },
      })["config"],
    ).toEqual({ model_reasoning_effort: "low", other: 1 });
    expect(thread()).not.toHaveProperty("config");
  });

  test("prompt files become the two instruction fields", () => {
    const params = thread(
      {},
      {
        orchestratorBaseInstructions: "base",
        orchestratorDeveloperInstructions: "dev",
      },
    );
    expect(params["baseInstructions"]).toBe("base");
    expect(params["developerInstructions"]).toBe("dev");
  });

  test("an empty prompt file is sent, an absent one is not", () => {
    const params = thread({}, { orchestratorDeveloperInstructions: "" });
    expect(params["developerInstructions"]).toBe("");
    expect(params).not.toHaveProperty("baseInstructions");
  });

  test("resume omits the start-only fields", () => {
    const values: ConfigValues = {
      orchestrator: { ephemeral: true, "history-mode": "legacy", model: "m" },
    };
    const resumed = thread(values, {}, "resume");
    expect(resumed).not.toHaveProperty("ephemeral");
    expect(resumed).not.toHaveProperty("historyMode");
    expect(resumed).not.toHaveProperty("dynamicTools");
    expect(resumed["model"]).toBe("m");
  });

  test("extra merges last but cannot change the full-access posture", () => {
    expect(() => thread({ orchestrator: { extra: { sandbox: "read-only" } } })).toThrow(
      "full-access-only",
    );
    const params = thread({
      orchestrator: { extra: { sandbox: "danger-full-access", newField: 7 } },
    });
    expect(params["sandbox"]).toBe("danger-full-access");
    expect(params["newField"]).toBe(7);
  });

  test("extra cannot erase AgentVoice thread identity", () => {
    expect(
      thread({ orchestrator: { extra: { threadSource: "something-else" } } })["threadSource"],
    ).toBe("agentvoice-orchestrator");
  });
});

describe("realtimeParams", () => {
  test("carries the transport but leaves protocol selection to Codex when unset", () => {
    expect(realtime()).toEqual({
      threadId: "th_1",
      realtimeSessionId: "rt_1",
      outputModality: "audio",
      transport: { type: "webrtc", sdp: "v=0" },
    });
  });

  test("maps every voice key onto its wire field", () => {
    const params = realtime({
      voice: {
        model: "gpt-realtime",
        name: "cove",
        version: "v3",
        "include-startup-context": false,
        "delegation-ack-filler": true,
        "codex-response-handoff-mode": "commentary",
        "codex-responses-as-items": true,
        "codex-response-item-prefix": "» ",
        "codex-response-handoff-channel-prefixes": { final: ["[R] "] },
        "flush-transcript-tail-on-session-end": true,
        "client-managed-handoffs": false,
      },
    });
    expect(params).toMatchObject({
      model: "gpt-realtime",
      voice: "cove",
      version: "v3",
      includeStartupContext: false,
      delegationAckFiller: true,
      codexResponseHandoffMode: "commentary",
      codexResponsesAsItems: true,
      codexResponseItemPrefix: "» ",
      codexResponseHandoffChannelPrefixes: { final: ["[R] "] },
      flushTranscriptTailOnSessionEnd: true,
      clientManagedHandoffs: false,
    });
  });

  test("VOICE.md replaces the prompt; empty strips it", () => {
    expect(realtime({}, { voicePrompt: "be terse" })["prompt"]).toBe("be terse");
    expect(realtime({}, { voicePrompt: "" })["prompt"]).toBe("");
    expect(realtime()).not.toHaveProperty("prompt");
  });

  test("seeds become initial items in developer, user, assistant order", () => {
    expect(
      realtime(
        { voice: { version: "v3" } },
        {
          voiceSeedAssistant: "hello",
          voiceSeedUser: "do the thing",
          voiceSeedDeveloper: "guidance",
        },
      )["initialItems"],
    ).toEqual([
      { role: "developer", text: "guidance" },
      { role: "user", text: "do the thing" },
      { role: "assistant", text: "hello" },
    ]);
    expect(
      realtime({ voice: { version: "v3" } }, { voiceSeedUser: "only" })["initialItems"],
    ).toEqual([{ role: "user", text: "only" }]);
    expect(realtime()).not.toHaveProperty("initialItems");
  });

  test("session-boundary prompts prime the orchestrator over this call", () => {
    const params = realtime(
      {},
      {
        orchestratorSessionStart: "you are on a call",
        orchestratorSessionEnd: "call over",
      },
    );
    expect(params["realtimeStartInstructions"]).toBe("you are on a call");
    expect(params["realtimeEndInstructions"]).toBe("call over");
  });

  test("extra merges last and can reach fields this config does not name", () => {
    const params = realtime({ voice: { extra: { outputModality: "text", brandNew: true } } });
    expect(params["outputModality"]).toBe("text");
    expect(params["brandNew"]).toBe(true);
  });
});

describe("native voice context controls", () => {
  test("omitted controls stay off the wire so Codex owns their defaults", () => {
    const config = configure();
    expect(config.voice.includeStartupContext).toBeUndefined();
    expect(config.voice.flushTranscriptTailOnSessionEnd).toBeUndefined();
    const params = realtime();
    expect(params).not.toHaveProperty("includeStartupContext");
    expect(params).not.toHaveProperty("flushTranscriptTailOnSessionEnd");
    expect(params).not.toHaveProperty("initialItems");
    for (const kind of ["start", "resume"] as const) {
      expect(thread({}, {}, kind)).not.toHaveProperty("config");
    }
  });

  for (const include of [false, true]) {
    for (const flush of [false, true]) {
      test(`startup context ${include} and tail flush ${flush} remain independent`, () => {
        const values: ConfigValues = {
          voice: {
            "include-startup-context": include,
            "flush-transcript-tail-on-session-end": flush,
          },
        };
        expect(realtime(values)).toEqual({
          ...realtime(),
          includeStartupContext: include,
          flushTranscriptTailOnSessionEnd: flush,
        });
        const overridden = realtime({
          voice: {
            ...values.voice,
            extra: {
              includeStartupContext: !include,
              flushTranscriptTailOnSessionEnd: !flush,
            },
          },
        });
        expect(overridden["includeStartupContext"]).toBe(!include);
        expect(overridden["flushTranscriptTailOnSessionEnd"]).toBe(!flush);
      });
    }
  }

  for (const kind of ["start", "resume"] as const) {
    for (const snapshot of ["", "Explicit startup text"]) {
      test(`${kind}: ${snapshot === "" ? "empty" : "nonempty"} startup override uses thread config unchanged`, () => {
        const codexConfig = { experimental_realtime_ws_startup_context: snapshot };
        const values: ConfigValues = { orchestrator: { config: codexConfig } };
        expect(thread(values, {}, kind)["config"]).toEqual(codexConfig);
        expect(realtime(values)).toEqual(realtime());
        // The upstream include gate, not AgentVoice, controls use of the override.
        expect(
          thread({ ...values, voice: { "include-startup-context": false } }, {}, kind)["config"],
        ).toEqual(codexConfig);
      });
    }

    test(`${kind}: extra.config still replaces the startup override as a whole`, () => {
      const values: ConfigValues = {
        orchestrator: {
          config: { experimental_realtime_ws_startup_context: "Original" },
          extra: { config: { experimental_realtime_ws_startup_context: "" } },
        },
      };
      expect(thread(values, {}, kind)["config"]).toEqual({
        experimental_realtime_ws_startup_context: "",
      });
      expect(
        thread({ orchestrator: { ...values.orchestrator, extra: { config: {} } } }, {}, kind)[
          "config"
        ],
      ).toEqual({});
    });
  }

  test("startup and tail opt-outs do not strip explicit prompt and seed files", () => {
    const params = realtime(
      {
        voice: {
          version: "v3",
          "include-startup-context": false,
          "flush-transcript-tail-on-session-end": false,
        },
      },
      { voicePrompt: "Voice instructions", voiceSeedUser: "Explicit seed" },
    );
    expect(params["prompt"]).toBe("Voice instructions");
    expect(params["initialItems"]).toEqual([{ role: "user", text: "Explicit seed" }]);
  });
});

describe("native skill config passthrough", () => {
  for (const kind of ["start", "resume"] as const) {
    test(`${kind}: no config is manufactured when unset`, () => {
      expect(thread({}, {}, kind)).not.toHaveProperty("config");
    });

    test(`${kind}: other config entries do not cause skill overrides`, () => {
      const values: ConfigValues = {
        orchestrator: { effort: "high", config: { agents: { enabled: false } } },
      };
      const expected = { model_reasoning_effort: "high", agents: { enabled: false } };
      expect(thread(values, {}, kind)["config"]).toEqual(expected);
    });

    test(`${kind}: explicit skill rules pass through unchanged and in order`, () => {
      const supplied = [
        { name: "agent:wiki", enabled: true },
        { name: "agent:wiki", enabled: false },
        { path: "/skills/custom/SKILL.md", enabled: true },
      ];
      const values: ConfigValues = {
        orchestrator: { effort: "high", config: { "skills.config": supplied } },
      };
      const expected = { model_reasoning_effort: "high", "skills.config": supplied };
      expect(thread(values, {}, kind)["config"]).toEqual(expected);
    });

    test(`${kind}: an explicit empty skill list stays empty`, () => {
      const values: ConfigValues = { orchestrator: { config: { "skills.config": [] } } };
      expect(thread(values, {}, kind)["config"]).toEqual({ "skills.config": [] });
    });

    test(`${kind}: extra.config replaces the orchestrator config without augmentation`, () => {
      const extraConfig = { "skills.config": [{ name: "custom", enabled: false }] };
      const values: ConfigValues = {
        orchestrator: {
          effort: "high",
          config: { "skills.config": [{ name: "agent:wiki", enabled: true }] },
          extra: { config: extraConfig },
        },
      };
      expect(thread(values, {}, kind)["config"]).toEqual(extraConfig);
    });

    test(`${kind}: extra.config may remove skill overrides entirely`, () => {
      for (const extraConfig of [{ model_reasoning_effort: "low" }, {}, null]) {
        const values: ConfigValues = {
          orchestrator: {
            config: { "skills.config": [{ name: "agent:wiki", enabled: true }] },
            extra: { config: extraConfig },
          },
        };
        expect(thread(values, {}, kind)["config"]).toEqual(extraConfig);
      }
    });
  }
});
