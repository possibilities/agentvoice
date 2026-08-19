/** Persistent per-device public-key trust with atomic, owner-only updates. */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { deviceIdFromPublicKey, validateDevicePublicKey } from "../core/pairing.ts";
import { containsAsciiControl } from "../core/safe-text.ts";

const MAX_DEVICES = 64;
const MAX_FILE_BYTES = 256 * 1024;

export interface PairedDevice {
  id: string;
  name: string;
  publicKey: string;
  pairedAt: string;
}

interface PairedDeviceDocument {
  version: 1;
  devices: PairedDevice[];
}

export class PairedDeviceStore {
  private readonly devices = new Map<string, PairedDevice>();

  private constructor(
    private readonly path: string,
    devices: PairedDevice[],
  ) {
    for (const device of devices) this.devices.set(device.id, device);
  }

  static open(path: string): PairedDeviceStore {
    if (!existsSync(path)) return new PairedDeviceStore(path, []);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error(`paired device store is not a private regular file: ${path}`);
    }
    if (stat.size > MAX_FILE_BYTES) throw new Error("paired device store exceeds its size bound");
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(
        `could not read paired device store: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return new PairedDeviceStore(path, validateDocument(value));
  }

  get(id: string): PairedDevice | undefined {
    const device = this.devices.get(id);
    return device ? { ...device } : undefined;
  }

  list(): PairedDevice[] {
    return [...this.devices.values()].map((device) => ({ ...device }));
  }

  pair(device: PairedDevice): void {
    const validated = validateDevice(device);
    if (!this.devices.has(validated.id) && this.devices.size >= MAX_DEVICES) {
      throw new Error(`at most ${MAX_DEVICES} devices may be paired`);
    }
    this.devices.set(validated.id, validated);
    this.persist();
  }

  revoke(id: string): boolean {
    if (!this.devices.delete(id)) return false;
    this.persist();
    return true;
  }

  private persist(): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${process.pid}-${crypto.randomUUID()}`;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(
        descriptor,
        `${JSON.stringify({ version: 1, devices: this.list() } satisfies PairedDeviceDocument, null, 2)}\n`,
        "utf8",
      );
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(temporary, this.path);
      chmodSync(this.path, 0o600);
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      try {
        unlinkSync(temporary);
      } catch {
        // Renamed or never created.
      }
    }
  }
}

function validateDocument(value: unknown): PairedDevice[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("paired device store must be an object");
  }
  const document = value as Record<string, unknown>;
  if (document["version"] !== 1 || !Array.isArray(document["devices"])) {
    throw new Error("paired device store has an unsupported format");
  }
  if (document["devices"].length > MAX_DEVICES)
    throw new Error("paired device store has too many devices");
  const seen = new Set<string>();
  return document["devices"].map((entry) => {
    const device = validateDevice(entry);
    if (seen.has(device.id)) throw new Error("paired device store contains a duplicate device");
    seen.add(device.id);
    return device;
  });
}

function validateDevice(value: unknown): PairedDevice {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("paired device entry must be an object");
  }
  const device = value as Record<string, unknown>;
  if (
    typeof device["id"] !== "string" ||
    typeof device["name"] !== "string" ||
    typeof device["publicKey"] !== "string" ||
    typeof device["pairedAt"] !== "string"
  ) {
    throw new Error("paired device entry is incomplete");
  }
  const name = device["name"].trim();
  if (name.length === 0 || name.length > 96 || containsAsciiControl(name)) {
    throw new Error("paired device name is invalid");
  }
  validateDevicePublicKey(device["publicKey"]);
  if (deviceIdFromPublicKey(device["publicKey"]) !== device["id"]) {
    throw new Error("paired device id does not match its public-key fingerprint");
  }
  if (!Number.isFinite(Date.parse(device["pairedAt"])))
    throw new Error("paired device timestamp is invalid");
  return { id: device["id"], name, publicKey: device["publicKey"], pairedAt: device["pairedAt"] };
}
