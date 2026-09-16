import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { discoverServer } from "../frontend/discovery.ts";
import { ControlSocket } from "../ipc/control-client.ts";
import { expandTilde } from "../paths.ts";
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

export const NETWORK_USAGE = `agentvoice network configure --endpoint wss://host:port/v2/client --port <loopback-port> [--workspace <dir>]
agentvoice network grant --name <device-label> --out <private-profile.json> [--workspace <dir>]
agentvoice network qr --name <device-label> [--workspace <dir>]
agentvoice network pair [--workspace <dir>]
agentvoice network list [--workspace <dir>]
agentvoice network status [--workspace <dir>]
agentvoice network revoke <device-id> [--workspace <dir>]
agentvoice network disable [--workspace <dir>]

Network configuration activates on the next targeted server restart. The backend
binds only 127.0.0.1; use a dedicated tailnet-only TLS reverse proxy. Never Funnel.
Device grants are private reusable credentials valid for 30 days. Export files and
QR codes contain their secret; only the explicit network qr command prints one.
Native Pair phone enrollment instead creates a durable public-key device identity.
The explicit network pair command prints the same one-use five-minute enrollment QR.
--workspace selects isolated settings and device records for that canonical
workspace. Pair also requires that exact server to be running and never falls
back to the default server.
Revocation disconnects active devices within 10 seconds. Existing calls are not resumed automatically.`;

export type ParsedNetworkCommand =
  | { action: "help" }
  | { action: "configure"; endpoint: string; port: number; workspace?: string }
  | { action: "grant"; name: string; output: string; workspace?: string }
  | { action: "qr"; name: string; workspace?: string }
  | { action: "pair"; workspace?: string }
  | { action: "list" | "status" | "disable"; workspace?: string }
  | { action: "revoke"; id: string; workspace?: string };

function parseOptions(
  rest: string[],
  required: readonly string[],
  optional: readonly string[] = [],
): Map<string, string> {
  const values = new Map<string, string>();
  if (rest.length % 2 !== 0) throw new Error(NETWORK_USAGE);
  const allowed = [...required, ...optional];
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!;
    const value = rest[i + 1];
    if (!allowed.includes(key) || values.has(key) || !value || value.startsWith("--"))
      throw new Error(NETWORK_USAGE);
    values.set(key, value);
  }
  if (required.some((key) => !values.has(key))) throw new Error(NETWORK_USAGE);
  return values;
}

export function parseNetworkCommand(args: string[]): ParsedNetworkCommand {
  const [action, ...rest] = args;
  if (action === undefined || (action === "--help" && rest.length === 0)) return { action: "help" };
  if (action === "configure") {
    const values = parseOptions(rest, ["--endpoint", "--port"], ["--workspace"]);
    return {
      action,
      endpoint: values.get("--endpoint")!,
      port: Number(values.get("--port")),
      ...(values.has("--workspace") ? { workspace: values.get("--workspace")! } : {}),
    };
  }
  if (action === "grant") {
    const values = parseOptions(rest, ["--name", "--out"], ["--workspace"]);
    return {
      action,
      name: values.get("--name")!,
      output: values.get("--out")!,
      ...(values.has("--workspace") ? { workspace: values.get("--workspace")! } : {}),
    };
  }
  if (action === "qr") {
    const values = parseOptions(rest, ["--name"], ["--workspace"]);
    return {
      action,
      name: values.get("--name")!,
      ...(values.has("--workspace") ? { workspace: values.get("--workspace")! } : {}),
    };
  }
  if (action === "pair") {
    if (rest.length === 0) return { action };
    const values = parseOptions(rest, ["--workspace"]);
    return { action, workspace: values.get("--workspace")! };
  }
  if (action === "list" || action === "status" || action === "disable") {
    if (rest.length === 0) return { action };
    const values = parseOptions(rest, [], ["--workspace"]);
    return { action, workspace: values.get("--workspace")! };
  }
  if (action === "revoke" && rest.length >= 1) {
    const [id, ...options] = rest;
    if (!id || id.startsWith("--")) throw new Error(NETWORK_USAGE);
    const values = parseOptions(options, [], ["--workspace"]);
    return {
      action,
      id,
      ...(values.has("--workspace") ? { workspace: values.get("--workspace")! } : {}),
    };
  }
  throw new Error(NETWORK_USAGE);
}

export interface NetworkCommandOptions {
  write?: (output: string) => void;
  terminal?: { isTTY: boolean; columns?: number };
  connectPairing?: (path: string) => Promise<Pick<ControlSocket, "request" | "close">>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  launchCwd?: string;
  home?: string;
  discoverServer?: typeof discoverServer;
}

function canonicalWorkspace(path: string, launchCwd: string, home: string): string {
  const selected = resolve(launchCwd, expandTilde(path, home));
  try {
    if (!statSync(selected).isDirectory()) throw new Error("not a directory");
    return realpathSync(selected);
  } catch (error) {
    throw new Error(`Cannot use workspace ${selected}: ${String(error)}`);
  }
}

function workspaceOption(workspace: string | undefined): string {
  return workspace ? ` --workspace '${workspace.replaceAll("'", "'\\''")}'` : "";
}

