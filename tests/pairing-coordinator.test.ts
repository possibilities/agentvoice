import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTROL_PROTOCOL_VERSION,
  type PairBeginCommand,
  type ServerFrame,
} from "../src/core/control-protocol.ts";
import { deviceIdFromPublicKey, pairingCode, pairingProofPayload } from "../src/core/pairing.ts";
import { PairedDeviceStore } from "../src/server/paired-devices.ts";
import { PairingCoordinator } from "../src/server/pairing-coordinator.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("pairing window", () => {
  test("requires matching confirmation on the Server and signed confirmation on the phone", async () => {
    const setup = await coordinator();
    const local: ServerFrame[] = [];
    const phone: ServerFrame[] = [];
    let phoneClosed = false;
    setup.pairing.open({ id: 1, send: (frame) => local.push(frame) });
    expect(local.at(-1)).toEqual({ type: "pairing-state", status: "open", expiresAt: 130_000 });

    expect(
      setup.pairing.begin(
        { id: 2, send: (frame) => phone.push(frame), close: () => (phoneClosed = true) },
        setup.begin,
      ),
    ).toBe(true);
    const challenge = phone.at(-1);
    expect(challenge?.type).toBe("pair-challenge");
    if (challenge?.type !== "pair-challenge") throw new Error("missing pair challenge");
    expect(local.at(-1)).toEqual({
      type: "pairing-state",
      status: "awaiting-confirmation",
      expiresAt: 130_000,
      sessionId: challenge.sessionId,
      code: pairingCode(challenge),
      deviceName: "Samsung",
    });

    setup.pairing.confirmLocal(1, {
      type: "pairing-local-confirm",
      sessionId: challenge.sessionId,
    });
    expect(setup.devices.get(setup.begin.deviceId)).toBeUndefined();
    const signature = sign(
      "sha256",
      pairingProofPayload(challenge),
      setup.keys.privateKey,
    ).toString("base64url");
    setup.pairing.confirmDevice(2, {
      type: "pair-device-confirm",
      sessionId: challenge.sessionId,
      signature,
    });

    expect(setup.devices.get(setup.begin.deviceId)?.name).toBe("Samsung");
    expect(phone.at(-1)).toEqual({
      type: "pair-complete",
      serverId: "server-id",
      serverName: "agentvoice",
      certificate: "certificate",
      deviceId: setup.begin.deviceId,
      endpoints: ["mac.example.ts.net", "100.64.0.2"],
      port: 8473,
    });
    expect(local.at(-1)).toEqual({
      type: "pairing-state",
      status: "complete",
      deviceName: "Samsung",
    });
    expect(phoneClosed).toBe(false);
    expect(setup.pairing.isOpen()).toBe(false);
  });

  test("fails a bad device signature without creating trust", async () => {
    const setup = await coordinator();
    const phone: ServerFrame[] = [];
    let closed = false;
    setup.pairing.open({ id: 1, send: () => {} });
    setup.pairing.begin(
      { id: 2, send: (frame) => phone.push(frame), close: () => (closed = true) },
      setup.begin,
    );
    const challenge = phone[0];
    if (challenge?.type !== "pair-challenge") throw new Error("missing pair challenge");
    setup.pairing.confirmDevice(2, {
      type: "pair-device-confirm",
      sessionId: challenge.sessionId,
      signature: "invalid",
    });
    expect(phone.at(-1)).toEqual({
      type: "pairing-state",
      status: "failed",
      message: "device confirmation signature was rejected",
    });
    expect(closed).toBe(true);
    expect(setup.devices.list()).toEqual([]);
  });

  test("expires a deliberately opened window and closes an in-flight phone", async () => {
    const setup = await coordinator();
    const local: ServerFrame[] = [];
    const phone: ServerFrame[] = [];
    let closed = false;
    setup.pairing.open({ id: 1, send: (frame) => local.push(frame) });
    setup.pairing.begin(
      { id: 2, send: (frame) => phone.push(frame), close: () => (closed = true) },
      setup.begin,
    );
    setup.clock.value = 130_001;
    setup.pairing.tick();
    expect(local.at(-1)).toEqual({
      type: "pairing-state",
      status: "cancelled",
      message: "pairing window expired",
    });
    expect(phone.at(-1)).toEqual({
      type: "pairing-state",
      status: "failed",
      message: "pairing window expired",
    });
    expect(closed).toBe(true);
  });

  test("closes the window when its phone disconnects so the displayed code cannot change", async () => {
    const setup = await coordinator();
    const local: ServerFrame[] = [];
    const replacement: ServerFrame[] = [];
    setup.pairing.open({ id: 1, send: (frame) => local.push(frame) });
    setup.pairing.begin({ id: 2, send: () => {}, close: () => {} }, setup.begin);

    setup.pairing.peerClosed(2);

    expect(local.at(-1)).toEqual({
      type: "pairing-state",
      status: "cancelled",
      message: "phone disconnected during pairing",
    });
    expect(setup.pairing.isOpen()).toBe(false);
    expect(
      setup.pairing.begin(
        { id: 3, send: (frame) => replacement.push(frame), close: () => {} },
        setup.begin,
      ),
    ).toBe(false);
    expect(replacement.at(-1)).toEqual({
      type: "pairing-state",
      status: "failed",
      message: "pairing is not open",
    });
  });
});

async function coordinator() {
  const directory = await mkdtemp(join(tmpdir(), "agentvoice-pairing-"));
  temporaryDirectories.push(directory);
  const devices = PairedDeviceStore.open(join(directory, "paired-devices.json"));
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const begin: PairBeginCommand = {
    type: "pair-begin",
    protocol: CONTROL_PROTOCOL_VERSION,
    deviceId: deviceIdFromPublicKey(publicKey),
    deviceName: "Samsung",
    publicKey,
    clientNonce: Buffer.alloc(24, 3).toString("base64url"),
  };
  const clock = { value: 10_000 };
  let random = 0;
  const pairing = new PairingCoordinator({
    identity: {
      serverId: "server-id",
      serverName: "agentvoice",
      certificate: "certificate",
      privateKey: "unused",
    },
    devices,
    port: 8473,
    endpoints: () => ["mac.example.ts.net", "100.64.0.2"],
    now: () => clock.value,
    randomBytes: (size) => Buffer.alloc(size, ++random),
  });
  return { pairing, devices, keys, begin, clock };
}
