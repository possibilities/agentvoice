import { expect, test } from "bun:test";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frontendSocketPath } from "../src/frontend/protocol.ts";
import { VoiceServer } from "../src/frontend/server.ts";
import { ControlSocket } from "../src/ipc/control-client.ts";
import { NetworkGateway } from "../src/network/gateway.ts";
import {
  CHALLENGE_PATH,
  createPairingQrPayload,
  PAIRING_PATH,
  PAIRING_RECOVERY_MS,
  PAIRING_WINDOW_MS,
  PairingChallenges,
  PairingControlServer,
  PairingCoordinator,
  PairingFailure,
  pairingHttpEndpoint,
  pairingSignatureInput,
  pairingSocketPath,
  parsePairingQrPayload,
} from "../src/network/pairing.ts";
import { NETWORK_SUBPROTOCOL } from "../src/network/protocol.ts";

const endpoint = "wss://voice.example:48414/v2/client";
const publicKey =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEaxfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpZP40Li_hp_m47n60p8D54WK84zV2sxXs7LtkBoN79R9Q";
const privateKey = createPrivateKey({
  key: {
    kty: "EC",
    crv: "P-256",
    x: "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY",
    y: "T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU",
    d: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE",
  },
  format: "jwk",
});
const requestId = "11111111-1111-4111-8111-111111111111";
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/pairing-v1.json", import.meta.url), "utf8"),
) as {
  qr: {
    payload: string;
    value: {
      v: 1;
      endpoint: string;
      enrollment: string;
      expiresAt: number;
    };
    pairUrl: string;
    challengeUrl: string;
  };
  deviceProof: {
    publicKey: string;
    deviceId: string;
    challengeId: string;
    nonce: string;
    authority: string;
    signingBytesHex: string;
    signingBytesSha256: string;
    signature: string;
  };
};

function temporaryState(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "av-pairing-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function prepared(coordinator: PairingCoordinator, now: number) {
  const pending = coordinator.prepare(now);
  const qr = parsePairingQrPayload(pending.payload);
  return {
    pending,
    qr,
    body: {
      v: 1 as const,
      enrollment: qr.enrollment,
      requestId,
      label: "Pixel 9",
      publicKey,
    },
  };
}

test("durable pairing QR is canonical, short-lived and derives only same-authority HTTPS paths", () => {
  const qr = fixture.qr.value;
  const payload = createPairingQrPayload(qr);
  expect(payload).toBe(fixture.qr.payload);
  expect(parsePairingQrPayload(payload)).toEqual(qr);
  expect(pairingHttpEndpoint(endpoint, PAIRING_PATH)).toBe(fixture.qr.pairUrl);
  expect(pairingHttpEndpoint(endpoint, CHALLENGE_PATH)).toBe(fixture.qr.challengeUrl);
  for (const invalid of [
    ` ${payload}`,
    payload.replace("agentvoice-pair:v1:", "agentvoice-pair:v2:"),
    payload.replace("wss://", "ws://"),
    payload.replace("/v2/client", "/other"),
    `${payload} `,
  ])
    expect(() => parsePairingQrPayload(invalid)).toThrow(PairingFailure);
});

test("render acknowledgement gates one-use enrollment and exact response recovery survives restart", () => {
  temporaryState((root) => {
    const now = 1_800_000_000_000;
    const first = new PairingCoordinator(root, endpoint);
    const { pending, qr, body } = prepared(first, now);
    expect(qr.expiresAt).toBe(now + PAIRING_WINDOW_MS);
    expect(() => first.enroll(body, now)).toThrow("Pairing request refused");
    expect(first.status(qr.enrollment.slice(0, 32), pending.receipt, now).status).toBe("prepared");
    expect(first.activate(qr.enrollment.slice(0, 32), pending.receipt, now).status).toBe("waiting");
    const created = first.enroll(body, now);
    expect(created.recovered).toBe(false);
    expect(created.response.serverId).toMatch(/^[a-f0-9-]{36}$/);
    expect(first.paired.active(created.response.deviceId)).toBe(true);
    expect(first.status(qr.enrollment.slice(0, 32), pending.receipt, now)).toMatchObject({
      status: "paired",
      deviceId: created.response.deviceId,
    });
    const enrollmentRecord = readFileSync(
      join(first.directory, `${qr.enrollment.slice(0, 32)}.json`),
      "utf8",
    );
    expect(enrollmentRecord).not.toContain(qr.enrollment.slice(33));
    expect(enrollmentRecord).not.toContain(pending.receipt);
    expect(
      statSync(join(first.paired.directory, `${created.response.deviceId}.json`)).mode & 0o777,
    ).toBe(0o600);

    const restarted = new PairingCoordinator(root, endpoint);
    expect(restarted.enroll(body, now + 1000)).toEqual({
      response: created.response,
      recovered: true,
    });
    expect(() =>
      restarted.enroll({ ...body, requestId: "22222222-2222-4222-8222-222222222222" }, now + 1000),
    ).toThrow("Pairing request refused");
    expect(() => restarted.enroll(body, now + PAIRING_RECOVERY_MS + 1)).toThrow(
      "Pairing request refused",
    );
  });
});

