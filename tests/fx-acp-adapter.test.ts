import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultPermissionDecision,
  FxAcpAdapter,
  type FxAcpAdapterOptions,
  outcomeFromStopReason,
} from "../src/fx-acp-adapter.ts";
import type { OrchestratorLifecycleEvent } from "../src/orchestrator-adapter.ts";

const FAKE_SERVER = join(import.meta.dir, "support", "fake-acp-server.ts");
const TURN_TIMEOUT_MS = 5_000;

const adapters: FxAcpAdapter[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.stop()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "agentvoice-acp-test-"));
  directories.push(directory);
  return directory;
}

function adapter(
  overrides: Partial<FxAcpAdapterOptions> = {},
  env: Record<string, string> = {},
): FxAcpAdapter {
  const instance = new FxAcpAdapter({
    workspace: workspace(),
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    launch: { command: "bun", args: [FAKE_SERVER], env },
    requestTimeoutMs: 5_000,
    ...overrides,
  });
  adapters.push(instance);
  return instance;
}

function types(events: readonly OrchestratorLifecycleEvent[]): string[] {
  return events.map((event) => event.type);
}

describe("stop reason mapping", () => {
  test("maps ACP stop reasons onto orchestrator outcomes", () => {
    expect(outcomeFromStopReason("end_turn")).toBe("completed");
    expect(outcomeFromStopReason("cancelled")).toBe("interrupted");
    expect(outcomeFromStopReason("refusal")).toBe("failed");
    expect(outcomeFromStopReason("max_tokens")).toBe("failed");
  });

  test("prefers the least-privileged allow option", () => {
    expect(
      defaultPermissionDecision({
        sessionId: "s",
        options: [
          { optionId: "always", name: "Always", kind: "allow_always" },
          { optionId: "once", name: "Once", kind: "allow_once" },
        ],
      }),
    ).toEqual({ outcome: "selected", optionId: "once" });
    expect(
      defaultPermissionDecision({
        sessionId: "s",
        options: [{ optionId: "only", name: "Only", kind: "reject_once" }],
      }),
    ).toEqual({ outcome: "selected", optionId: "only" });
  });
});

