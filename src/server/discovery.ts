/** Bonjour publication and Tailscale route capture; advertisements contain no secret. */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { isIP } from "node:net";
import { hostname } from "node:os";
import { containsAsciiControl, containsAsciiControlOrSpace } from "../core/safe-text.ts";

export interface BonjourRegistration {
  name: string;
  port: number;
  serverId: string;
  pairing: boolean;
  tailscaleDnsName?: string;
}

export function bonjourRegistrationArguments(registration: BonjourRegistration): string[] {
  const baseName = boundedServiceName(registration.name);
  const name = registration.pairing ? pairingServiceName(baseName) : baseName;
  if (
    !Number.isSafeInteger(registration.port) ||
    registration.port < 1 ||
    registration.port > 65535
  ) {
    throw new Error("Bonjour port is invalid");
  }
  if (!isSafeTxtValue(registration.serverId, 128)) throw new Error("Bonjour Server id is invalid");
  const records = [
    "v=1",
    `id=${registration.serverId}`,
    "tls=1",
    `pairing=${registration.pairing ? "1" : "0"}`,
  ];
  if (registration.tailscaleDnsName && isDnsName(registration.tailscaleDnsName)) {
    records.push(`tail=${registration.tailscaleDnsName.replace(/\.$/, "")}`);
  }
  return ["-R", name, "_agentvoice._tcp", "local", String(registration.port), ...records];
}

function pairingServiceName(baseName: string): string {
  const candidate = `${baseName} Pairing`;
  return Buffer.byteLength(candidate, "utf8") <= 63 ? candidate : "AgentVoice Pairing";
}

export function parseTailscaleStatus(source: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return [];
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const self = (value as Record<string, unknown>)["Self"];
  if (typeof self !== "object" || self === null || Array.isArray(self)) return [];
  const record = self as Record<string, unknown>;
  const endpoints: string[] = [];
  if (typeof record["DNSName"] === "string" && isDnsName(record["DNSName"])) {
    endpoints.push(record["DNSName"].replace(/\.$/, ""));
  }
  if (Array.isArray(record["TailscaleIPs"])) {
    for (const candidate of record["TailscaleIPs"]) {
      if (typeof candidate !== "string" || isIP(candidate) === 0 || endpoints.includes(candidate))
        continue;
      endpoints.push(candidate);
      if (endpoints.length === 9) break;
    }
  }
  return endpoints;
}

export function discoverTailscaleEndpoints(): string[] {
  const result = spawnSync("tailscale", ["status", "--json"], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 256 * 1024,
  });
  if (result.error || result.status !== 0) return [];
  return parseTailscaleStatus(result.stdout);
}

export function defaultBonjourName(): string {
  const machine = hostname().split(".")[0]?.trim() ?? "";
  return boundedServiceName(machine ? `AgentVoice ${machine}` : "AgentVoice");
}

export class BonjourAdvertiser {
  private child: ChildProcess | null = null;
  private pairing: boolean | null = null;

  constructor(private readonly registration: Omit<BonjourRegistration, "pairing">) {}

  update(pairing: boolean): void {
    if (this.pairing === pairing && this.child) return;
    this.stopChild();
    this.pairing = pairing;
    const child = spawn(
      "/usr/bin/dns-sd",
      bonjourRegistrationArguments({ ...this.registration, pairing }),
      {
        stdio: "ignore",
      },
    );
    this.child = child;
    child.once("error", () => {
      if (this.child === child) this.child = null;
    });
    child.once("exit", () => {
      if (this.child === child) this.child = null;
    });
    child.unref();
  }

  close(): void {
    this.pairing = null;
    this.stopChild();
  }

  private stopChild(): void {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}

function boundedServiceName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || Buffer.byteLength(name, "utf8") > 63 || containsAsciiControl(name)) {
    throw new Error("Bonjour service name is invalid");
  }
  return name;
}

function isSafeTxtValue(value: string, maximum: number): boolean {
  return (
    value.length > 0 &&
    value.length <= maximum &&
    !containsAsciiControlOrSpace(value) &&
    !value.includes("=")
  );
}

function isDnsName(value: string): boolean {
  const name = value.replace(/\.$/, "");
  if (name.length === 0 || name.length > 253 || !name.includes(".")) return false;
  return name
    .split(".")
    .every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}
