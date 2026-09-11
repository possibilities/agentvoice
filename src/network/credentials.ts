import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { ownedDirectory, safeAncestors } from "../private-files.ts";

export const endpointSchema = z
  .string()
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      url.protocol === "wss:" &&
      url.pathname === "/v2/client" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  }, "Use wss://hostname:port/v2/client without credentials, query or fragment");
export const networkSettingsSchema = z
  .object({
    version: z.literal(1),
    endpoint: endpointSchema,
    port: z.number().int().min(1024).max(65535),
  })
  .strict();
export type NetworkSettings = z.infer<typeof networkSettingsSchema>;
export const connectionProfileSchema = z
  .object({
    version: z.literal(1),
    endpoint: endpointSchema,
    token: z.string().regex(/^[a-f0-9]{32}\.[a-f0-9]{64}$/),
  })
  .strict();
export type ConnectionProfile = z.infer<typeof connectionProfileSchema>;
export const deviceLabelSchema = z
  .string()
  .refine((value) => {
    const normalized = value.normalize("NFC");
    const length = [...normalized].length;
    return length >= 1 && length <= 80 && !/\p{Cc}/u.test(normalized);
  }, "Device label must not contain control characters")
  .transform((value) => value.normalize("NFC"));
const recordSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{32}$/),
    label: deviceLabelSchema,
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int().positive(),
  })
  .strict();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

type DeviceRecord = z.infer<typeof recordSchema>;
export interface PendingDeviceGrant {
  readonly id: string;
  readonly profile: ConnectionProfile;
  readonly expiresAt: number;
}
const pendingRecords = new WeakMap<
  PendingDeviceGrant,
  { directory: string; record: DeviceRecord }
>();

export function readPrivateJson(path: string): unknown {
  if (!isAbsolute(path)) throw new Error("Private file path must be absolute");
  safeAncestors(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 8192
    )
      throw new Error("Unsafe private network file");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}
export function createPrivateJson(path: string, value: unknown): void {
  if (!isAbsolute(path)) throw new Error("Private file path must be absolute");
  safeAncestors(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}
export function loadConnectionProfile(path: string): ConnectionProfile {
  // Validation errors must never render the credential value.
  try {
    return connectionProfileSchema.parse(readPrivateJson(path));
  } catch {
    throw new Error("Connection profile is missing, unsafe or invalid");
  }
}
export function networkDirectory(stateDir: string): string {
  return join(stateDir, "network");
}
export function loadNetworkSettings(stateDir: string): NetworkSettings | undefined {
  const path = join(networkDirectory(stateDir), "settings.json");
  if (!lstatSync(path, { throwIfNoEntry: false })) return;
  return networkSettingsSchema.parse(readPrivateJson(path));
}
export function disableNetwork(stateDir: string): void {
  const path = join(networkDirectory(stateDir), "settings.json");
  if (!loadNetworkSettings(stateDir)) return;
  renameSync(
    path,
    join(networkDirectory(stateDir), `settings.disabled.${randomBytes(8).toString("hex")}.json`),
  );
}
export function configureNetwork(stateDir: string, settings: NetworkSettings): void {
  const directory = networkDirectory(stateDir);
  ownedDirectory(directory);
  const path = join(directory, "settings.json");
  const existing = loadNetworkSettings(stateDir);
  if (existing) {
    if (JSON.stringify(existing) === JSON.stringify(settings)) return;
    throw new Error(
      "Network already configured; preserve its settings and explicitly review endpoint changes",
    );
  }
  createPrivateJson(path, networkSettingsSchema.parse(settings));
}

export class DeviceCredentials {
  readonly directory: string;
  constructor(stateDir: string) {
    this.directory = join(networkDirectory(stateDir), "devices");
    ownedDirectory(this.directory);
  }
  prepareGrant(label: string, endpoint: string, now = Date.now()): PendingDeviceGrant {
    if (readdirSync(this.directory).length >= 1024)
      throw new Error(
        "Device record limit reached; archive expired or revoked records before granting more",
      );
    const parsedLabel = deviceLabelSchema.parse(label);
    const parsedEndpoint = endpointSchema.parse(endpoint);
    const id = randomBytes(16).toString("hex");
    const token = `${id}.${randomBytes(32).toString("hex")}`;
    const record = recordSchema.parse({
      id,
      label: parsedLabel,
      hash: hash(token),
      expiresAt: now + 30 * 86400_000,
    });
    const profile = connectionProfileSchema.parse({ version: 1, endpoint: parsedEndpoint, token });
    const pending = Object.freeze({
      id,
      profile: Object.freeze(profile),
      expiresAt: record.expiresAt,
    });
    pendingRecords.set(pending, { directory: this.directory, record });
    return pending;
  }
  activateGrant(pending: PendingDeviceGrant): string {
    const prepared = pendingRecords.get(pending);
    if (!prepared || prepared.directory !== this.directory)
      throw new Error("Pending device grant is invalid or already activated");
    if (readdirSync(this.directory).length >= 1024)
      throw new Error(
        "Device record limit reached; archive expired or revoked records before granting more",
      );
    createPrivateJson(join(this.directory, `${prepared.record.id}.json`), prepared.record);
    pendingRecords.delete(pending);
    return prepared.record.id;
  }
  grant(label: string, endpoint: string, output: string, now = Date.now()): string {
    const pending = this.prepareGrant(label, endpoint, now);
    // Publish profile first: an interrupted grant cannot leave an undisclosed active credential.
    createPrivateJson(output, pending.profile);
    return this.activateGrant(pending);
  }
  authenticate(token: string, now = Date.now()): string | undefined {
    if (!/^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(token)) return;
    const id = token.slice(0, 32);
    try {
      const record = recordSchema.parse(readPrivateJson(join(this.directory, `${id}.json`)));
      if (record.id !== id || record.expiresAt <= now) return;
      if (!timingSafeEqual(Buffer.from(record.hash, "hex"), Buffer.from(hash(token), "hex")))
        return;
      return id;
    } catch {
      return;
    }
  }
  active(id: string, now = Date.now()): boolean {
    if (!/^[a-f0-9]{32}$/.test(id)) return false;
    try {
      const record = recordSchema.parse(readPrivateJson(join(this.directory, `${id}.json`)));
      return record.id === id && record.expiresAt > now;
    } catch {
      return false;
    }
  }
  revoke(id: string): void {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid device ID");
    const path = join(this.directory, `${id}.json`);
    if (!lstatSync(path, { throwIfNoEntry: false })) return;
    recordSchema.parse(readPrivateJson(path));
    renameSync(path, join(this.directory, `${id}.revoked.json`));
  }
  list(): Array<{ id: string; label: string; expiresAt: number; active: boolean }> {
    return readdirSync(this.directory)
      .filter((name) => /^[a-f0-9]{32}(\.revoked)?\.json$/.test(name))
      .slice(0, 1024)
      .map((name) => {
        const { id, label, expiresAt } = recordSchema.parse(
          readPrivateJson(join(this.directory, name)),
        );
        return {
          id,
          label,
          expiresAt,
          active: !name.includes(".revoked.") && expiresAt > Date.now(),
        };
      });
  }
}
