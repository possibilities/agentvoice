import { describe, expect, test } from "bun:test";
import { TokenVerifier } from "livekit-server-sdk";
import { LIVEKIT_AGENT_NAME } from "../src/livekit-agent.ts";
import { createLiveKitEvaluatorToken, type LiveKitJobMetadata } from "../src/livekit-runner.ts";
import {
  createLocalLiveKitCredentials,
  LIVEKIT_JOB_SHUTDOWN_TIMEOUT_MS,
  LIVEKIT_NUM_IDLE_PROCESSES,
  LIVEKIT_POST_CLEANUP_CONTROL_TIMEOUT_MS,
  LIVEKIT_WORKER_CONTROL_TIMEOUT_MS,
} from "../src/livekit-runtime.ts";

test("local LiveKit admin credentials are fresh for every server", () => {
  const first = createLocalLiveKitCredentials();
  const second = createLocalLiveKitCredentials();

  expect(first.apiKey).not.toBe(second.apiKey);
  expect(first.apiSecret).not.toBe(second.apiSecret);
  expect(first.apiKey).not.toBe("devkey");
  expect(first.apiSecret).not.toBe("secret");
  expect(first.apiSecret.length).toBeGreaterThanOrEqual(32);
});

describe("LiveKit evaluator token", () => {
  test("binds one explicit agent dispatch and the authenticated job metadata", async () => {
    const connection = {
      url: "ws://127.0.0.1:7880",
      apiKey: "devkey",
      apiSecret: "a-secret-that-is-at-least-thirty-two-bytes-long",
    };
    const metadata: LiveKitJobMetadata = {
      schemaVersion: 1,
      runId: "run-1",
      workspace: "/tmp/workspace",
      orchestratorModel: "gpt-5.6-terra",
      reasoningEffort: "medium",
    };
    const jwt = await createLiveKitEvaluatorToken({
      connection,
      roomName: "room-1",
      evaluatorIdentity: "evaluator-1",
      jobMetadata: metadata,
    });
    const claims = await new TokenVerifier(connection.apiKey, connection.apiSecret).verify(jwt);

    expect(claims.video).toMatchObject({
      room: "room-1",
      roomCreate: true,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });
    expect(claims.roomConfig?.name).toBe("room-1");
    expect(claims.roomConfig?.agents).toHaveLength(1);
    expect(claims.roomConfig?.agents[0]).toMatchObject({
      agentName: LIVEKIT_AGENT_NAME,
      metadata: JSON.stringify(metadata),
    });
  });
});

describe("LiveKit worker shutdown bounds", () => {
  test("tracks job executors and gives outer shutdown more time than job cleanup", () => {
    expect(LIVEKIT_NUM_IDLE_PROCESSES).toBeGreaterThan(0);
    expect(LIVEKIT_JOB_SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(60_000);
    expect(LIVEKIT_WORKER_CONTROL_TIMEOUT_MS).toBeGreaterThan(LIVEKIT_JOB_SHUTDOWN_TIMEOUT_MS);
    expect(LIVEKIT_POST_CLEANUP_CONTROL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(LIVEKIT_POST_CLEANUP_CONTROL_TIMEOUT_MS).toBeLessThan(LIVEKIT_JOB_SHUTDOWN_TIMEOUT_MS);
  });
});
