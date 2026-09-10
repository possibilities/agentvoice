import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export type Adb = (args: string[], signal?: AbortSignal) => Promise<string>;
export type StudioDevice = { serial: string; label: string };
export const studioPackage = "com.arthack.agentvoice.studio";
export const studioActivity = `${studioPackage}/com.arthack.agentvoice.PersonaPreviewActivity`;

export const runAdb: Adb = async (args, signal) => {
  try {
    return (
      await execute("adb", args, { timeout: 8000, maxBuffer: 2 * 1024 * 1024, signal })
    ).stdout.trim();
  } catch {
    // Never include binding contents, private socket names or subprocess output.
    throw Error(
      "ADB is unavailable or the device stopped responding. Check USB debugging and refresh.",
    );
  }
};

export function parseAdbDevices(output: string): StudioDevice[] {
  if (output.length > 65536) throw Error("ADB returned too many devices.");
  const devices = new Map<string, StudioDevice>();
  for (const line of output.split("\n")) {
    const [serial, state, ...details] = line.trim().split(/\s+/);
    if (state !== "device" || !serial || !/^[a-zA-Z0-9._:[\]-]{1,200}$/.test(serial)) continue;
    const model = details
      .find((item) => item.startsWith("model:"))
      ?.slice(6)
      .replaceAll("_", " ");
    devices.set(serial, { serial, label: model || serial });
  }
  if (devices.size > 32)
    throw Error("Too many ADB devices. Disconnect unused targets before refreshing.");
  return [...devices.values()];
}

export function studioIsForeground(output: string): boolean {
  return /^\s*mCurrentFocus=Window\{[^\n]* com\.arthack\.agentvoice\.studio\/com\.arthack\.agentvoice\.PersonaPreviewActivity\}/m.test(
    output,
  );
}

export async function discoverStudioDevices(adb: Adb = runAdb): Promise<StudioDevice[]> {
  const signal = AbortSignal.timeout(15000);
  const available = parseAdbDevices(await adb(["devices", "-l"], signal));
  const running: StudioDevice[] = [];
  // Keep discovery bounded and light on the host and attached devices.
  for (const device of available) {
    signal.throwIfAborted();
    try {
      if (
        studioIsForeground(await adb(["-s", device.serial, "shell", "dumpsys", "window"], signal))
      )
        running.push(device);
    } catch {
      signal.throwIfAborted();
    }
  }
  return running;
}

export async function requireRunningStudio(
  serial: string,
  adb: Adb = runAdb,
  signal?: AbortSignal,
) {
  if (
    !parseAdbDevices(await adb(["devices", "-l"], signal)).some(
      (device) => device.serial === serial,
    ) ||
    !studioIsForeground(await adb(["-s", serial, "shell", "dumpsys", "window"], signal))
  ) {
    throw Error(
      "Open AgentVoice Studio on the selected unlocked device, then refresh the device list.",
    );
  }
}

export function parseStudioBinding(text: string): { name: string; token: string } {
  try {
    if (Buffer.byteLength(text) > 1024) throw Error();
    const value = JSON.parse(text);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "socket,token" ||
      typeof value.socket !== "string" ||
      !/^agentvoice-halo-[a-f0-9]{32}$/.test(value.socket) ||
      typeof value.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.token)
    )
      throw Error();
    return { name: value.socket, token: value.token };
  } catch {
    throw Error(
      "Studio's private browser binding is unavailable. Install the current Studio build and reopen it.",
    );
  }
}
