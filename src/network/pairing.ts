import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import { lstatSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type JsonPeer, JsonSocketServer, type SocketRequest } from "../ipc/json-socket.ts";
import { ownedDirectory } from "../private-files.ts";
import {
  createPrivateJson,
  deviceLabelSchema,
  endpointSchema,
  type NetworkSettings,
  networkDirectory,
  readPrivateJson,
} from "./credentials.ts";
import { NETWORK_PATH, NETWORK_SUBPROTOCOL } from "./protocol.ts";

export const PAIRING_VERSION = 1;
export const PAIRING_QR_PREFIX = "agentvoice-pair:v1:";
export const PAIRING_QR_MAX_BYTES = 2048;
export const PAIRING_PATH = "/v2/pair";
export const CHALLENGE_PATH = "/v2/auth/challenge";
export const PAIRING_WINDOW_MS = 5 * 60_000;
export const PAIRING_RECOVERY_MS = 24 * 60 * 60_000;
export const CHALLENGE_WINDOW_MS = 30_000;
export const PAIRING_SOCKET_VERSION = 1;

const idSchema = z.string().regex(/^[a-f0-9]{32}$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const enrollmentSchema = z.string().regex(/^[a-f0-9]{32}\.[a-f0-9]{64}$/);
const requestIdSchema = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const base64UrlSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);
const challengeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const nonceSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const signatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86,107}$/);