test("cancelled and expired QR capabilities cannot pair while durable devices have no expiry", () => {
  temporaryState((root) => {
    const now = 1_800_000_000_000;
    const coordinator = new PairingCoordinator(root, endpoint);
    const cancelled = prepared(coordinator, now);
    coordinator.activate(cancelled.qr.enrollment.slice(0, 32), cancelled.pending.receipt, now);
    expect(
      coordinator.cancel(cancelled.qr.enrollment.slice(0, 32), cancelled.pending.receipt, now),
    ).toBeUndefined();
    expect(() => coordinator.enroll(cancelled.body, now)).toThrow("Pairing request refused");

    const expired = prepared(coordinator, now);
    coordinator.activate(expired.qr.enrollment.slice(0, 32), expired.pending.receipt, now);
    expect(() => coordinator.enroll(expired.body, now + PAIRING_WINDOW_MS)).toThrow(
      "Pairing request refused",
    );

    const durable = prepared(coordinator, now + PAIRING_WINDOW_MS + 1);
    coordinator.activate(
      durable.qr.enrollment.slice(0, 32),
      durable.pending.receipt,
      now + PAIRING_WINDOW_MS + 1,
    );
    const { response } = coordinator.enroll(durable.body, now + PAIRING_WINDOW_MS + 1);
    expect(coordinator.paired.active(response.deviceId)).toBe(true);
    expect(coordinator.paired.list()[0]).not.toHaveProperty("expiresAt");
    coordinator.paired.revoke(response.deviceId);
    expect(coordinator.paired.active(response.deviceId)).toBe(false);
    expect(coordinator.paired.list()[0]).toMatchObject({
      kind: "paired-device",
      active: false,
    });
  });
});

test("signature bytes match the Android interop vector and every challenge is single-use", () => {
  temporaryState((root) => {
    const vectorInput = pairingSignatureInput(
      fixture.deviceProof.deviceId,
      fixture.deviceProof.challengeId,
      fixture.deviceProof.nonce,
      fixture.deviceProof.authority,
    );
    expect(vectorInput.toString("hex")).toBe(fixture.deviceProof.signingBytesHex);
    expect(createHash("sha256").update(vectorInput).digest("hex")).toBe(
      fixture.deviceProof.signingBytesSha256,
    );
    expect(
      verify(
        "sha256",
        vectorInput,
        createPublicKey({
          key: Buffer.from(fixture.deviceProof.publicKey, "base64url"),
          format: "der",
          type: "spki",
        }),
        Buffer.from(fixture.deviceProof.signature, "base64url"),
      ),
    ).toBe(true);

    const now = 1_800_000_000_000;
    const coordinator = new PairingCoordinator(root, endpoint);
    const enrollment = prepared(coordinator, now);
    coordinator.activate(enrollment.qr.enrollment.slice(0, 32), enrollment.pending.receipt, now);
    const { deviceId } = coordinator.enroll(enrollment.body, now).response;
    const challenges = new PairingChallenges(coordinator.paired);
    const issued = challenges.issue({ v: 1, deviceId }, now);
    const authority = "voice.example:48414";
    const signature = sign(
      "sha256",
      pairingSignatureInput(deviceId, issued.challengeId, issued.nonce, authority),
      privateKey,
    ).toString("base64url");
    const headers = new Headers({
      "X-AgentVoice-Auth": "1",
      "X-AgentVoice-Device": deviceId,
      "X-AgentVoice-Challenge": issued.challengeId,
      "X-AgentVoice-Signature": signature,
    });
    const reserved = challenges.reserve(headers, authority, now + 1);
    expect(reserved?.deviceId).toBe(deviceId);
    expect(challenges.reserve(headers, authority, now + 1)).toBeUndefined();
    reserved?.release();
    const retried = challenges.reserve(headers, authority, now + 1);
    expect(retried?.deviceId).toBe(deviceId);
    retried?.commit();
    expect(challenges.reserve(headers, authority, now + 1)).toBeUndefined();

    const altered = challenges.issue({ v: 1, deviceId }, now);
    const alteredHeaders = new Headers(headers);
    alteredHeaders.set("X-AgentVoice-Challenge", altered.challengeId);
    expect(challenges.reserve(alteredHeaders, authority, now + 1)).toBeUndefined();
  });
});

