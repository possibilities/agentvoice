import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serveConfigurator } from "./server.ts";
import { StudioTargets } from "./targets.ts";

const usage = `AgentVoice configurator — browser controls, native phone preview.

bun run android:configure [--device <adb-serial>]

--device SERIAL  Optional: preselect one running Studio device. Otherwise choose in the browser.
--port NUMBER    Host loopback port (default 4317; 0 selects an available port).
--save-to PATH   Host JSON copy for --device only (default profiles/SERIAL.json).

Open the printed address in your host browser. Stop with Ctrl+C.
Open AgentVoice Studio on a USB-debugging-authorized device, then Refresh devices.
Selection never launches an app or replaces another host. No voice call or audio is started.
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
  if (saveTo && !device)
    throw Error("--save-to requires --device so exports cannot cross devices.");
  if (device)
    saveTo ??= fileURLToPath(
      new URL(`../profiles/${encodeURIComponent(device)}.json`, import.meta.url),
    );
  return { help: false, device, port, saveTo };
}

if (import.meta.main) {
  let targets: StudioTargets | undefined;
  let web: Awaited<ReturnType<typeof serveConfigurator>> | undefined;
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    await web?.close();
    await targets
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
      targets = new StudioTargets({
        pinnedSerial: options.device || undefined,
        saveTo: options.saveTo,
      });
      web = await serveConfigurator(undefined, {
        port: options.port,
        device: "",
        saveTo: "",
        targets,
      });
      console.log(
        `\nAgentVoice Studio\n${web.url}\n\nOpen Studio on your device, then choose it in the browser. Ctrl+C releases the selected device.`,
      );
      await targets.refresh();
      if (stopping) {
        await web.close();
        await targets.close();
      } else if (options.device) {
        try {
          await targets.select(options.device, targets.snapshot().revision);
        } catch (error) {
          console.error(error instanceof Error ? error.message : "Choose a device in the browser.");
        }
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Could not open the configurator");
    await stop();
    process.exitCode = 1;
  }
}