export const pairingQrSchema = z
  .object({
    v: z.literal(PAIRING_VERSION),
    endpoint: endpointSchema,
    enrollment: enrollmentSchema,
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type PairingQr = z.infer<typeof pairingQrSchema>;

export const enrollmentRequestSchema = z
  .object({
    v: z.literal(PAIRING_VERSION),
    enrollment: enrollmentSchema,
    requestId: requestIdSchema,
    label: deviceLabelSchema,
    publicKey: base64UrlSchema,
  })
  .strict();
export type EnrollmentRequest = z.infer<typeof enrollmentRequestSchema>;

export const enrollmentResponseSchema = z
  .object({
    v: z.literal(PAIRING_VERSION),
    deviceId: idSchema,
    serverId: requestIdSchema,
  })
  .strict();
export type EnrollmentResponse = z.infer<typeof enrollmentResponseSchema>;

export const challengeRequestSchema = z
  .object({ v: z.literal(PAIRING_VERSION), deviceId: idSchema })
  .strict();
export const challengeResponseSchema = z
  .object({
    v: z.literal(PAIRING_VERSION),
    challengeId: challengeIdSchema,
    nonce: nonceSchema,
    expiresAt: z.number().int().positive(),
    serverTime: z.number().int().positive(),
  })
  .strict();

export type PairingErrorCode =
  | "invalid_request"
  | "invalid_enrollment"
  | "enrollment_not_ready"
  | "enrollment_consumed"
  | "device_unavailable"
  | "pairing_limited"
  | "challenge_limited"
  | "pairing_unavailable";

export class PairingFailure extends Error {
  constructor(
    readonly code: PairingErrorCode,
    readonly status: number,
  ) {
    super("Pairing request refused");
  }
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function equalDigest(value: string, expected: string): boolean {
  const actual = Buffer.from(digest(value), "hex");
  const wanted = Buffer.from(expected, "hex");
  return actual.byteLength === wanted.byteLength && timingSafeEqual(actual, wanted);
}

function normalizedLabel(value: string): string {
  return deviceLabelSchema.parse(value);
}

function decodeBase64Url(value: string, minimum: number, maximum: number): Buffer {
  if (!base64UrlSchema.safeParse(value).success) throw new PairingFailure("invalid_request", 400);
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.byteLength < minimum ||
    decoded.byteLength > maximum ||
    decoded.toString("base64url") !== value
  )
    throw new PairingFailure("invalid_request", 400);
  return decoded;
}

const P256_SPKI_PREFIX = Buffer.from(
  "3059301306072a8648ce3d020106082a8648ce3d03010703420004",
  "hex",
);

function validatedPublicKey(value: string): { encoded: string; der: Buffer; fingerprint: string } {
  try {
    const der = decodeBase64Url(value, 91, 91);
    if (!der.subarray(0, P256_SPKI_PREFIX.byteLength).equals(P256_SPKI_PREFIX))
      throw new Error("unsupported key encoding");
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (
      key.asymmetricKeyType !== "ec" ||
      key.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
      !key.export({ format: "der", type: "spki" }).equals(der)
    )
      throw new Error("unsupported key");
    return { encoded: der.toString("base64url"), der, fingerprint: digest(der) };
  } catch (error) {
    if (error instanceof PairingFailure) throw error;
    throw new PairingFailure("invalid_request", 400);
  }
}

const pairedRecordSchema = z
  .object({
    version: z.literal(PAIRING_VERSION),
    kind: z.literal("public-key"),
    id: idSchema,
    label: deviceLabelSchema,
    publicKeySpki: base64UrlSchema,
    fingerprint: digestSchema,
    createdAt: z.number().int().positive(),
  })
  .strict();
type PairedRecord = z.infer<typeof pairedRecordSchema>;

const serverIdentitySchema = z
  .object({ version: z.literal(PAIRING_VERSION), id: requestIdSchema })
  .strict();

function privateRecords(path: string): string[] {
  const names = readdirSync(path);
  if (names.length > 1024) throw new PairingFailure("pairing_unavailable", 503);
  return names;
}

function atomicReplacePrivateJson(path: string, value: unknown): void {
  const stage = `${path}.stage.${randomBytes(8).toString("hex")}`;
  try {
    createPrivateJson(stage, value);
    renameSync(stage, path);
  } catch (error) {
    try {
      unlinkSync(stage);
    } catch {}
    throw error;
  }
}

export class PairedDevices {
  readonly directory: string;
  private readonly legacyDirectory: string;
  readonly serverId: string;

  constructor(stateDir: string) {
    const network = networkDirectory(stateDir);
    ownedDirectory(network);
    this.directory = join(network, "paired-devices");
    this.legacyDirectory = join(network, "devices");
    ownedDirectory(this.directory);
    this.serverId = this.loadServerId(network);
  }

  enroll(label: string, publicKey: string, now = Date.now()): string {
    const parsedLabel = normalizedLabel(label);
    const validated = validatedPublicKey(publicKey);
    for (const record of this.records()) {
      if (record.record.fingerprint !== validated.fingerprint) continue;
      if (record.revoked) throw new PairingFailure("device_unavailable", 409);
      return record.record.id;
    }
    let id = "";
    for (let attempt = 0; attempt < 16; attempt++) {
      const candidate = randomBytes(16).toString("hex");
      if (
        !lstatSync(join(this.directory, `${candidate}.json`), { throwIfNoEntry: false }) &&
        !lstatSync(join(this.directory, `${candidate}.revoked.json`), { throwIfNoEntry: false }) &&
        !lstatSync(join(this.legacyDirectory, `${candidate}.json`), { throwIfNoEntry: false }) &&
        !lstatSync(join(this.legacyDirectory, `${candidate}.revoked.json`), {
          throwIfNoEntry: false,
        })
      ) {
        id = candidate;
        break;
      }
    }
    if (!id) throw new PairingFailure("pairing_limited", 429);
    createPrivateJson(
      join(this.directory, `${id}.json`),
      pairedRecordSchema.parse({
        version: PAIRING_VERSION,
        kind: "public-key",
        id,
        label: parsedLabel,
        publicKeySpki: validated.encoded,
        fingerprint: validated.fingerprint,
        createdAt: now,
      }),
    );
    return id;
  }

  active(id: string): boolean {
    return this.read(id) !== undefined;
  }

  publicKey(id: string): Buffer | undefined {
    const record = this.read(id);
    if (!record) return;
    return validatedPublicKey(record.publicKeySpki).der;
  }

  revoke(id: string): boolean {
    if (!idSchema.safeParse(id).success) throw new Error("Invalid device ID");
    const record = this.read(id);
    if (!record) return false;
    renameSync(join(this.directory, `${id}.json`), join(this.directory, `${id}.revoked.json`));
    return true;
  }

  list(): Array<{
    kind: "paired-device";
    id: string;
    label: string;
    createdAt: number;
    active: boolean;
  }> {
    return this.records().map(({ record, revoked }) => ({
      kind: "paired-device",
      id: record.id,
      label: record.label,
      createdAt: record.createdAt,
      active: !revoked,
    }));
  }

  private records(): Array<{ record: PairedRecord; revoked: boolean }> {
    return privateRecords(this.directory)
      .filter((name) => /^[a-f0-9]{32}(\.revoked)?\.json$/.test(name))
      .map((name) => ({
        record: pairedRecordSchema.parse(readPrivateJson(join(this.directory, name))),
        revoked: name.includes(".revoked."),
      }));
  }

  private read(id: string): PairedRecord | undefined {
    if (!idSchema.safeParse(id).success) return;
    try {
      const record = pairedRecordSchema.parse(readPrivateJson(join(this.directory, `${id}.json`)));
      if (
        record.id !== id ||
        validatedPublicKey(record.publicKeySpki).fingerprint !== record.fingerprint
      )
        return;
      return record;
    } catch {
      return;
    }
  }

  private loadServerId(network: string): string {
    const path = join(network, "server-identity.json");
    try {
      return serverIdentitySchema.parse(readPrivateJson(path)).id;
    } catch (error) {
      if (lstatSync(path, { throwIfNoEntry: false })) throw error;
    }
    const record = serverIdentitySchema.parse({ version: PAIRING_VERSION, id: randomUUID() });
    try {
      createPrivateJson(path, record);
      return record.id;
    } catch {
      return serverIdentitySchema.parse(readPrivateJson(path)).id;
    }
  }
}

const enrollmentRecordSchema = z
  .object({
    version: z.literal(PAIRING_VERSION),
    id: idSchema,
    secretHash: digestSchema,
    receiptHash: digestSchema,
    createdAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    state: z.enum(["prepared", "active", "paired"]),
    requestDigest: digestSchema.optional(),
    response: enrollmentResponseSchema.optional(),
    recoveryUntil: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((record, context) => {
    const completed = record.state === "paired";
    if (
      completed !==
      (record.requestDigest !== undefined &&
        record.response !== undefined &&
        record.recoveryUntil !== undefined)
    )
      context.addIssue({ code: "custom", message: "invalid paired enrollment state" });
  });
type EnrollmentRecord = z.infer<typeof enrollmentRecordSchema>;

export type PairingStatus = {
  status: "prepared" | "waiting" | "paired";
  expiresAt: number;
  deviceId?: string;
};

export class PairingCoordinator {
  readonly paired: PairedDevices;
  readonly directory: string;

  constructor(
    stateDir: string,
    private readonly endpoint: string,
  ) {
    this.paired = new PairedDevices(stateDir);
    this.directory = join(networkDirectory(stateDir), "enrollments");
    ownedDirectory(this.directory);
  }

  prepare(now = Date.now()): PairingQr & { receipt: string; payload: string } {
    this.sweep(now);
    const records = this.records();
    if (records.filter((record) => record.state !== "paired").length >= 8)
      throw new PairingFailure("pairing_limited", 429);
    if (privateRecords(this.directory).length >= 1024)
      throw new PairingFailure("pairing_limited", 429);
    let id = "";
    for (let attempt = 0; attempt < 16; attempt++) {
      const candidate = randomBytes(16).toString("hex");
      if (!lstatSync(join(this.directory, `${candidate}.json`), { throwIfNoEntry: false })) {
        id = candidate;
        break;
      }
    }
    if (!id) throw new PairingFailure("pairing_limited", 429);
    const secret = randomBytes(32).toString("hex");
    const receipt = randomBytes(32).toString("hex");
    const expiresAt = now + PAIRING_WINDOW_MS;
    const endpoint = validatedPairingEndpoint(this.endpoint);
    const qr = pairingQrSchema.parse({
      v: PAIRING_VERSION,
      endpoint,
      enrollment: `${id}.${secret}`,
      expiresAt,
    });
    const payload = createPairingQrPayload(qr);
    createPrivateJson(
      join(this.directory, `${id}.json`),
      enrollmentRecordSchema.parse({
        version: PAIRING_VERSION,
        id,
        secretHash: digest(secret),
        receiptHash: digest(receipt),
        createdAt: now,
        expiresAt,
        state: "prepared",
      }),
    );
    return { ...qr, receipt, payload };
  }

  activate(enrollmentId: string, receipt: string, now = Date.now()): PairingStatus {
    const record = this.authorizeLocal(enrollmentId, receipt, now);
    if (record.state === "prepared") {
      const active = enrollmentRecordSchema.parse({ ...record, state: "active" });
      atomicReplacePrivateJson(this.path(record.id), active);
      return this.project(active);
    }
    return this.project(record);
  }

  status(enrollmentId: string, receipt: string, now = Date.now()): PairingStatus {
    return this.project(this.authorizeLocal(enrollmentId, receipt, now));
  }

  cancel(enrollmentId: string, receipt: string, now = Date.now()): PairingStatus | undefined {
    const record = this.authorizeLocal(enrollmentId, receipt, now);
    if (record.state === "paired") return this.project(record);
    renameSync(this.path(record.id), join(this.directory, `${record.id}.cancelled.json`));
    return;
  }

  enroll(value: unknown, now = Date.now()): { response: EnrollmentResponse; recovered: boolean } {
    let request: EnrollmentRequest;
    try {
      request = enrollmentRequestSchema.parse(value);
    } catch {
      throw new PairingFailure("invalid_request", 400);
    }
    const [id, secret] = request.enrollment.split(".") as [string, string];
    const record = this.read(id);
    if (!record || !equalDigest(secret, record.secretHash))
      throw new PairingFailure("invalid_enrollment", 401);
    const publicKey = validatedPublicKey(request.publicKey);
    const label = normalizedLabel(request.label);
    const requestDigest = digest(JSON.stringify([request.requestId, label, publicKey.fingerprint]));
    if (record.state === "paired") {
      if (record.recoveryUntil! <= now || record.requestDigest !== requestDigest)
        throw new PairingFailure("enrollment_consumed", 409);
      return { response: record.response!, recovered: true };
    }
    if (record.expiresAt <= now) {
      this.expire(record);
      throw new PairingFailure("invalid_enrollment", 401);
    }
    if (record.state !== "active") throw new PairingFailure("enrollment_not_ready", 409);
    const deviceId = this.paired.enroll(label, publicKey.encoded, now);
    const response = enrollmentResponseSchema.parse({
      v: PAIRING_VERSION,
      deviceId,
      serverId: this.paired.serverId,
    });
    const paired = enrollmentRecordSchema.parse({
      ...record,
      state: "paired",
      requestDigest,
      response,
      recoveryUntil: now + PAIRING_RECOVERY_MS,
    });
    atomicReplacePrivateJson(this.path(id), paired);
    return { response, recovered: false };
  }

  private authorizeLocal(id: string, receipt: string, now: number): EnrollmentRecord {
    if (!idSchema.safeParse(id).success || !digestSchema.safeParse(receipt).success)
      throw new PairingFailure("invalid_request", 400);
    const record = this.read(id);
    if (!record || !equalDigest(receipt, record.receiptHash))
      throw new PairingFailure("pairing_unavailable", 404);
    if (record.state !== "paired" && record.expiresAt <= now) {
      this.expire(record);
      throw new PairingFailure("pairing_unavailable", 404);
    }
    return record;
  }

  private project(record: EnrollmentRecord): PairingStatus {
    return {
      status: record.state === "active" ? "waiting" : record.state,
      expiresAt: record.expiresAt,
      ...(record.response ? { deviceId: record.response.deviceId } : {}),
    };
  }

  private path(id: string): string {
    return join(this.directory, `${id}.json`);
  }

  private read(id: string): EnrollmentRecord | undefined {
    if (!idSchema.safeParse(id).success) return;
    try {
      const record = enrollmentRecordSchema.parse(readPrivateJson(this.path(id)));
      return record.id === id ? record : undefined;
    } catch {
      return;
    }
  }

  private records(): EnrollmentRecord[] {
    return privateRecords(this.directory)
      .filter((name) => /^[a-f0-9]{32}\.json$/.test(name))
      .map((name) => enrollmentRecordSchema.parse(readPrivateJson(join(this.directory, name))));
  }

  private sweep(now: number): void {
    for (const record of this.records()) {
      if (record.state !== "paired" && record.expiresAt <= now) this.expire(record);
      else if (record.state === "paired" && record.recoveryUntil! <= now)
        renameSync(this.path(record.id), join(this.directory, `${record.id}.consumed.json`));
    }
  }

  private expire(record: EnrollmentRecord): void {
    try {
      renameSync(this.path(record.id), join(this.directory, `${record.id}.expired.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function validatedPairingEndpoint(endpoint: string): string {
  const parsed = endpointSchema.safeParse(endpoint);
  if (!parsed.success) throw new PairingFailure("invalid_request", 400);
  return new URL(parsed.data).toString();
}

export function pairingHttpEndpoint(endpoint: string, path: string): string {
  if (path !== PAIRING_PATH && path !== CHALLENGE_PATH)
    throw new PairingFailure("invalid_request", 400);
  const url = new URL(validatedPairingEndpoint(endpoint));
  url.protocol = "https:";
  url.pathname = path;
  return url.toString();
}

export function createPairingQrPayload(value: unknown): string {
  let qr: PairingQr;
  try {
    qr = pairingQrSchema.parse(value);
    qr = { ...qr, endpoint: validatedPairingEndpoint(qr.endpoint) };
  } catch {
    throw new PairingFailure("invalid_request", 400);
  }
  const payload = `${PAIRING_QR_PREFIX}${JSON.stringify({
    v: qr.v,
    endpoint: qr.endpoint,
    enrollment: qr.enrollment,
    expiresAt: qr.expiresAt,
  })}`;
  if (new TextEncoder().encode(payload).byteLength > PAIRING_QR_MAX_BYTES)
    throw new PairingFailure("invalid_request", 400);
  return payload;
}

export function parsePairingQrPayload(payload: string): PairingQr {
  try {
    if (
      !payload.startsWith(PAIRING_QR_PREFIX) ||
      new TextEncoder().encode(payload).byteLength > PAIRING_QR_MAX_BYTES
    )
      throw new Error("invalid QR");
    const parsed = pairingQrSchema.parse(JSON.parse(payload.slice(PAIRING_QR_PREFIX.length)));
    if (createPairingQrPayload(parsed) !== payload) throw new Error("non-canonical QR");
    return parsed;
  } catch {
    throw new PairingFailure("invalid_request", 400);
  }
}

type ChallengeRecord = {
  deviceId: string;
  nonce: string;
  expiresAt: number;
  reserved: boolean;
};

export interface PairingProofReservation {
  readonly deviceId: string;
  commit(): void;
  release(): void;
}

export class PairingChallenges {
  private readonly challenges = new Map<string, ChallengeRecord>();
  private readonly perDevice = new Map<string, number>();

  constructor(private readonly devices: PairedDevices) {}

  issue(value: unknown, now = Date.now()): z.infer<typeof challengeResponseSchema> {
    let request: z.infer<typeof challengeRequestSchema>;
    try {
      request = challengeRequestSchema.parse(value);
    } catch {
      throw new PairingFailure("invalid_request", 400);
    }
    this.sweep(now);
    if (!this.devices.active(request.deviceId)) throw new PairingFailure("device_unavailable", 404);
    const count = this.perDevice.get(request.deviceId) ?? 0;
    if (this.challenges.size >= 256 || count >= 4)
      throw new PairingFailure("challenge_limited", 429);
    const challengeId = randomBytes(16).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const expiresAt = now + CHALLENGE_WINDOW_MS;
    this.challenges.set(challengeId, {
      deviceId: request.deviceId,
      nonce,
      expiresAt,
      reserved: false,
    });
    this.perDevice.set(request.deviceId, count + 1);
    return challengeResponseSchema.parse({
      v: PAIRING_VERSION,
      challengeId,
      nonce,
      expiresAt,
      serverTime: now,
    });
  }

  reserve(headers: Headers, host: string, now = Date.now()): PairingProofReservation | undefined {
    if (
      headers.has("authorization") ||
      headers.get("x-agentvoice-auth") !== "1" ||
      !idSchema.safeParse(headers.get("x-agentvoice-device") ?? "").success ||
      !challengeIdSchema.safeParse(headers.get("x-agentvoice-challenge") ?? "").success ||
      !signatureSchema.safeParse(headers.get("x-agentvoice-signature") ?? "").success
    )
      return;
    const deviceId = headers.get("x-agentvoice-device")!;
    const challengeId = headers.get("x-agentvoice-challenge")!;
    const signatureText = headers.get("x-agentvoice-signature")!;
    const record = this.challenges.get(challengeId);
    if (
      !record ||
      record.reserved ||
      record.deviceId !== deviceId ||
      record.expiresAt <= now ||
      !this.devices.active(deviceId)
    )
      return;
    record.reserved = true;
    try {
      const signature = decodeBase64Url(signatureText, 64, 80);
      const publicKey = this.devices.publicKey(deviceId);
      if (!publicKey) throw new Error("missing key");
      const key = createPublicKey({ key: publicKey, format: "der", type: "spki" });
      if (
        !verifySignature(
          "sha256",
          pairingSignatureInput(deviceId, challengeId, record.nonce, host),
          key,
          signature,
        )
      )
        throw new Error("invalid proof");
    } catch {
      record.reserved = false;
      return;
    }
    let settled = false;
    return {
      deviceId,
      commit: () => {
        if (settled) return;
        settled = true;
        this.remove(challengeId, record);
      },
      release: () => {
        if (settled) return;
        settled = true;
        if (record.expiresAt > Date.now() && this.devices.active(deviceId)) record.reserved = false;
        else this.remove(challengeId, record);
      },
    };
  }

  private sweep(now: number): void {
    for (const [challengeId, record] of this.challenges) {
      if (record.expiresAt <= now) this.remove(challengeId, record);
    }
  }

  private remove(challengeId: string, record: ChallengeRecord): void {
    if (!this.challenges.delete(challengeId)) return;
    const count = (this.perDevice.get(record.deviceId) ?? 1) - 1;
    if (count <= 0) this.perDevice.delete(record.deviceId);
    else this.perDevice.set(record.deviceId, count);
  }
}

function appendField(parts: Buffer[], value: Buffer): void {
  if (value.byteLength > 0xffff) throw new PairingFailure("invalid_request", 400);
  const length = Buffer.allocUnsafe(2);
  length.writeUInt16BE(value.byteLength);
  parts.push(length, value);
}

export function pairingSignatureInput(
  deviceId: string,
  challengeId: string,
  nonce: string,
  authority: string,
): Buffer {
  if (
    !idSchema.safeParse(deviceId).success ||
    !challengeIdSchema.safeParse(challengeId).success ||
    !nonceSchema.safeParse(nonce).success ||
    !/^([a-z0-9.-]+|\[[0-9a-f:]+\])(:[0-9]{1,5})?$/.test(authority)
  )
    throw new PairingFailure("invalid_request", 400);
  const parts = [Buffer.from("AgentVoice device-auth v1\0", "ascii")];
  for (const field of [
    Buffer.from(deviceId, "utf8"),
    Buffer.from(challengeId, "utf8"),
    decodeBase64Url(nonce, 32, 32),
    Buffer.from("GET", "ascii"),
    Buffer.from(authority, "utf8"),
    Buffer.from(NETWORK_PATH, "ascii"),
    Buffer.from(NETWORK_SUBPROTOCOL, "ascii"),
  ])
    appendField(parts, field);
  return Buffer.concat(parts);
}

const localPrepareSchema = z.object({}).strict();
const localMutationSchema = z.object({ enrollmentId: idSchema, receipt: digestSchema }).strict();

export function pairingSocketPath(stateDir: string): string {
  return join(networkDirectory(stateDir), "pairing.sock");
}

export class PairingControlServer {
  private readonly socket: JsonSocketServer;

  constructor(
    stateDir: string,
    private readonly pairing: PairingCoordinator,
  ) {
    this.socket = new JsonSocketServer(pairingSocketPath(stateDir), {
      version: PAIRING_SOCKET_VERSION,
      handle: (request, peer) => this.handle(request, peer),
    });
  }

  start(): Promise<void> {
    return this.socket.start();
  }

  close(): void {
    this.socket.close();
  }

  private handle(request: SocketRequest, peer: JsonPeer): void {
    try {
      let result: unknown;
      if (request.method === "prepare") {
        localPrepareSchema.parse(request.params);
        const prepared = this.pairing.prepare();
        result = {
          enrollmentId: prepared.enrollment.slice(0, 32),
          receipt: prepared.receipt,
          payload: prepared.payload,
          expiresAt: prepared.expiresAt,
        };
      } else if (request.method === "activate") {
        const params = localMutationSchema.parse(request.params);
        result = this.pairing.activate(params.enrollmentId, params.receipt);
      } else if (request.method === "status") {
        const params = localMutationSchema.parse(request.params);
        result = this.pairing.status(params.enrollmentId, params.receipt);
      } else if (request.method === "cancel") {
        const params = localMutationSchema.parse(request.params);
        result = this.pairing.cancel(params.enrollmentId, params.receipt) ?? {
          status: "cancelled",
        };
      } else throw new PairingFailure("invalid_request", 400);
      peer.send({
        v: PAIRING_SOCKET_VERSION,
        type: "response",
        id: request.id,
        ok: true,
        result,
      });
    } catch (error) {
      const code = error instanceof PairingFailure ? error.code : "invalid_request";
      peer.send({
        v: PAIRING_SOCKET_VERSION,
        type: "response",
        id: request.id,
        ok: false,
        error: { code, message: "Pairing request refused" },
      });
    }
  }
}

export function pairingSettings(settings: NetworkSettings): { endpoint: string; host: string } {
  const endpoint = validatedPairingEndpoint(settings.endpoint);
  return { endpoint, host: new URL(endpoint).host };
}
