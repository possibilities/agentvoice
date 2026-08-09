import { describe, expect, test } from "bun:test";
import { type ConfigValues, type Prompts, resolveConfig } from "../src/server/config.ts";
import { realtimeParams, threadParams, workerThreadParams } from "../src/server/params.ts";

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
  test("sends nothing beyond the server's own defaults", () => {
    expect(thread()).toEqual({
      cwd: "/home/tester/.local/state/agentvoice/workspace",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
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
        "approval-policy": "on-request",
        sandbox: "workspace-write",
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
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      runtimeWorkspaceRoots: ["/a"],
      ephemeral: true,
      historyMode: "paginated",
    });
  });

  test("permissions replaces sandbox rather than joining it", () => {
    const params = thread({ orchestrator: { permissions: "profile-a" } });
    expect(params["permissions"]).toBe("profile-a");
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
      orchestrator: { ephemeral: true, "history-mode": "legacy", model: "m", dispatch: true },
    };
    const resumed = thread(values, {}, "resume");
    expect(resumed).not.toHaveProperty("ephemeral");
    expect(resumed).not.toHaveProperty("historyMode");
    expect(resumed).not.toHaveProperty("dynamicTools");
    expect(resumed["model"]).toBe("m");
  });

  test("dispatch declares the worker tools at start only", () => {
    const on = thread({ orchestrator: { dispatch: true } });
    const tools = on["dynamicTools"] as Array<Record<string, unknown>>;
    expect(tools.map((tool) => tool["name"])).toEqual([
      "dispatch_worker",
      "check_workers",
      "cancel_worker",
    ]);
    expect(thread()).not.toHaveProperty("dynamicTools");
    expect(thread({ orchestrator: { dispatch: false } })).not.toHaveProperty("dynamicTools");
  });

  test("dispatch-reports flips the tools' promised behavior on the wire", () => {
    const description = (values: ConfigValues) =>
      String(
        (thread(values)["dynamicTools"] as Array<Record<string, unknown>>)[0]?.["description"],
      );
    expect(description({ orchestrator: { dispatch: true } })).toContain("check_workers");
    expect(description({ orchestrator: { dispatch: true, "dispatch-reports": true } })).toContain(
      "report arrives",
    );
  });

  test("extra merges last and can override", () => {
    const params = thread({ orchestrator: { extra: { sandbox: "read-only", newField: 7 } } });
    expect(params["sandbox"]).toBe("read-only");
    expect(params["newField"]).toBe(7);
  });
});

describe("realtimeParams", () => {
  test("carries the transport and pins v3 with nothing configured", () => {
    expect(realtime()).toEqual({
      threadId: "th_1",
      realtimeSessionId: "rt_1",
      version: "v3",
      outputModality: "audio",
      transport: { type: "webrtc", sdp: "v=0" },
    });
  });

  test("maps every voice key onto its wire field", () => {
    const params = realtime({
      voice: {
        model: "gpt-realtime",
        name: "marin",
        version: "v2",
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
      voice: "marin",
      version: "v2",
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
        {},
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
    expect(realtime({}, { voiceSeedUser: "only" })["initialItems"]).toEqual([
      { role: "user", text: "only" },
    ]);
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

describe("workerThreadParams", () => {
  test("inherits the execution posture but not the identity", () => {
    const params = workerThreadParams(
      configure({
        orchestrator: {
          dispatch: true,
          model: "m",
          effort: "high",
          sandbox: "workspace-write",
          "approval-policy": "on-request",
          "approvals-reviewer": "auto_review",
          config: { agents: { enabled: false } },
        },
      }),
    );
    expect(params["cwd"]).toBe("/home/tester/.local/state/agentvoice/workspace");
    expect(params["sandbox"]).toBe("workspace-write");
    expect(params["approvalPolicy"]).toBe("on-request");
    expect(params["approvalsReviewer"]).toBe("auto_review");
    expect(params["model"]).toBe("m");
    expect(params["config"]).toEqual({
      model_reasoning_effort: "high",
      agents: { enabled: false },
    });
    expect(params).not.toHaveProperty("dynamicTools");
    expect(params).not.toHaveProperty("developerInstructions");
    expect(params).not.toHaveProperty("baseInstructions");
    expect(params).not.toHaveProperty("personality");
  });

  test("prefers a named permission profile over the sandbox, like the orchestrator", () => {
    const params = workerThreadParams(configure({ orchestrator: { permissions: "profile-1" } }));
    expect(params["permissions"]).toBe("profile-1");
    expect(params).not.toHaveProperty("sandbox");
  });
});
