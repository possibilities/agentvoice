import { resolve } from "node:path";
import {
  configureNetwork,
  DeviceCredentials,
  disableNetwork,
  loadNetworkSettings,
} from "./credentials.ts";

export const NETWORK_USAGE = `agentvoice network configure --endpoint wss://host:port/v2/client --port <loopback-port>
agentvoice network grant --name <device-label> --out <private-profile.json>
agentvoice network list
agentvoice network status
agentvoice network revoke <device-id>
agentvoice network disable

Network configuration activates on the next default server restart. The backend
binds only 127.0.0.1; use a dedicated tailnet-only TLS reverse proxy. Never Funnel.
Device grants expire after 30 days. Export files contain secrets; never print or commit them.
Revocation disconnects active devices within 10 seconds. Existing calls are not resumed automatically.`;

export function networkCommand(args: string[], stateDir: string): void {
  const [action, ...rest] = args;
  if (action === "--help" || action === undefined) {
    console.log(NETWORK_USAGE);
    return;
  }
  const values = new Map<string, string>();
  if (action === "configure" || action === "grant") {
    const allowed = action === "configure" ? ["--endpoint", "--port"] : ["--name", "--out"];
    for (let i = 0; i < rest.length; i += 2) {
      const key = rest[i]!;
      const value = rest[i + 1];
      if (!allowed.includes(key) || values.has(key) || !value || value.startsWith("--"))
        throw new Error(NETWORK_USAGE);
      values.set(key, value);
    }
    if (values.size !== 2) throw new Error(NETWORK_USAGE);
  }
  if (action === "configure") {
    configureNetwork(stateDir, {
      version: 1,
      endpoint: values.get("--endpoint")!,
      port: Number(values.get("--port")),
    });
    console.log("Network configured. Restart the default server after configuring its TLS proxy.");
  } else if (action === "disable" && rest.length === 0) {
    disableNetwork(stateDir);
    console.log(
      "Network disabled for the next server restart; settings retained. Restart now to disconnect all devices. Remove the dedicated TLS proxy separately.",
    );
  } else if (action === "grant") {
    const settings = loadNetworkSettings(stateDir);
    if (!settings) throw new Error("Configure the network endpoint first");
    const id = new DeviceCredentials(stateDir).grant(
      values.get("--name")!,
      settings.endpoint,
      resolve(values.get("--out")!),
    );
    console.log(
      `Device ${id} granted for 30 days. Transfer the private profile securely; its token was not printed.`,
    );
  } else if (action === "status" && rest.length === 0) {
    console.log(JSON.stringify(loadNetworkSettings(stateDir) ?? null));
  } else if (action === "list" && rest.length === 0) {
    console.log(JSON.stringify(new DeviceCredentials(stateDir).list(), null, 2));
  } else if (action === "revoke" && rest.length === 1) {
    new DeviceCredentials(stateDir).revoke(rest[0]!);
    console.log(
      "Device revoked; live connections close within 10 seconds. Its record is retained.",
    );
  } else throw new Error(NETWORK_USAGE);
}
