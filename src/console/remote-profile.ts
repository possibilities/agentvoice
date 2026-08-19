/** The Android Remote console's pinned Server identity and remembered routes. */
import { randomUUID } from "node:crypto";
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
import { serverIdFromCertificate } from "../core/pairing.ts";
import { containsAsciiControlOrSpace } from "../core/safe-text.ts";

const MAX_PROFILE_BYTES = 128 * 1024;

export interface RemoteProfile {
  version: 1;
  serverId: string;
  serverName: string;
  certificate: string;
  deviceId: string;
  endpoints: string[];
  port: number;
}

export function loadRemoteProfile(path: string): RemoteProfile | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Remote profile is not a private regular file: ${path}`);
  }
  if (stat.size < 1 || stat.size > MAX_PROFILE_BYTES)
    throw new Error("Remote profile exceeds its size bound");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `could not read Remote profile: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateRemoteProfile(value);
}

export function saveRemoteProfile(path: string, profile: RemoteProfile): void {
  const validated = validateRemoteProfile(profile);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // Renamed or never created.
    }
  }
}

export function validateRemoteProfile(value: unknown): RemoteProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Remote profile must be an object");
  }
  const profile = value as Record<string, unknown>;
  if (
    profile["version"] !== 1 ||
    typeof profile["serverId"] !== "string" ||
    typeof profile["serverName"] !== "string" ||
    typeof profile["certificate"] !== "string" ||
    typeof profile["deviceId"] !== "string" ||
    !Array.isArray(profile["endpoints"]) ||
    !Number.isSafeInteger(profile["port"])
  ) {
    throw new Error("Remote profile is incomplete");
  }
  if (serverIdFromCertificate(profile["certificate"]) !== profile["serverId"]) {
    throw new Error("Remote profile certificate fingerprint does not match its Server id");
  }
  if (!isEndpoint(profile["serverName"]) || profile["serverName"].includes(":")) {
    throw new Error("Remote profile Server name is invalid");
  }
  if (!isIdentifier(profile["deviceId"])) throw new Error("Remote profile device id is invalid");
  if (profile["endpoints"].length > 16 || !profile["endpoints"].every(isEndpoint)) {
    throw new Error("Remote profile endpoints are invalid");
  }
  const port = profile["port"] as number;
  if (port < 1 || port > 65535) throw new Error("Remote profile port is invalid");
  return {
    version: 1,
    serverId: profile["serverId"],
    serverName: profile["serverName"],
    certificate: profile["certificate"],
    deviceId: profile["deviceId"],
    endpoints: [...new Set(profile["endpoints"] as string[])],
    port,
  };
}

function isIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !containsAsciiControlOrSpace(value);
}

function isEndpoint(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 253 &&
    !containsAsciiControlOrSpace(value) &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}
