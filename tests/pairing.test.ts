import { describe, expect, test } from "bun:test";
import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import {
  controlProofPayload,
  deviceIdFromPublicKey,
  pairingCode,
  pairingProofPayload,
  serverIdFromCertificate,
  serverProofPayload,
  validateDevicePublicKey,
  verifyDeviceSignature,
  verifyServerSignature,
} from "../src/core/pairing.ts";

const device = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicKey = device.publicKey.export({ format: "der", type: "spki" }).toString("base64url");

describe("pairing cryptographic transcript", () => {
  test("derives stable identities and the same six-digit comparison code", () => {
    const certificate = "-----BEGIN CERTIFICATE-----\nexample\n-----END CERTIFICATE-----\n";
    expect(deviceIdFromPublicKey(publicKey)).toBe(
      createHash("sha256")
        .update(device.publicKey.export({ format: "der", type: "spki" }))
        .digest("base64url"),
    );
    expect(serverIdFromCertificate(certificate)).toBe(
      createHash("sha256").update(certificate).digest("base64url"),
    );
    const input = {
      serverId: serverIdFromCertificate(certificate),
      deviceId: deviceIdFromPublicKey(publicKey),
      clientNonce: "client_nonce",
      serverNonce: "server_nonce",
    };
    expect(pairingCode(input)).toMatch(/^\d{3} \d{3}$/);
    expect(pairingCode(input)).toBe(pairingCode({ ...input }));
    expect(pairingCode({ ...input, serverNonce: "different" })).not.toBe(pairingCode(input));
  });

  test("accepts only P-256 SPKI keys and verifies transcript-bound signatures", () => {
    expect(validateDevicePublicKey(publicKey).asymmetricKeyType).toBe("ec");
    const proof = pairingProofPayload({
      sessionId: "session",
      serverId: "server",
      deviceId: deviceIdFromPublicKey(publicKey),
      clientNonce: "client",
      serverNonce: "server-nonce",
    });
    const signature = sign("sha256", proof, device.privateKey).toString("base64url");
    expect(verifyDeviceSignature(publicKey, proof, signature)).toBe(true);
    expect(verifyDeviceSignature(publicKey, Buffer.from("other"), signature)).toBe(false);

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaSpki = rsa.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    expect(() => validateDevicePublicKey(rsaSpki)).toThrow("P-256");
    expect(() => validateDevicePublicKey("%%%")).toThrow("base64url");
  });

  test("binds a control proof to the challenge, role, device, and protocol", () => {
    const first = controlProofPayload({
      challenge: "one",
      protocol: 9,
      role: "ui",
      deviceId: "device",
    });
    expect(first).toEqual(
      controlProofPayload({ challenge: "one", protocol: 9, role: "ui", deviceId: "device" }),
    );
    expect(first).not.toEqual(
      controlProofPayload({ challenge: "two", protocol: 9, role: "ui", deviceId: "device" }),
    );
  });
});

const FIXTURE_KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIL15dvgxakr7NHcdTklqdfcb4jWZdQuRyxPMkvRQWxd5oAoGCCqGSM49
AwEHoUQDQgAEr04eS/umr0nk+U2EqcyFG0e0/UAXgvYuj1AzVZMcsIN+A/PFPlye
eR7k/M8MBCK++I29IzyFtvfczlv2gpmXEw==
-----END EC PRIVATE KEY-----
`;

const FIXTURE_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBcDCCARagAwIBAgIJAJZgQYOZ5MB5MAoGCCqGSM49BAMCMBUxEzARBgNVBAMM
CmFnZW50dm9pY2UwHhcNMjYwODE5MDUzMTU3WhcNNDYwODE0MDUzMTU3WjAVMRMw
EQYDVQQDDAphZ2VudHZvaWNlMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEr04e
S/umr0nk+U2EqcyFG0e0/UAXgvYuj1AzVZMcsIN+A/PFPlyeeR7k/M8MBCK++I29
IzyFtvfczlv2gpmXE6NPME0wFQYDVR0RBA4wDIIKYWdlbnR2b2ljZTAPBgNVHRMB
Af8EBTADAQH/MA4GA1UdDwEB/wQEAwIChDATBgNVHSUEDDAKBggrBgEFBQcDATAK
BggqhkjOPQQDAgNIADBFAiEAkIOZ4q4kQCBx2AQXf5lAuBaVlqfQrrzOFuAJRHSU
f1gCIHvWlCyV0vYJ+b4I3hH48WzzG9jj43CGlyjkltCKzBMv
-----END CERTIFICATE-----
`;

describe("server proof", () => {
  const input = { challenge: "nonce-123", serverId: "server-id", deviceId: "device-id" };

  test("the payload is a stable labeled transcript", () => {
    expect(serverProofPayload(input).toString("utf8")).toBe(
      JSON.stringify(["agentvoice-server-proof-v1", "nonce-123", "server-id", "device-id"]),
    );
  });

  test("a signature by the identity key verifies against the certificate — and nothing else does", () => {
    const payload = serverProofPayload(input);
    const signature = sign("sha256", payload, createPrivateKey(FIXTURE_KEY)).toString("base64url");
    expect(verifyServerSignature(FIXTURE_CERTIFICATE, payload, signature)).toBe(true);
    // A different transcript, a corrupted signature, and a garbage certificate all refuse.
    const other = serverProofPayload({ ...input, challenge: "nonce-124" });
    expect(verifyServerSignature(FIXTURE_CERTIFICATE, other, signature)).toBe(false);
    expect(verifyServerSignature(FIXTURE_CERTIFICATE, payload, "AAAA")).toBe(false);
    expect(verifyServerSignature("not a certificate", payload, signature)).toBe(false);
  });
});
