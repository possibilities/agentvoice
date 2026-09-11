import { resolve } from "node:path";
import { ControlSocket } from "../ipc/control-client.ts";
import {
  configureNetwork,
  DeviceCredentials,
  disableNetwork,
  loadNetworkSettings,
} from "./credentials.ts";
import {
  PAIRING_SOCKET_VERSION,
  PairedDevices,
  pairingPrepareResponseSchema,
  pairingSocketPath,
  pairingStatusSchema,
  parsePairingQrPayload,
} from "./pairing.ts";
import { createGrantQr, createQrMatrix, renderGrantQr, renderQr } from "./qr.ts";

export const NETWORK_USAGE = `agentvoice network configure --endpoint wss://host:port/v2/client --port <loopback-port>
agentvoice network grant --name <device-label> --out <private-profile.json>
agentvoice network qr --name <device-label>
agentvoice network pair
agentvoice network list
agentvoice network status
agentvoice network revoke <device-id>
agentvoice network disable

Network configuration activates on the next default server restart. The backend
binds only 127.0.0.1; use a dedicated tailnet-only TLS reverse proxy. Never Funnel.
Device grants are private reusable credentials valid for 30 days. Export files and
QR codes contain their secret; only the explicit network qr command prints one.
Native Pair phone enrollment instead creates a durable public-key device identity.
The explicit network pair command prints the same one-use five-minute enrollment QR.
Revocation disconnects active devices within 10 seconds. Existing calls are not resumed automatically.`;

export type ParsedNetworkCommand =
  | { action: "help" }
  | { action: "configure"; endpoint: string; port: number }
  | { action: "grant"; name: string; output: string }
  | { action: "qr"; name: string }
  | { action: "pair" | "list" | "status" | "disable" }
  | { action: "revoke"; id: string };

function parseOptions(rest: string[], allowed: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  if (rest.length !== allowed.length * 2) throw new Error(NETWORK_USAGE);
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!;
    const value = rest[i + 1];
    if (!allowed.includes(key) || values.has(key) || !value || value.startsWith("--"))
      throw new Error(NETWORK_USAGE);
    values.set(key, value);
  }
  return values;
}

export function parseNetworkCommand(args: string[]): ParsedNetworkCommand {
  const [action, ...rest] = args;
  if (action === undefined || (action === "--help" && rest.length === 0)) return { action: "help" };
  if (action === "configure") {
    const values = parseOptions(rest, ["--endpoint", "--port"]);
    return {
      action,
      endpoint: values.get("--endpoint")!,
      port: Number(values.get("--port")),
    };
  }
  if (action === "grant") {
    const values = parseOptions(rest, ["--name", "--out"]);
    return { action, name: values.get("--name")!, output: values.get("--out")! };
  }
  if (action === "qr") {
    const values = parseOptions(rest, ["--name"]);
    return { action, name: values.get("--name")! };
  }
  if (
    (action === "pair" || action === "list" || action === "status" || action === "disable") &&
    rest.length === 0
  )
    return { action };
  if (action === "revoke" && rest.length === 1) return { action, id: rest[0]! };
  throw new Error(NETWORK_USAGE);
}

