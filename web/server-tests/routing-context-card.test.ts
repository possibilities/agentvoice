import { expect, test } from "bun:test";
import { agentMessage } from "../server/messages.ts";
import { mapCodexItem } from "../src/transcript-ui/lib/api/codex.ts";
import { routingContextPresentation } from "../src/transcript-ui/lib/api/routing-context.ts";
import { groupTranscript } from "../src/transcript-ui/transcript/index.ts";

function output(revision = 1, remaining = 72) {
  return JSON.stringify({
    schema_version: 1,
    type: "routing.context",
    stream_id: "private-stream",
    manager_id: "manager",
    routing_guidance: { private_prose: "do not project" },
    context: {
      mode: revision === 1 ? "full" : "delta",
      producer_generation: 3,
      context_revision: revision,
      digest: "secret-digest",
      payload: {
        current: {
          provider: "codex",
          model: revision === 1 ? "gpt-5.6-sol" : "gpt-5.6-terra",
          effort: "medium",
          service_tier: "priority",
          native: { session_id: "private-thread" },
        },
        quota: {
          delegation_available: true,
          eligible_account_keys: ["private-account"],
          accounts: [
            {
              account_key: "private-account",
              eligible: true,
              lane: {
                windows: [
                  {
                    role: "primary",
                    remaining_percent: remaining,
                    resets_at: "2026-09-18T00:00:00.000Z",
                  },
                ],
              },
            },
          ],
          grok: [],
        },
        observed_at: "2026-09-17T12:00:00.000Z",
        expires_at: "2026-09-17T12:05:00.000Z",
      },
    },
  });
}

function native(id: string, revision = 1, remaining = 72) {
  return {
    type: "functionCallOutput" as const,
    id,
    namespace: "agentusage",
    name: "routing_context",
    output: output(revision, remaining),
  };
}

test("projects routing output to a dedicated privacy-safe transcript message", () => {
  const message = agentMessage({ turnId: "turn", item: native("routing-1") })!;
  expect(message).toMatchObject({
    role: "system",
    nativeItemType: "agentusage.routing_context",
    routingContext: {
      generation: 3,
      revision: 1,
      mode: "full",
      current: { model: "gpt-5.6-sol", effort: "medium", serviceTier: "priority" },
      delegationAvailable: true,
      balances: [{ provider: "Codex", lane: "primary", remainingPercent: 72 }],
    },
  });
  expect(message.toolActivity).toBeUndefined();
  expect(JSON.stringify(message)).not.toContain("private-account");
  expect(JSON.stringify(message)).not.toContain("private-thread");
  expect(JSON.stringify(message)).not.toContain("secret-digest");
  expect(JSON.stringify(message)).not.toContain("private_prose");
});

test("rolls refreshes into one stable block until authored conversation resumes", () => {
  const first = agentMessage({ turnId: "turn-1", item: native("routing-1") })!;
  const second = agentMessage({ turnId: "turn-2", item: native("routing-2", 2, 68) })!;
  const tool = agentMessage({
    turnId: "turn-tool",
    item: {
      type: "functionCallOutput",
      id: "ordinary",
      namespace: "tools",
      name: "lookup",
      output: "done",
    },
  })!;
  const human = {
    id: "human",
    role: "user" as const,
    content: "Continue",
    status: "complete" as const,
  };
  const third = agentMessage({ turnId: "turn-3", item: native("routing-3", 3, 64) })!;
  const blocks = groupTranscript([first, tool, second, human, third]);
  expect(blocks.map((block) => [block.kind, block.id])).toEqual([
    ["routing-context", first.id],
    ["activity", tool.id],
    ["message", human.id],
    ["routing-context", third.id],
  ]);
  expect(
    blocks[0]?.kind === "routing-context"
      ? blocks[0].messages.map((message) => message.id)
      : [],
  ).toEqual([first.id, second.id]);
  expect(blocks[3]?.kind === "routing-context" ? blocks[3].context.current?.model : undefined).toBe(
    "gpt-5.6-terra",
  );
});

test("history projection matches live projection and malformed natural outputs disappear", () => {
  const retained = mapCodexItem({
    threadId: "thread",
    turnId: "turn",
    itemId: "routing-1",
    rolloutOrdinal: 1,
    createdAtMs: 0,
    itemType: "functionCallOutput",
    item: native("routing-1"),
  });
  expect(retained?.routingContext).toEqual(
    agentMessage({ turnId: "turn", item: native("routing-1") })?.routingContext,
  );
  for (const malformed of ["not json", "{}", JSON.stringify({ schema_version: 1 })]) {
    expect(
      agentMessage({
        turnId: "turn",
        item: { ...native("bad"), output: malformed },
      }),
    ).toBeUndefined();
  }
  const hidden = JSON.parse(output()) as Record<string, unknown>;
  (hidden["context"] as Record<string, unknown>)["payload"] = {
    observed_at: "2026-09-17T12:00:00.000Z",
    private_identity: "do not display",
  };
  expect(
    agentMessage({
      turnId: "turn",
      item: { ...native("hidden"), output: JSON.stringify(hidden) },
    }),
  ).toBeUndefined();
  expect(routingContextPresentation(output())).not.toBeNull();
  const ordinary = agentMessage({
    turnId: "turn",
    item: { ...native("ordinary"), namespace: "tools" },
  });
  expect(ordinary?.role).toBe("tool");
  expect(ordinary?.toolActivity?.detail).toBe("tools.routing_context");
});