describe("Fx ACP adapter", () => {
  test("starts a session and reports its identity", async () => {
    const instance = adapter();
    const identity = await instance.start();
    expect(identity).toEqual({
      backend: "fx-acp",
      version: "0.0.0-fake",
      buildRevision: null,
      auth: "codex",
      modelSource: "codex",
      permissionMode: "code",
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    });
    expect(instance.capabilities).toEqual({ steering: false, interrupt: true, attention: true });
    expect(types(instance.lifecycleSnapshot())).toEqual(["orchestrator.started"]);
  });

  test("refuses a session whose model is not the requested one", async () => {
    const instance = adapter({}, { FAKE_ACP_MODEL: "gpt-5.6-sol" });
    await expect(instance.start()).rejects.toThrow(
      "gpt-5.6-sol is not the requested gpt-5.6-terra",
    );
  });

  test("runs one prompt as one turn with streamed text", async () => {
    const instance = adapter();
    await instance.start();
    const admission = await instance.admit("say:pong");
    expect(admission).toEqual({
      delegationTurnId: "acp-turn-1",
      disposition: "queued",
      activeTurnId: null,
    });
    const result = await instance.waitForTurn(admission.delegationTurnId, TURN_TIMEOUT_MS);
    expect(result).toEqual({
      turnId: "acp-turn-1",
      outcome: "completed",
      providerDisposition: "end_turn",
      assistantText: "pong",
    });
    const events = instance.lifecycleSnapshot();
    expect(types(events)).toEqual(["orchestrator.started", "turn.started", "turn.ended"]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events[1]?.agentState).toBe("working");
    expect(events[2]?.agentState).toBe("idle");
    await expect(instance.waitForTurn("acp-turn-1", 10)).resolves.toEqual(result);
  });

  test("queues a second admission behind the active turn when steering is unsupported", async () => {
    const instance = adapter();
    await instance.start();
    const first = await instance.admit("slow:300:one");
    const second = await instance.admit("say:two");
    expect(second).toEqual({
      delegationTurnId: "acp-turn-2",
      disposition: "queued",
      activeTurnId: "acp-turn-1",
    });
    expect(instance.capabilities.steering).toBe(false);
    const [one, two] = await Promise.all([
      instance.waitForTurn(first.delegationTurnId, TURN_TIMEOUT_MS),
      instance.waitForTurn(second.delegationTurnId, TURN_TIMEOUT_MS),
    ]);
    expect(one.assistantText).toBe("one");
    expect(two.assistantText).toBe("two");
    expect(types(instance.lifecycleSnapshot())).toEqual([
      "orchestrator.started",
      "turn.started",
      "turn.ended",
      "turn.started",
      "turn.ended",
    ]);
  });

  test("treats an invalid-request answer to the steer probe as unsupported", async () => {
    const instance = adapter({}, { FAKE_ACP_UNKNOWN_CODE: "-32600" });
    await instance.start();
    const first = await instance.admit("slow:300:one");
    const second = await instance.admit("say:two");
    expect(second.disposition).toBe("queued");
    expect(instance.capabilities.steering).toBe(false);
    const [one, two] = await Promise.all([
      instance.waitForTurn(first.delegationTurnId, TURN_TIMEOUT_MS),
      instance.waitForTurn(second.delegationTurnId, TURN_TIMEOUT_MS),
    ]);
    expect([one.assistantText, two.assistantText]).toEqual(["one", "two"]);
  });

  test("steers into the active turn when the server serves _fx/session/steer", async () => {
    const instance = adapter({}, { FAKE_ACP_STEER: "1" });
    await instance.start();
    expect(instance.capabilities.steering).toBe(true);
    const first = await instance.admit("slow:200:base");
    const steered = await instance.admit("tighten");
    expect(steered).toEqual({
      delegationTurnId: "acp-turn-2",
      disposition: "steering",
      activeTurnId: "fake-active-turn",
    });
    const result = await instance.waitForTurn(first.delegationTurnId, TURN_TIMEOUT_MS);
    expect(result.assistantText).toBe(" +steer:tightenbase");
    const entry = await instance.waitForTurn(steered.delegationTurnId, TURN_TIMEOUT_MS);
    expect(entry.outcome).toBe("completed");
  });

  test("interrupts the active turn", async () => {
    const instance = adapter();
    await instance.start();
    const admission = await instance.admit("slow:10000:never");
    await instance.interrupt();
    const result = await instance.waitForTurn(admission.delegationTurnId, TURN_TIMEOUT_MS);
    expect(result.outcome).toBe("interrupted");
    expect(result.providerDisposition).toBe("cancelled");
    await instance.interrupt();
  });

  test("relays permission requests as attention and answers them", async () => {
    const instance = adapter();
    await instance.start();
    const admission = await instance.admit("ask:write");
    const result = await instance.waitForTurn(admission.delegationTurnId, TURN_TIMEOUT_MS);
    expect(result.assistantText).toBe("granted:write");
    const events = instance.lifecycleSnapshot();
    expect(types(events)).toEqual([
      "orchestrator.started",
      "turn.started",
      "attention.raised",
      "attention.cleared",
      "turn.ended",
    ]);
    expect(events[2]).toMatchObject({
      turnId: "acp-turn-1",
      agentState: "blocked",
      attentionKind: "permission",
    });
    expect(events[3]?.agentState).toBe("working");
  });

  test("honors a custom permission handler", async () => {
    const instance = adapter({
      onPermissionRequest: async (request) => ({
        outcome: "selected",
        optionId: request.options.find((option) => option.kind === "reject_once")!.optionId,
      }),
    });
    await instance.start();
    const admission = await instance.admit("ask:write");
    const result = await instance.waitForTurn(admission.delegationTurnId, TURN_TIMEOUT_MS);
    expect(result.assistantText).toBe("denied");
  });

  test("reports a prompt error as a failed turn", async () => {
    const instance = adapter();
    await instance.start();
    const admission = await instance.admit("fail");
    const result = await instance.waitForTurn(admission.delegationTurnId, TURN_TIMEOUT_MS);
    expect(result.outcome).toBe("failed");
    expect(result.assistantText).toContain("boom");
  });

  test("fails the active turn and refuses new work when Fx exits", async () => {
    const instance = adapter();
    await instance.start();
    const admission = await instance.admit("exit");
    const result = await instance.waitForTurn(admission.delegationTurnId, TURN_TIMEOUT_MS);
    expect(result.outcome).toBe("failed");
    expect(result.assistantText).toContain("code 3");
    await expect(instance.admit("say:again")).rejects.toThrow("not running");
    expect(types(instance.lifecycleSnapshot()).at(-1)).toBe("orchestrator.stopped");
  });

  test("times out waiting for a turn that has not ended", async () => {
    const instance = adapter();
    await instance.start();
    const admission = await instance.admit("slow:10000:never");
    await expect(instance.waitForTurn(admission.delegationTurnId, 50)).rejects.toThrow(
      "did not end within 50ms",
    );
  });
});