export interface NetworkCommandOptions {
  write?: (output: string) => void;
  terminal?: { isTTY: boolean; columns?: number };
  connectPairing?: () => Promise<Pick<ControlSocket, "request" | "close">>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

async function pairPhone(
  stateDir: string,
  options: NetworkCommandOptions,
  write: (output: string) => void,
): Promise<void> {
  if (!loadNetworkSettings(stateDir)) throw new Error("Configure the network endpoint first");
  const connection = await (options.connectPairing?.() ??
    ControlSocket.connect(pairingSocketPath(stateDir), PAIRING_SOCKET_VERSION));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  for (const signal of signals) process.once(signal, stop);
  let pending: ReturnType<typeof pairingPrepareResponseSchema.parse> | undefined;
  let paired = false;
  try {
    pending = pairingPrepareResponseSchema.parse(await connection.request("prepare", {}));
    const qr = parsePairingQrPayload(pending.payload);
    if (!qr.enrollment.startsWith(`${pending.enrollmentId}.`) || qr.expiresAt !== pending.expiresAt)
      throw new Error("Pairing server returned an inconsistent code");
    const rendered = renderQr(
      createQrMatrix(pending.payload),
      options.terminal ?? {
        isTTY: process.stdout.isTTY === true,
        columns: process.stdout.columns,
      },
    );
    try {
      write(rendered);
    } catch {
      throw new Error("Unable to write phone pairing QR; no enrollment was activated");
    }
    const reference = { enrollmentId: pending.enrollmentId, receipt: pending.receipt };
    let status: ReturnType<typeof pairingStatusSchema.parse>;
    try {
      status = pairingStatusSchema.parse(await connection.request("activate", reference));
    } catch {
      try {
        status = pairingStatusSchema.parse(await connection.request("status", reference));
      } catch {
        throw new Error(
          "Unable to confirm phone pairing activation; cancellation was requested and the displayed code expires within five minutes",
        );
      }
    }
    if (status.status === "prepared")
      throw new Error("Phone pairing was not activated; the displayed code is invalid");
    if (status.status !== "paired") {
      try {
        write(
          `Waiting for your phone…\nThis code expires at ${new Date(pending.expiresAt).toISOString()}. The phone will stay paired until you revoke it.`,
        );
      } catch {
        throw new Error(
          "Pairing QR is active, but its status could not be written; cancellation was requested",
        );
      }
    }
    while (status.status !== "paired") {
      if (stopped) throw new Error("Phone pairing cancelled");
      if (now() >= pending.expiresAt)
        throw new Error("Phone pairing code expired; run agentvoice network pair again");
      await sleep(500);
      if (stopped) throw new Error("Phone pairing cancelled");
      status = pairingStatusSchema.parse(await connection.request("status", reference));
    }
    paired = true;
    const deviceId = status.deviceId;
    if (!deviceId) throw new Error("Pairing completed without a device ID");
    try {
      write(
        `Phone paired.\nDevice ID: ${deviceId}\nThis phone remains paired until revoked.\nRevoke with: agentvoice network revoke ${deviceId}`,
      );
    } catch {
      throw new Error(
        "Phone paired, but its receipt could not be written; run agentvoice network list for its device ID",
      );
    }
  } finally {
    for (const signal of signals) process.removeListener(signal, stop);
    if (pending && !paired) {
      await connection
        .request("cancel", { enrollmentId: pending.enrollmentId, receipt: pending.receipt })
        .catch(() => {});
    }
    connection.close();
  }
}

export function networkCommand(
  args: string[],
  stateDir: string,
  options: NetworkCommandOptions = {},
): void | Promise<void> {
  const command = parseNetworkCommand(args);
  const write = options.write ?? console.log;
  if (command.action === "help") {
    write(NETWORK_USAGE);
    return;
  }
  if (command.action === "configure") {
    configureNetwork(stateDir, {
      version: 1,
      endpoint: command.endpoint,
      port: command.port,
    });
    write("Network configured. Restart the default server after configuring its TLS proxy.");
  } else if (command.action === "disable") {
    disableNetwork(stateDir);
    write(
      "Network disabled for the next server restart; settings retained. Restart now to disconnect all devices. Remove the dedicated TLS proxy separately.",
    );
  } else if (command.action === "grant") {
    const settings = loadNetworkSettings(stateDir);
    if (!settings) throw new Error("Configure the network endpoint first");
    const id = new DeviceCredentials(stateDir).grant(
      command.name,
      settings.endpoint,
      resolve(command.output),
    );
    write(
      `Device ${id} granted for 30 days. Transfer the private profile securely; its token was not printed.`,
    );
  } else if (command.action === "qr") {
    const settings = loadNetworkSettings(stateDir);
    if (!settings) throw new Error("Configure the network endpoint first");
    const credentials = new DeviceCredentials(stateDir);
    const pending = credentials.prepareGrant(command.name, settings.endpoint);
    const qr = createGrantQr(pending.profile);
    const rendered = renderGrantQr(
      qr.matrix,
      options.terminal ?? {
        isTTY: process.stdout.isTTY === true,
        columns: process.stdout.columns,
      },
    );
    try {
      write(rendered);
    } catch {
      throw new Error("Unable to write private credential QR; no device grant was activated");
    }
    try {
      credentials.activateGrant(pending);
    } catch {
      throw new Error(
        "Unable to activate displayed private credential QR; displayed code is invalid",
      );
    }
    const receipt = `Device ID: ${pending.id}\nExpires: ${new Date(
      pending.expiresAt,
    ).toISOString()}\nPrivate reusable device credential, valid for 30 days. Store it securely.\nRevoke with: agentvoice network revoke ${pending.id}`;
    try {
      write(receipt);
    } catch {
      throw new Error(
        "Private credential QR is active, but its receipt could not be written; run agentvoice network list for its device ID and expiry",
      );
    }
  } else if (command.action === "pair") {
    return pairPhone(stateDir, options, write);
  } else if (command.action === "status") {
    write(JSON.stringify(loadNetworkSettings(stateDir) ?? null));
  } else if (command.action === "list") {
    const legacy = new DeviceCredentials(stateDir).list().map((record) => ({
      kind: "legacy-grant" as const,
      ...record,
    }));
    write(JSON.stringify([...legacy, ...new PairedDevices(stateDir).list()], null, 2));
  } else if (command.action === "revoke") {
    const credentials = new DeviceCredentials(stateDir);
    const paired = new PairedDevices(stateDir);
    if (!paired.revoke(command.id)) credentials.revoke(command.id);
    write("Device revoked; live connections close within 10 seconds. Its record is retained.");
  }
}
