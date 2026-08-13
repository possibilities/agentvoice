import { describe, expect, test } from "bun:test";
import {
  AGENTVOICE_VOICE_OBSERVATION_METHOD,
  APP_SERVER_GATEWAY_PROTOCOL,
  PROTOCOL_VERSION,
  parseClientMessage,
  parseServerMessage,
  parseVoiceObservation,
  type WorkerUpdateMessage,
} from "../src/protocol.ts";

describe("parseClientMessage", () => {
  test("preserves a raw voice event payload", () => {
    const payload = {
      type: "response.audio_transcript.delta",
      response_id: "response-1",
      delta: "hello",
      future: { untouched: true },
    };
    const message = {
      type: "oai-event" as const,
      voiceSessionId: "voice-1",
      sequence: 7,
      observedAt: 1_234,
      payload,
    };
    expect(parseClientMessage(JSON.stringify(message))).toEqual({
      ok: true,
      message,
    });
  });

  test("rejects incomplete raw voice events", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "oai-event",
          voiceSessionId: "voice-1",
          sequence: 0,
          observedAt: 1_234,
          payload: "audio",
        }),
      ),
    ).toEqual({
      ok: false,
      code: "bad-oai-event",
      error: "oai-event requires a session id, positive sequence, timestamp, and object payload",
    });
  });

  test("accepts only internally consistent contiguous gaps", () => {
    const message = {
      type: "oai-event-gap" as const,
      voiceSessionId: "voice-1",
      fromSequence: 4,
      toSequence: 6,
      dropped: 3,
      observedAt: 1_234,
    };
    expect(parseClientMessage(JSON.stringify(message))).toEqual({ ok: true, message });
    expect(parseClientMessage(JSON.stringify({ ...message, dropped: 2 }))).toEqual({
      ok: false,
      code: "bad-oai-event-gap",
      error: "oai-event-gap requires one valid contiguous skipped sequence range",
    });
  });
});

describe("parseServerMessage", () => {
  test("round-trips a worker update, dropping junk fields", () => {
    const parsed = parseServerMessage(
      JSON.stringify({
        type: "worker",
        worker: {
          id: "w1",
          title: "lint sweep",
          status: "completed",
          startedAt: 1_000,
          finishedAt: 13_000,
          report: "fixed 3 files",
          junk: true,
        },
      }),
    ) as WorkerUpdateMessage;
    expect(parsed.type).toBe("worker");
    expect(parsed.worker).toEqual({
      id: "w1",
      title: "lint sweep",
      status: "completed",
      startedAt: 1_000,
      finishedAt: 13_000,
      report: "fixed 3 files",
    });
  });

  test("a running worker carries no finish fields", () => {
    const parsed = parseServerMessage(
      JSON.stringify({
        type: "worker",
        worker: { id: "w2", title: "docs", status: "running", startedAt: 5 },
      }),
    ) as WorkerUpdateMessage;
    expect(parsed.worker).toEqual({ id: "w2", title: "docs", status: "running", startedAt: 5 });
  });

  test("stays lenient: malformed workers and unknown types are null", () => {
    expect(parseServerMessage(JSON.stringify({ type: "worker" }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "worker", worker: { id: 3 } }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "sparkles" }))).toBeNull();
    expect(parseServerMessage("not json")).toBeNull();
  });

  test("parses a voice-session redial command", () => {
    expect(
      parseServerMessage(JSON.stringify({ type: "redial", reason: "voice-name-changed" })),
    ).toEqual({ type: "redial", reason: "voice-name-changed" });
    expect(parseServerMessage(JSON.stringify({ type: "redial" }))).toBeNull();
  });

  test("parses voice observation demand", () => {
    expect(
      parseServerMessage(JSON.stringify({ type: "observe-oai-events", enabled: true })),
    ).toEqual({ type: "observe-oai-events", enabled: true });
    expect(
      parseServerMessage(JSON.stringify({ type: "observe-oai-events", enabled: "yes" })),
    ).toBeNull();
  });

  test("requires the server-issued voice session id on answers", () => {
    expect(
      parseServerMessage(
        JSON.stringify({ type: "answer", sdp: "answer-sdp", voiceSessionId: "voice-1" }),
      ),
    ).toEqual({ type: "answer", sdp: "answer-sdp", voiceSessionId: "voice-1" });
    expect(parseServerMessage(JSON.stringify({ type: "answer", sdp: "answer-sdp" }))).toBeNull();
  });
});

describe("voice observations", () => {
  const base = { voiceSessionId: "voice-1", threadId: "thread-1", observedAt: 1_234 };

  test("preserves event payloads and validates gaps", () => {
    const event = {
      kind: "event" as const,
      ...base,
      sequence: 9,
      payload: { type: "response.done", future: { untouched: true } },
    };
    expect(parseVoiceObservation(event)).toEqual(event);
    expect(
      parseVoiceObservation({
        kind: "gap",
        ...base,
        fromSequence: 10,
        toSequence: 12,
        dropped: 3,
      }),
    ).toEqual({
      kind: "gap",
      ...base,
      fromSequence: 10,
      toSequence: 12,
      dropped: 3,
    });
    expect(
      parseVoiceObservation({
        kind: "gap",
        ...base,
        fromSequence: 10,
        toSequence: 12,
        dropped: 2,
      }),
    ).toBeNull();
  });

  test("allows reasons only on ended lifecycle observations", () => {
    expect(parseVoiceObservation({ kind: "lifecycle", ...base, state: "starting" })).toEqual({
      kind: "lifecycle",
      ...base,
      state: "starting",
    });
    expect(
      parseVoiceObservation({
        kind: "lifecycle",
        ...base,
        state: "ended",
        reason: "superseded",
      }),
    ).toEqual({
      kind: "lifecycle",
      ...base,
      state: "ended",
      reason: "superseded",
    });
    expect(
      parseVoiceObservation({
        kind: "lifecycle",
        ...base,
        state: "active",
        reason: "superseded",
      }),
    ).toBeNull();
    expect(parseVoiceObservation({ kind: "lifecycle", ...base, state: "ended" })).toBeNull();
  });
});

test("protocol versions and method identify the additive wire changes", () => {
  expect(PROTOCOL_VERSION).toBe(2);
  expect(APP_SERVER_GATEWAY_PROTOCOL).toBe(3);
  expect(AGENTVOICE_VOICE_OBSERVATION_METHOD).toBe("agentvoice/voice-observation");
});
