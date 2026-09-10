import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectPhone } from "./device.ts";
import { serveConfigurator } from "./server.ts";

const usage = `AgentVoice configurator — browser controls, native phone preview.

bun run android:configure --device <adb-serial>

--device SERIAL  Required: the authorized ADB phone with the current debug APK.
--port NUMBER    Host loopback port (default 4317; 0 selects an available port).
--save-to PATH   Host JSON copy (default android/configurator/profiles/SERIAL.json).

Open the printed address in your host browser. Stop with Ctrl+C.
This opens a synthetic Halo preview; it starts no voice call or audio.
`;

export function parseArgs(args: string[]) {
  let device = "";
  let port = 4317;
  let saveTo: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") return { help: true, device, port, saveTo: "" };
    if (!["--device", "--port", "--save-to"].includes(arg) || seen.has(arg))
      throw Error(`Unknown or repeated option: ${arg}`);
    seen.add(arg);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw Error(`Missing value for ${arg}`);
    if (arg === "--device") device = value;
    if (arg === "--port") {
      if (!/^\d+$/.test(value) || Number(value) > 65535) throw Error("Port must be 0–65535");
      port = Number(value);
    }
    if (arg === "--save-to") saveTo = resolve(value);
  }
  if (!device) throw Error("Choose the phone explicitly with --device <adb-serial>.");
  saveTo ??= fileURLToPath(
    new URL(`../profiles/${encodeURIComponent(device)}.json`, import.meta.url),
  );
  return { help: false, device, port, saveTo };
}

if (import.meta.main) {
  let connection: Awaited<ReturnType<typeof connectPhone>> | undefined;
  let web: Awaited<ReturnType<typeof serveConfigurator>> | undefined;
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    await web?.server.stop(true);
    await connection
      ?.close()
      .catch(() => console.error("Could not remove the preview's ADB forward."));
  }
  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(usage);
    else {
      console.log("Opening the native Halo preview…");
      connection = await connectPhone(options.device);
      if (stopping) {
        await connection.close();
      } else {
        web = await serveConfigurator(connection.phone, { ...options, device: connection.label });
        if (stopping) {
          await web.server.stop(true);
          await connection.close();
        } else
          console.log(
            `\nAgentVoice configurator\n${web.url}\n\nSave destination: ${options.saveTo}\nCtrl+C closes this preview connection.`,
          );
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Could not open the configurator");
    await stop();
    process.exitCode = 1;
  }
}