test("private pairing socket supports prepare, render activation, status and cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-pairing-socket-"));
  const coordinator = new PairingCoordinator(root, endpoint);
  const server = new PairingControlServer(root, coordinator);
  await server.start();
  try {
    expect(statSync(pairingSocketPath(root)).mode & 0o777).toBe(0o600);
    const client = await ControlSocket.connect(pairingSocketPath(root), 1);
    const pending = (await client.request("prepare", {})) as {
      enrollmentId: string;
      receipt: string;
      payload: string;
    };
    expect(parsePairingQrPayload(pending.payload).enrollment.startsWith(pending.enrollmentId)).toBe(
      true,
    );
    const reference = { enrollmentId: pending.enrollmentId, receipt: pending.receipt };
    expect(await client.request("activate", reference)).toMatchObject({ status: "waiting" });
    expect(await client.request("status", reference)).toMatchObject({ status: "waiting" });
    expect(await client.request("cancel", reference)).toEqual({ status: "cancelled" });
    await expect(client.request("status", reference)).rejects.toThrow("Pairing request refused");
    client.close();
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP enrollment and signed auth-only WSS upgrade never start a call", async () => {
  const root = mkdtempSync(join(tmpdir(), "av-pairing-http-"));
  let starts = 0;
  const voice = new VoiceServer(frontendSocketPath(root), async () => ({
    state: () => ({
      available: true,
      codingActivity: "unknown" as const,
      phase: "live" as const,
      mic: { muted: true, effectiveMuted: true },
      speaker: { muted: true, effectiveMuted: true },
    }),
    start: async () => {
      starts++;
    },
    close: async () => {},
    command: () => {},
    clientMedia: () => {},
  }));
  await voice.start();
  const gateway = new NetworkGateway(root, voice.path, { version: 1, endpoint, port: 0 });
  await gateway.start();
  try {
    const control = await ControlSocket.connect(pairingSocketPath(root), 1);
    const pending = (await control.request("prepare", {})) as {
      enrollmentId: string;
      receipt: string;
      payload: string;
    };
    await control.request("activate", {
      enrollmentId: pending.enrollmentId,
      receipt: pending.receipt,
    });
    const qr = parsePairingQrPayload(pending.payload);
    const base = `http://127.0.0.1:${gateway.port}`;
    const enrollment = await fetch(`${base}${PAIRING_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        v: 1,
        enrollment: qr.enrollment,
        requestId,
        label: "Pixel 9",
        publicKey,
      }),
    });
    expect(enrollment.status).toBe(201);
    const response = (await enrollment.json()) as { deviceId: string };
    expect(starts).toBe(0);
    const challengeResponse = await fetch(`${base}${CHALLENGE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v: 1, deviceId: response.deviceId }),
    });
    expect(challengeResponse.status).toBe(200);
    const challenge = (await challengeResponse.json()) as {
      challengeId: string;
      nonce: string;
    };
    const authority = `127.0.0.1:${gateway.port}`;
    const signature = sign(
      "sha256",
      pairingSignatureInput(response.deviceId, challenge.challengeId, challenge.nonce, authority),
      privateKey,
    ).toString("base64url");
    const ws = new WebSocket(`${base.replace("http:", "ws:")}/v2/client`, {
      protocols: [NETWORK_SUBPROTOCOL],
      headers: {
        "X-AgentVoice-Auth": "1",
        "X-AgentVoice-Device": response.deviceId,
        "X-AgentVoice-Challenge": challenge.challengeId,
        "X-AgentVoice-Signature": signature,
      },
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("signed upgrade failed")));
    });
    expect(starts).toBe(0);
    ws.close();
    control.close();
  } finally {
    await gateway.close();
    await voice.close();
    rmSync(root, { recursive: true, force: true });
  }
});
