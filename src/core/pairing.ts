/** Pure identity, transcript, and signature primitives shared by pairing and reconnect. */
import { createHash, createPublicKey, type KeyObject, verify, X509Certificate } from "node:crypto";
import { containsAsciiControl } from "./safe-text.ts";

export interface PairingCodeInput {
  serverId: string;
  deviceId: string;
  clientNonce: string;
  serverNonce: string;
}

export interface PairingProofInput extends PairingCodeInput {
  sessionId: string;
}

export interface ControlProofInput {
  challenge: string;
  protocol: number;
  role: "ui" | "voice";
  deviceId: string;
}

export interface ServerProofInput {
  challenge: string;
  serverId: string;
  deviceId: string;
}

export function deviceIdFromPublicKey(publicKey: string): string {
  const key = validateDevicePublicKey(publicKey);
  const spki = key.export({ format: "der", type: "spki" });
  return createHash("sha256").update(spki).digest("base64url");
}

export function serverIdFromCertificate(certificate: string): string {
  if (typeof certificate !== "string" || certificate.length < 1 || certificate.length > 64 * 1024) {
    throw new Error("Server certificate is outside the bounded size");
  }
  return createHash("sha256").update(certificate, "utf8").digest("base64url");
}

export function pairingCode(input: PairingCodeInput): string {
  const digest = createHash("sha256").update(pairingCodePayload(input)).digest();
  const digits = String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

export function pairingProofPayload(input: PairingProofInput): Buffer {
  return encodedTranscript("agentvoice-pairing-proof-v1", [
    input.sessionId,
    input.serverId,
    input.deviceId,
    input.clientNonce,
    input.serverNonce,
  ]);
}

export function controlProofPayload(input: ControlProofInput): Buffer {
  if (!Number.isSafeInteger(input.protocol)) throw new Error("control protocol is invalid");
  return encodedTranscript("agentvoice-control-proof-v1", [
    String(input.protocol),
    input.challenge,
    input.role,
    input.deviceId,
  ]);
}

/**
 * Signed by the Server's identity key over the hello's serverChallenge, so a
 * device can authenticate the Server at the application layer on runtimes
 * whose TLS stack cannot pin the identity certificate.
 */
export function serverProofPayload(input: ServerProofInput): Buffer {
  return encodedTranscript("agentvoice-server-proof-v1", [
    input.challenge,
    input.serverId,
    input.deviceId,
  ]);
}

export function verifyServerSignature(
  certificate: string,
  payload: Uint8Array,
  signature: string,
): boolean {
  try {
    const key = new X509Certificate(certificate).publicKey;
    const decoded = decodeCanonicalBase64Url(signature, "server signature", 256);
    return verify("sha256", payload, key, decoded);
  } catch {
    return false;
  }
}

export function validateDevicePublicKey(publicKey: string): KeyObject {
  const encoded = decodeCanonicalBase64Url(publicKey, "device public key", 512);
  let key: KeyObject;
  try {
    key = createPublicKey({ key: encoded, format: "der", type: "spki" });
  } catch {
    throw new Error("device public key is not a valid SPKI key");
  }
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (key.asymmetricKeyType !== "ec" || (curve !== "prime256v1" && curve !== "P-256")) {
    throw new Error("device public key must be an ECDSA P-256 SPKI key");
  }
  return key;
}

export function verifyDeviceSignature(
  publicKey: string,
  payload: Uint8Array,
  signature: string,
): boolean {
  try {
    const key = validateDevicePublicKey(publicKey);
    const decoded = decodeCanonicalBase64Url(signature, "device signature", 256);
    return verify("sha256", payload, key, decoded);
  } catch {
    return false;
  }
}

function pairingCodePayload(input: PairingCodeInput): Buffer {
  return encodedTranscript("agentvoice-pairing-code-v1", [
    input.serverId,
    input.deviceId,
    input.clientNonce,
    input.serverNonce,
  ]);
}

function encodedTranscript(label: string, fields: string[]): Buffer {
  for (const field of fields) {
    if (
      typeof field !== "string" ||
      field.length === 0 ||
      field.length > 4096 ||
      containsAsciiControl(field)
    ) {
      throw new Error("pairing transcript field is invalid");
    }
  }
  return Buffer.from(JSON.stringify([label, ...fields]), "utf8");
}

function decodeCanonicalBase64Url(value: string, label: string, maximumBytes: number): Buffer {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error(`${label} is not canonical base64url`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length === 0 ||
    decoded.length > maximumBytes ||
    decoded.toString("base64url") !== value
  ) {
    throw new Error(`${label} is not canonical base64url`);
  }
  return decoded;
}
