import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LiveKitTelemetryClient,
  type LiveKitTelemetryRecord,
  LiveKitTelemetryServer,
} from "../src/livekit-telemetry.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("LiveKit telemetry bridge", () => {
  test("authenticates a run and preserves strict event order", async () => {
    const socketPath = temporarySocket();
    const records: LiveKitTelemetryRecord[] = [];
    const server = new LiveKitTelemetryServer({
      socketPath,
      runId: "run-1",
      onRecord: (record) => records.push(record),
    });
    await server.start();
    const client = new LiveKitTelemetryClient({ socketPath, runId: "run-1" });

    await Promise.all([
      client.emit("livekit", "voice.session.started", { model: "gpt-realtime-2.1" }),
      client.emit("fx", "orchestrator.turn.started", { turnId: "41" }),
    ]);

    expect(records.map(({ sequence, source, type }) => ({ sequence, source, type }))).toEqual([
      { sequence: 1, source: "livekit", type: "voice.session.started" },
      { sequence: 2, source: "fx", type: "orchestrator.turn.started" },
    ]);
    expect(records.every((record) => /^\d+$/.test(record.monotonicNs))).toBe(true);
    await server.close();
  });

  test("rejects records attributed to another run", async () => {
    const socketPath = temporarySocket();
    const protocolErrors: Error[] = [];
    const server = new LiveKitTelemetryServer({
      socketPath,
      runId: "run-1",
      onRecord: () => {},
      onProtocolError: (error) => protocolErrors.push(error),
    });
    await server.start();
    const client = new LiveKitTelemetryClient({ socketPath, runId: "run-2" });

    await expect(client.emit("livekit", "voice.session.started")).rejects.toThrow("another run");
    expect(protocolErrors.map((error) => error.message)).toEqual([
      "LiveKit telemetry record came from another run",
    ]);
    await server.close();
  });

  test("rejects trailing records on one connection", async () => {
    const socketPath = temporarySocket();
    const protocolErrors: Error[] = [];
    const server = new LiveKitTelemetryServer({
      socketPath,
      runId: "run-1",
      onRecord: () => {},
      onProtocolError: (error) => protocolErrors.push(error),
    });
    await server.start();

    const record = JSON.stringify({
      schemaVersion: 1,
      runId: "run-1",
      sequence: 1,
      monotonicNs: "1",
      source: "livekit",
      type: "voice.session.started",
      data: {},
    });
    await rawSend(socketPath, `${record}\n${record}\n`);

    expect(protocolErrors[0]?.message).toBe(
      "LiveKit telemetry connection carried more than one record",
    );
    await server.close();
  });
});

function temporarySocket(): string {
  const directory = mkdtempSync(join(tmpdir(), "agentvoice-livekit-telemetry-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "telemetry.sock");
}

function rawSend(socketPath: string, text: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ path: socketPath });
    let reply = "";
    socket.once("error", reject);
    socket.on("data", (chunk: Buffer) => {
      reply += chunk.toString("utf8");
    });
    socket.once("connect", () => socket.end(text));
    socket.once("end", () => resolvePromise(reply));
  });
}