async function targetedPairingWorkspace(
  stateDir: string,
  workspace: string,
  discover: typeof discoverServer,
): Promise<string | undefined> {
  const [defaultServer, workspaceServer] = await Promise.all([
    discover(stateDir),
    discover(stateDir, workspace),
  ]);
  const defaultMatches = defaultServer?.workspace === workspace;
  const workspaceMatches = workspaceServer?.workspace === workspace;
  if (defaultMatches && workspaceMatches)
    throw new Error(`Multiple running AgentVoice servers report workspace ${workspace}`);
  if (defaultMatches) return undefined;
  if (workspaceMatches) return workspace;
  throw new Error(`No running AgentVoice server found for workspace ${workspace}`);
}

async function pairPhone(
  stateDir: string,
  requestedWorkspace: string | undefined,
  options: NetworkCommandOptions,
  write: (output: string) => void,
): Promise<void> {
  const canonicalRequestedWorkspace =
    requestedWorkspace === undefined
      ? undefined
      : canonicalWorkspace(
          requestedWorkspace,
          options.launchCwd ?? process.cwd(),
          options.home ?? homedir(),
        );
  const pairingWorkspace =
    canonicalRequestedWorkspace === undefined
      ? undefined
      : await targetedPairingWorkspace(
          stateDir,
          canonicalRequestedWorkspace,
          options.discoverServer ?? discoverServer,
        );
  if (!loadNetworkSettings(stateDir, pairingWorkspace))
    throw new Error("Configure the network endpoint for this server first");
  const socketPath = pairingSocketPath(stateDir, pairingWorkspace);
  let connection: Pick<ControlSocket, "request" | "close">;
  try {
    connection = await (options.connectPairing?.(socketPath) ??
      ControlSocket.connect(socketPath, PAIRING_SOCKET_VERSION));
  } catch {
    throw new Error(
      "Targeted AgentVoice server pairing is unavailable; restart that server with the current source after configuring its network endpoint",
    );
  }
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
    const targetOption = workspaceOption(pairingWorkspace);
    try {
      write(
        `Phone paired.\nDevice ID: ${deviceId}\nThis phone remains paired until revoked.\nRevoke with: agentvoice network revoke ${deviceId}${targetOption}`,
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
  const selectedWorkspace =
    "workspace" in command && command.workspace !== undefined
      ? canonicalWorkspace(
          command.workspace,
          options.launchCwd ?? process.cwd(),
          options.home ?? homedir(),
        )
      : undefined;
  if (command.action === "configure") {
    configureNetwork(
      stateDir,
      {
        version: 1,
        endpoint: command.endpoint,
        port: command.port,
      },
      selectedWorkspace,
    );
    write("Network configured. Restart the targeted server after configuring its TLS proxy.");
  } else if (command.action === "disable") {
    disableNetwork(stateDir, selectedWorkspace);
    write(
      "Network disabled for the next server restart; settings retained. Restart now to disconnect all devices. Remove the dedicated TLS proxy separately.",
    );
  } else if (command.action === "grant") {
    const settings = loadNetworkSettings(stateDir, selectedWorkspace);
    if (!settings) throw new Error("Configure the network endpoint first");
    const id = new DeviceCredentials(stateDir, selectedWorkspace).grant(
      command.name,
      settings.endpoint,
      resolve(command.output),
    );
    write(
      `Device ${id} granted for 30 days. Transfer the private profile securely; its token was not printed.`,
    );
  } else if (command.action === "qr") {
    const settings = loadNetworkSettings(stateDir, selectedWorkspace);
    if (!settings) throw new Error("Configure the network endpoint first");
    const credentials = new DeviceCredentials(stateDir, selectedWorkspace);
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
    const targetOption = workspaceOption(selectedWorkspace);
    const receipt = `Device ID: ${pending.id}\nExpires: ${new Date(
      pending.expiresAt,
    ).toISOString()}\nPrivate reusable device credential, valid for 30 days. Store it securely.\nRevoke with: agentvoice network revoke ${pending.id}${targetOption}`;
    try {
      write(receipt);
    } catch {
      throw new Error(
        `Private credential QR is active, but its receipt could not be written; run agentvoice network list${targetOption} for its device ID and expiry`,
      );
    }
  } else if (command.action === "pair") {
    return pairPhone(stateDir, command.workspace, options, write);
  } else if (command.action === "status") {
    write(JSON.stringify(loadNetworkSettings(stateDir, selectedWorkspace) ?? null));
  } else if (command.action === "list") {
    const legacy = new DeviceCredentials(stateDir, selectedWorkspace).list().map((record) => ({
      kind: "legacy-grant" as const,
      ...record,
    }));
    write(
      JSON.stringify(
        [...legacy, ...new PairedDevices(stateDir, selectedWorkspace).list()],
        null,
        2,
      ),
    );
  } else if (command.action === "revoke") {
    const credentials = new DeviceCredentials(stateDir, selectedWorkspace);
    const paired = new PairedDevices(stateDir, selectedWorkspace);
    if (!paired.revoke(command.id)) credentials.revoke(command.id);
    write("Device revoked; live connections close within 10 seconds. Its record is retained.");
  }
}
